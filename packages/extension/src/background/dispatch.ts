import {
  ACTIONS,
  type ActionDef,
  type ActionName,
  type ActionOutput,
  type ActionPayload,
  BridgeError,
  isActionName,
} from '@browser-mcp/shared';
import { buildSnapshot } from './ax.ts';
import { backendNodeForSelector, callOnNode, clickElement } from './cdp.ts';
import { clearLog, readLog } from './diag.ts';
import * as page from './inject.ts';
import { getBody, isRecording, listEntries, startRecording, stopRecording } from './network.ts';
import { resolveRef, saveRefs } from './refs.ts';
import { getTab, resolveTabId, toTabInfo, waitForLoad } from './tabs.ts';

/**
 * 映射类型强制覆盖 ACTIONS 的每一个键：在 shared 里新增动作而这里忘了实现，是编译错误而不是运行时 404。
 */
type Handlers = {
  [K in ActionName]: (input: ActionPayload<K>) => Promise<ActionOutput<K>>;
};

/**
 * 这段会被 CDP 的 Runtime.callFunctionOn 直接在目标元素上执行，`this` 就是那个元素。
 * 和 inject.ts 里的注入函数一样必须自包含，而且这里是字符串，编译器完全帮不上忙。
 */
const FILL_FN = `function (value) {
  this.focus();
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    var proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter ? setter.call(this, value) : (this.value = value);
  } else if (this.isContentEditable) {
    this.textContent = value;
  } else {
    throw new Error('元素既不是输入框也不可编辑');
  }
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { tag: this.tagName.toLowerCase() };
}`;

/** ref 与 selector 的"至少给一个"约束没法写进 zod（会破坏 .shape），只能在这里兜。 */
function requireSelector(selector: string | undefined): string {
  if (selector) return selector;
  throw new BridgeError('ERR_INVALID_PAYLOAD', '需要 ref 或 selector 至少给一个');
}

const handlers: Handlers = {
  'tabs.list': async () => {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.filter((tab) => tab.id !== undefined).map(toTabInfo) };
  },

  // 只负责确认这个标签页确实存在并回传它的信息；"选中"这个状态由服务端持有
  'tabs.select': async ({ tabId }) => {
    return { tab: toTabInfo(await getTab(tabId)) };
  },

  'tabs.activate': async ({ tabId }) => {
    const tab = await getTab(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { tab: toTabInfo(await getTab(tabId)) };
  },

  'page.navigate': async ({ url, tabId, timeoutMs }) => {
    const id = await resolveTabId(tabId);
    // 先挂监听再触发导航：页面可能在 update 返回前就 complete 了
    const loaded = waitForLoad(id, timeoutMs);
    // 若 update 抛错就没人 await loaded 了，先接一个 handler 避免未处理拒绝
    loaded.catch(() => {});
    await chrome.tabs.update(id, { url });
    await loaded;
    return { tab: toTabInfo(await getTab(id)) };
  },

  'page.snapshot': async ({ tabId, includeStructure, maxChars }) => {
    const id = await resolveTabId(tabId);
    const [tab, built] = await Promise.all([
      getTab(id),
      buildSnapshot(id, includeStructure, maxChars),
    ]);
    await saveRefs(id, built.refs);
    return {
      url: tab.url ?? '',
      title: tab.title ?? '',
      snapshot: built.snapshot,
      refCount: built.refCount,
      hiddenCount: built.hiddenCount,
      totalChars: built.totalChars,
      truncated: built.truncated,
    };
  },

  'page.text': async ({ tabId, selector, maxChars }) => {
    return page.text(await resolveTabId(tabId), maxChars, selector);
  },

  'page.query': async ({ tabId, selector, limit }) => {
    return page.query(await resolveTabId(tabId), selector, limit);
  },

  // ref 与 selector 两条路都归一到坐标点击，避免两种点击语义各自漂移
  'page.click': async ({ tabId, ref, selector }) => {
    const id = await resolveTabId(tabId);
    const backendNodeId = ref
      ? await resolveRef(id, ref)
      : await backendNodeForSelector(id, requireSelector(selector));
    return clickElement(id, backendNodeId);
  },

  'page.fill': async ({ tabId, ref, selector, value }) => {
    const id = await resolveTabId(tabId);
    if (ref) {
      return callOnNode<{ tag: string }>(id, await resolveRef(id, ref), FILL_FN, [value]);
    }
    return page.fill(id, requireSelector(selector), value);
  },

  'network.start': async ({ tabId }) => {
    const id = await resolveTabId(tabId);
    const { cleared } = await startRecording(id);
    return { recording: true, cleared };
  },

  'network.list': async ({ tabId, offset, limit, urlContains, method, onlyApi, onlyFailed }) => {
    const id = await resolveTabId(tabId);
    return listEntries(id, { offset, limit, urlContains, method, onlyApi, onlyFailed });
  },

  'network.body': async ({ tabId, requestId, offset, maxChars, includeHeaders }) => {
    const id = await resolveTabId(tabId);
    return getBody(id, requestId, offset, maxChars, includeHeaders);
  },

  'network.stop': async ({ tabId, clear }) => {
    const id = await resolveTabId(tabId);
    const { kept } = await stopRecording(id, clear);
    return { recording: isRecording(id), kept };
  },

  'debug.log': async ({ clear }) => {
    const entries = await readLog();
    const alarms = await chrome.alarms.getAll();
    if (clear) await clearLog();
    return {
      entries,
      alarms: alarms.map((a) => ({ name: a.name, scheduledTime: a.scheduledTime })),
    };
  },

  'page.eval': async ({ tabId, expression }) => {
    return page.evaluate(await resolveTabId(tabId), expression);
  },
};

export async function runAction(action: string, payload: unknown): Promise<unknown> {
  if (!isActionName(action)) {
    throw new BridgeError('ERR_UNKNOWN_ACTION', `未知动作：${action}`);
  }
  const def: ActionDef = ACTIONS[action];
  const parsed = def.input.safeParse(payload);
  if (!parsed.success) {
    throw new BridgeError('ERR_INVALID_PAYLOAD', `动作 ${action} 的参数不合法`, {
      issues: parsed.error.issues,
    });
  }
  const handler = handlers[action] as (input: unknown) => Promise<unknown>;
  return handler(parsed.data);
}
