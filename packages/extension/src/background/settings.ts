import { BRIDGE_WS_PATH, DEFAULT_BRIDGE_PORT } from '@browser-mcp/shared';

export interface Settings {
  url: string;
  token: string;
}

export const DEFAULT_URL = `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}${BRIDGE_WS_PATH}`;

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(['url', 'token']);
  const url = typeof stored.url === 'string' && stored.url.length > 0 ? stored.url : DEFAULT_URL;
  const token = typeof stored.token === 'string' ? stored.token : '';
  return { url, token };
}

export async function writeSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set(settings);
}

/** WebSocket 构造器不支持自定义请求头，令牌只能挂在 query 上。 */
export function endpointOf(settings: Settings): string {
  if (!settings.token) return settings.url;
  const url = new URL(settings.url);
  url.searchParams.set('token', settings.token);
  return url.toString();
}
