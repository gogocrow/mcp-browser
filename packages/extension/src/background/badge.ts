export type ConnectionState = 'connected' | 'connecting' | 'disconnected';

export const STATE_KEY = 'connectionState';

const BADGE: Record<ConnectionState, { text: string; color: string; title: string }> = {
  connected: { text: 'ON', color: '#22c55e', title: '已连接中转服务' },
  connecting: { text: '···', color: '#eab308', title: '正在连接中转服务' },
  disconnected: { text: 'OFF', color: '#ef4444', title: '未连接，正在重试' },
};

/**
 * 图标徽标是用户唯一能看到的连接状态，同时写一份到 session storage 供 popup 读取。
 * 用 session 而不是 local：连接状态跟着浏览器会话走，重启后不该残留上次的"已连接"。
 */
export async function paintState(state: ConnectionState): Promise<void> {
  const spec = BADGE[state];
  await Promise.all([
    chrome.action.setBadgeText({ text: spec.text }),
    chrome.action.setBadgeBackgroundColor({ color: spec.color }),
    chrome.action.setTitle({ title: `Browser MCP Bridge — ${spec.title}` }),
    chrome.storage.session.set({ [STATE_KEY]: state }),
  ]);
}
