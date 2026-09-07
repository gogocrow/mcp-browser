import { type ActionOutput, BridgeError } from '@browser-mcp/shared';

export type TabInfo = ActionOutput<'tabs.list'>['tabs'][number];

export function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  if (tab.id === undefined) throw new BridgeError('ERR_NO_TAB', '标签页缺少 id');
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active,
  };
}

export async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new BridgeError('ERR_NO_TAB', `标签页 ${tabId} 不存在`);
  }
}

/** 省略 tabId 时统一解释为"最后聚焦窗口的活动标签页"。 */
export async function resolveTabId(tabId: number | undefined): Promise<number> {
  if (tabId !== undefined) {
    await getTab(tabId);
    return tabId;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active || active.id === undefined) {
    throw new BridgeError('ERR_NO_TAB', '找不到活动标签页');
  }
  return active.id;
}

export function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new BridgeError('ERR_TIMEOUT', `标签页 ${tabId} 在 ${timeoutMs}ms 内未加载完成`));
    }, timeoutMs);

    const onUpdated = (changedId: number, info: chrome.tabs.OnUpdatedInfo): void => {
      if (changedId !== tabId || info.status !== 'complete') return;
      cleanup();
      resolve();
    };
    // 标签页被关掉时必须主动失败，否则只能等超时
    const onRemoved = (removedId: number): void => {
      if (removedId !== tabId) return;
      cleanup();
      reject(new BridgeError('ERR_NO_TAB', `标签页 ${tabId} 在导航过程中被关闭`));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}
