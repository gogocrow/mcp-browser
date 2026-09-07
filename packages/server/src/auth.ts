import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

/**
 * WebSocket **不受同源策略约束**：用户访问的任意网页都能打开一条到 127.0.0.1:8777 的连接。
 * 而桥是"新连接顶掉旧连接"的单连接模型，所以恶意页面连上来发个 hello 就能把真插件挤下线，
 * 之后 AI 发来的每个请求都由它伪造应答。仅靠"只听回环"挡不住这个。
 *
 * 规则：**带了 Origin 就必须是扩展来源；没带则放行。**
 * 浏览器发起的连接一定带 Origin，所以"不带"不是绕过手段；而联调脚本、curl 这类
 * 非浏览器客户端本来就不带 —— 它们能在本机跑代码，已经不在这个威胁模型里了。
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigin: string | undefined,
): boolean {
  if (origin === undefined) return true;
  if (allowedOrigin) return origin === allowedOrigin;
  return origin.startsWith('chrome-extension://');
}

/** 没配 token 就不校验；配了则必须完全一致。 */
export function isTokenValid(expected: string | undefined, provided: string | null): boolean {
  if (!expected) return true;
  if (provided === null) return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // 长度不等时 timingSafeEqual 会抛异常，必须先挡掉（长度本身会泄漏，这个可以接受）
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function bearerOf(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}
