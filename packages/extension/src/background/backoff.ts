export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

/**
 * 指数退避 + 全抖动。抖动不是锦上添花：服务端重启时所有浏览器窗口会同时掉线，
 * 没有抖动的话它们会在同一毫秒一起回来，把刚起来的服务端再打垮一次。
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, attempt), 16);
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
  return Math.round(ceiling * (0.5 + random() * 0.5));
}
