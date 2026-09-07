import { BridgeError } from '@browser-mcp/shared';

const PROTOCOL = '1.3';

/**
 * CDP 会话管理。附加调试器会让该标签页常驻「正在被调试」横幅，这是拿 Chrome 真实无障碍树
 * 的必要代价（`chrome.automation` 只在 ChromeOS 可用，自己在页面里近似算 role/name 覆盖不全）。
 *
 * 附加后**不主动断开**，只在标签页关闭时清理：频繁 attach/detach 会让横幅不停闪，
 * 而横幅本身用户已经接受了。
 */
const attachedTabs = new Set<number>();

export async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
    attachedTabs.add(tabId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Chrome 的原话是 "Another debugger is already attached to the tab with id: N"。
    // 大小写和措辞都别写死 —— 之前按 'Already attached' 精确匹配，结果永远匹配不上，
    // 第二次调用就误报成「DevTools 开着」。
    if (/already attached/i.test(message)) {
      attachedTabs.add(tabId);
      return;
    }
    throw new BridgeError('ERR_DEBUGGER_UNAVAILABLE', `无法附加调试器：${message}`);
  }
}

export async function detach(tabId: number): Promise<void> {
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // 标签页已关、或本来就没附加，都无所谓
  }
}

export async function send<T>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  await ensureAttached(tabId);
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new BridgeError('ERR_SCRIPT_FAILED', `CDP ${method} 失败：${message}`);
  }
}

/**
 * 通过 backendNodeId 拿到页面里的真实元素并在其上执行一段函数。
 *
 * 这是 ref 能够比 CSS 选择器可靠的原因：ref 直接指向 DOM 节点本身，
 * 不受 class 名变化、同名元素、动态重排的影响。
 */
export async function callOnNode<T>(
  tabId: number,
  backendNodeId: number,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<T> {
  const resolved = await send<{ object?: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
    backendNodeId,
  });
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new BridgeError(
      'ERR_STALE_REF',
      '这个 ref 指向的元素已经不在页面上了（页面多半重新渲染过），请重新 page.snapshot',
    );
  }

  const result = await send<{
    result?: { value?: T };
    exceptionDetails?: { text?: string };
  }>(tabId, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new BridgeError(
      'ERR_SCRIPT_FAILED',
      `在元素上执行失败：${result.exceptionDetails.text ?? '未知错误'}`,
    );
  }
  return result.result?.value as T;
}

const DESCRIBE_FN = `function () {
  return {
    tag: this.tagName ? this.tagName.toLowerCase() : '?',
    text: (this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
  };
}`;

/**
 * 判断待点坐标上最顶层的元素是否与目标相关。
 * `hit.contains(this)` 这一支不能少 —— 无障碍树给的常常是外层包裹节点，
 * 坐标命中的却是它内部的文字节点，这属于正常情况而非被遮挡。
 */
const HIT_TEST_FN = `function (x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return { ok: false, reason: '该坐标上没有元素，可能仍在视口之外' };
  if (this === hit || this.contains(hit) || hit.contains(this)) return { ok: true, reason: '' };
  const cls = hit.className ? '.' + String(hit.className).split(' ')[0] : '';
  return { ok: false, reason: '<' + hit.tagName.toLowerCase() + cls + '> 盖在目标上方' };
}`;

/**
 * 在元素中心派发**真实鼠标事件**来点击，而不是调 `element.click()`。
 *
 * 这不是过度设计，是被实测坑过：Chrome 的无障碍树会把整张卡片折叠成一个 button 节点，
 * 但它关联的 DOM 节点可能是**外层包裹 div**，而点击处理器挂在其**子元素**上。
 * `element.click()` 的事件 target 就是那个包裹 div，只会向上冒泡，永远到不了子元素，
 * 于是"点了但什么都没发生"。组件库（antd / element / MUI）里这种结构极其常见。
 *
 * 坐标点击命中的是该位置最顶层的元素（通常是卡片内部的文字），事件自然向上冒泡穿过
 * 真正带处理器的那一层，和真人点击完全一致。附带好处是能发现遮挡层。
 */
export async function clickElement(
  tabId: number,
  backendNodeId: number,
): Promise<{ tag: string; text: string }> {
  // 先取描述：点完页面可能已经跳走，那时再问就晚了
  const info = await callOnNode<{ tag: string; text: string }>(tabId, backendNodeId, DESCRIBE_FN);

  try {
    await send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  } catch {
    // 少数节点（如 display:contents）不支持，交给下面的可见性检查兜底
  }

  const { quads } = await send<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', {
    backendNodeId,
  });
  const quad = quads?.[0];
  if (!quad || quad.length < 8) {
    throw new BridgeError(
      'ERR_ELEMENT_NOT_FOUND',
      `<${info.tag}> 没有可点击区域（尺寸为 0 或被隐藏），无法点击`,
    );
  }

  // quad 是 [x1,y1,x2,y2,x3,y3,x4,y4]，取四角均值即中心
  const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
  const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;

  const hit = await callOnNode<{ ok: boolean; reason: string }>(tabId, backendNodeId, HIT_TEST_FN, [
    x,
    y,
  ]);
  if (!hit.ok) {
    throw new BridgeError('ERR_ELEMENT_COVERED', `点不到 <${info.tag}>：${hit.reason}`);
  }

  // mouseMoved 不能省：很多控件要先 hover 才会挂上真正的点击处理器
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return info;
}

