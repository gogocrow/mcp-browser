import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRIDGE_PORT } from '@browser-mcp/shared';

export interface ServerConfig {
  host: string;
  port: number;
  /** 设了就强制校验：插件走 ?token=，MCP 走 Authorization: Bearer。 */
  token: string | undefined;
  /** 收紧到具体的扩展来源，如 chrome-extension://abcd...；不设则接受任意扩展来源。 */
  allowedOrigin: string | undefined;
  /** 单次动作从下发到插件回执的上限 */
  requestTimeoutMs: number;
  /** 审计日志落盘位置 */
  auditFile: string;
  auditEnabled: boolean;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，实际是 ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadConfig(): ServerConfig {
  return {
    // 默认只听回环。这个服务能让调用方在用户浏览器里执行任意 JS，
    // 绑到 0.0.0.0 等于把同网段的任何人变成浏览器的主人 —— 要改必须同时设 BRIDGE_TOKEN。
    host: process.env.BRIDGE_HOST ?? '127.0.0.1',
    port: intFromEnv('BRIDGE_PORT', DEFAULT_BRIDGE_PORT),
    token: process.env.BRIDGE_TOKEN || undefined,
    allowedOrigin: process.env.BRIDGE_ALLOWED_ORIGIN || undefined,
    requestTimeoutMs: intFromEnv('BRIDGE_REQUEST_TIMEOUT_MS', 30_000),
    auditFile: process.env.BRIDGE_AUDIT_FILE ?? join(homedir(), '.browser-mcp', 'audit.jsonl'),
    auditEnabled: process.env.BRIDGE_AUDIT !== 'off',
  };
}

export function assertConfigSafe(config: ServerConfig): void {
  const loopback =
    config.host === '127.0.0.1' || config.host === '::1' || config.host === 'localhost';
  if (!loopback && !config.token) {
    throw new Error(
      `拒绝在非回环地址 ${config.host} 上无鉴权启动：请设置 BRIDGE_TOKEN，或改回 BRIDGE_HOST=127.0.0.1`,
    );
  }
}
