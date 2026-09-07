import { BridgeError } from '@browser-mcp/shared';

/**
 * 注入函数会被 `Function.prototype.toString()` 序列化后送进页面，**不能引用任何外层作用域的东西**
 * （import、模块级常量、闭包变量都不行），一切输入必须经 args 传进去。打包器不会报这个错，
 * 只会在运行时抛 "xxx is not defined"。下面每个 page* 函数都必须保持自包含。
 */
async function inject<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
  // ExecutionWorld 是 enum，而 executeScript 收的是它的字面量形式
  world: `${chrome.scripting.ExecutionWorld}` = 'ISOLATED',
): Promise<R> {
  let results: chrome.scripting.InjectionResult<chrome.scripting.Awaited<R>>[];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // chrome://、Chrome 应用商店、PDF 查看器等页面禁止注入，这不是 bug，要让模型看懂
    throw new BridgeError('ERR_TAB_BLOCKED', `无法在该标签页执行脚本：${message}`);
  }
  const first = results[0];
  if (!first) throw new BridgeError('ERR_SCRIPT_FAILED', '注入脚本没有返回结果');
  return first.result as R;
}

function pageText(maxChars: number, selector: string | null) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!(root instanceof HTMLElement)) return { found: false as const };
  const text = root.innerText ?? '';
  const truncated = text.length > maxChars;
  return {
    found: true as const,
    url: location.href,
    title: document.title,
    text: truncated ? text.slice(0, maxChars) : text,
    totalChars: text.length,
    truncated,
  };
}

function pageQuery(selector: string, limit: number) {
  const interesting = [
    'id',
    'class',
    'href',
    'src',
    'type',
    'name',
    'value',
    'placeholder',
    'role',
    'aria-label',
  ];
  const nodes = Array.from(document.querySelectorAll(selector));
  const matches = nodes.slice(0, limit).map((element, index) => {
    const attributes: Record<string, string> = {};
    for (const name of interesting) {
      const value = element.getAttribute(name);
      if (value !== null) attributes[name] = value;
    }
    return {
      index,
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? '').trim().slice(0, 200),
      attributes,
    };
  });
  return { matches, total: nodes.length };
}

function pageFill(selector: string, value: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) return { found: false as const, supported: true };

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    // React/Vue 会劫持 value 的 setter 来跟踪状态；直接赋值它们收不到变更，
    // 必须走原型链上的原生 setter 再补派发事件，受控组件才认这次输入。
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  } else if (element.isContentEditable) {
    element.focus();
    element.textContent = value;
  } else {
    return { found: true as const, supported: false };
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true as const, supported: true, tag: element.tagName.toLowerCase() };
}

function pageEval(expression: string) {
  const value = new Function(`return (${expression});`)();
  try {
    // executeScript 只能回传可结构化克隆的值，先自己收敛一次，报错才有意义
    return { ok: true as const, value: JSON.parse(JSON.stringify(value ?? null)) as unknown };
  } catch {
    return { ok: false as const, preview: String(value).slice(0, 200) };
  }
}

export async function text(tabId: number, maxChars: number, selector: string | undefined) {
  const result = await inject(tabId, pageText, [maxChars, selector ?? null]);
  if (!result.found) {
    throw new BridgeError('ERR_ELEMENT_NOT_FOUND', `选择器没有命中任何元素：${selector}`);
  }
  return {
    url: result.url,
    title: result.title,
    text: result.text,
    totalChars: result.totalChars,
    truncated: result.truncated,
  };
}

export async function query(tabId: number, selector: string, limit: number) {
  return inject(tabId, pageQuery, [selector, limit]);
}

export async function fill(tabId: number, selector: string, value: string) {
  const result = await inject(tabId, pageFill, [selector, value]);
  if (!result.found) {
    throw new BridgeError('ERR_ELEMENT_NOT_FOUND', `选择器没有命中任何元素：${selector}`);
  }
  if (!result.supported) {
    throw new BridgeError('ERR_SCRIPT_FAILED', `元素既不是输入框也不可编辑：${selector}`);
  }
  return { tag: result.tag ?? '' };
}

export async function evaluate(tabId: number, expression: string) {
  // MAIN world 才能看到页面自己的变量（window.__STATE__ 之类）；DOM 操作留在 ISOLATED 更安全
  const result = await inject(tabId, pageEval, [expression], 'MAIN');
  if (!result.ok) {
    throw new BridgeError('ERR_SCRIPT_FAILED', `求值结果无法序列化：${result.preview}`);
  }
  return { value: result.value };
}