/**
 * 判断元素是否真的能被用户看到并点到。
 *
 * 实测（爱快路由后台）：45 个可交互元素里 21 个是 `opacity: 0`，而它们**照样进无障碍树**，
 * 快照因此发了 38 个 ref，其中近一半点了也没用。所以必须查计算样式，光看几何尺寸不够。
 *
 * 视口判断用的是**文档坐标而非视口坐标**：折叠线以下的元素是合法可点的（点击前会先滚过去），
 * 按视口过滤会把长页面的大半内容误杀。真正该滤掉的是被挪到画布外的（如收起态菜单 x=-44）。
 */
const VISIBLE_FN = `function () {
  const cs = getComputedStyle(this);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;

  // opacity 的效果会沿祖先链累乘，只查自身会漏掉"父容器整体透明"这种最常见的情况
  let opacity = 1;
  let node = this;
  while (node && node.nodeType === 1) {
    opacity *= parseFloat(getComputedStyle(node).opacity || '1');
    if (opacity === 0) return false;
    node = node.parentElement;
  }

  const r = this.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;

  const cx = r.x + scrollX + r.width / 2;
  const cy = r.y + scrollY + r.height / 2;
  const doc = document.documentElement;
  if (cx < 0 || cy < 0 || cx > doc.scrollWidth || cy > doc.scrollHeight) return false;

  return true;
}`;

export async function evaluate<T>(tabId: number, expression: string): Promise<T> {
  const result = await send<{
    result?: { value?: T };
    exceptionDetails?: { text?: string };
  }>(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new BridgeError(
      'ERR_SCRIPT_FAILED',
      `求值失败：${result.exceptionDetails.text ?? '未知'}`,
    );
  }
  return result.result?.value as T;
}

/**
 * 页面内一次数清有多少可交互元素是隐藏的。
 *
 * 成本几乎全在**第一次读几何属性**上：那一下会触发整篇文档的布局，实测 11113 节点的
 * 文档页约 127ms，之后每个元素只要几微秒。所以这里扫多少个元素几乎无所谓，
 * 别为了"少读几个矩形"把代码拆复杂 —— 拆成两趟循环实测反而更慢（234 个元素 2ms vs 1ms）。
 * 顺带一提：纯读不会造成布局抖动，抖动需要「写-读」交替。
 */
const COUNT_HIDDEN_EXPR = `(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role],[tabindex],[onclick],li[class*="menu"]';
  let hidden = 0;
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
      hidden++;
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) hidden++;
  }
  return hidden;
})()`;

/**
 * 批量判活。
 *
 * 逐节点查是 2 次 CDP 往返（resolveNode + callFunctionOn），234 个节点实测要 1.4 秒。
 * 所以先在页面内花约 30ms 数一次：**一个隐藏的可交互元素都没有就整个跳过**。
 * 内容型页面（文档、文章）恰好是 ref 多、幽灵少，正好被这条短路救下（实测 1397ms → 约 140ms）。
 *
 * 计数用的是 CSS 选择器，与无障碍树的节点集不完全重合，可能漏判。方向上是安全的：
 * 漏判只会少滤掉几个幽灵元素（退回优化前的行为），不会误删真实可点元素。
 */
export async function filterVisible(tabId: number, backendNodeIds: number[]): Promise<Set<number>> {
  if (backendNodeIds.length === 0) return new Set();

  try {
    if ((await evaluate<number>(tabId, COUNT_HIDDEN_EXPR)) === 0) {
      return new Set(backendNodeIds);
    }
  } catch {
    // 预检失败就老老实实逐个查，别因为优化本身出错而漏过滤
  }

  const checks = backendNodeIds.map(async (id) => {
    try {
      const ok = await callOnNode<boolean>(tabId, id, VISIBLE_FN);
      return ok ? id : null;
    } catch {
      // 解析不了的节点（多半已被移除）一律当作不可见，宁可少给一个 ref
      return null;
    }
  });
  const results = await Promise.all(checks);
  return new Set(results.filter((id): id is number => id !== null));
}

/** 把 CSS 选择器解析成 backendNodeId，让选择器点击也走同一套真实鼠标事件。 */
export async function backendNodeForSelector(tabId: number, selector: string): Promise<number> {
  const { root } = await send<{ root: { nodeId: number } }>(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await send<{ nodeId: number }>(tabId, 'DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) {
    throw new BridgeError('ERR_ELEMENT_NOT_FOUND', `选择器没有命中任何元素：${selector}`);
  }
  const { node } = await send<{ node: { backendNodeId: number } }>(tabId, 'DOM.describeNode', {
    nodeId,
  });
  return node.backendNodeId;
}

// 用户点横幅上的「取消」、或标签页关闭，都会触发 onDetach。必须同步清掉本地集合，
// 否则 ensureAttached 会以为还连着，直接拿一个已失效的会话去发命令。
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));
