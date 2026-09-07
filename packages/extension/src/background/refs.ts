import { BridgeError } from '@browser-mcp/shared';

/**
 * ref → backendNodeId 的映射，按标签页存。
 *
 * 放 session storage 而不是模块级变量：service worker 随时会被回收，
 * 存内存里的话「snapshot 之后隔一会儿再 click」就会莫名失效。
 *
 * 每次 snapshot 覆盖该标签页的整张表 —— ref 的语义就是"上一次快照里的第 N 个元素"，
 * 保留历史只会让过期的 ref 看起来还能用。
 */
const keyOf = (tabId: number): string => `refs:${tabId}`;

export async function saveRefs(tabId: number, refs: Record<string, number>): Promise<void> {
  await chrome.storage.session.set({ [keyOf(tabId)]: refs });
}

export async function resolveRef(tabId: number, ref: string): Promise<number> {
  const key = keyOf(tabId);
  const stored = await chrome.storage.session.get(key);
  const table = stored[key] as Record<string, number> | undefined;

  if (!table) {
    throw new BridgeError(
      'ERR_STALE_REF',
      `标签页 ${tabId} 还没有做过 page.snapshot，拿不到 ${ref} 对应的元素`,
    );
  }
  const backendNodeId = table[ref];
  if (backendNodeId === undefined) {
    throw new BridgeError('ERR_STALE_REF', `最近一次快照里没有 ${ref}，请重新 page.snapshot`);
  }
  return backendNodeId;
}
