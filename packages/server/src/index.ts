import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BRIDGE_WS_PATH, MCP_HTTP_PATH } from '@browser-mcp/shared';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebSocketServer } from 'ws';
import { AuditLog } from './audit.ts';
import { bearerOf, isOriginAllowed, isTokenValid } from './auth.ts';
import { BridgeHub } from './bridge.ts';
import { assertConfigSafe, loadConfig } from './config.ts';
import { log } from './logger.ts';
import { createMcpServer } from './mcp.ts';
import { Selection } from './selection.ts';

const VERSION = '0.1.0';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const config = loadConfig();
assertConfigSafe(config);

const selection = new Selection();
// 插件一断开就丢弃选中：重连后标签页 id 可能已经指向别的页面
const hub = new BridgeHub(config.requestTimeoutMs, () => selection.clear());
const wss = new WebSocketServer({ noServer: true });
const audit = new AuditLog(config.auditFile, config.auditEnabled);

function tokenOk(provided: string | null): boolean {
  return isTokenValid(config.token, provided);
}

function originOk(req: IncomingMessage): boolean {
  return isOriginAllowed(req.headers.origin, config.allowedOrigin);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过上限');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * 无状态模式：每个 MCP 请求现建一对 server/transport，用完即弃。
 * 桥（hub）是模块级单例，所以工具依然打到同一条插件连接上 —— 需要保持长活的是桥，不是 MCP 会话。
 */
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // MCP 这条路浏览器本来就会被预检挡住，这里是纵深防御，代价只有两行
  if (!originOk(req)) {
    log.warn('拒绝来源不合法的 MCP 请求', { origin: req.headers.origin });
    sendJson(res, 403, { error: 'forbidden_origin' });
    return;
  }
  if (!tokenOk(bearerOf(req.headers.authorization))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const server = createMcpServer(hub, selection, audit, VERSION);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  await transport.handleRequest(req, res, body);
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, version: VERSION, bridge: hub.status() });
    return;
  }
  if (url.pathname === MCP_HTTP_PATH) {
    await handleMcp(req, res);
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

const httpServer = createServer((req, res) => {
  handleHttp(req, res).catch((cause: unknown) => {
    log.error('HTTP 处理失败', { message: cause instanceof Error ? cause.message : String(cause) });
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    else res.end();
  });
});

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== BRIDGE_WS_PATH) {
    socket.destroy();
    return;
  }
  // 任意网页都能发起 WebSocket 连接（不受同源策略约束），必须按来源挡掉
  if (!originOk(req)) {
    log.warn('拒绝来源不合法的 WebSocket 连接', { origin: req.headers.origin });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  // 插件里放不了 Authorization 头（WebSocket 构造器不支持），所以令牌走 query
  if (!tokenOk(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
});

httpServer.listen(config.port, config.host, () => {
  log.info('中转服务已启动', {
    ws: `ws://${config.host}:${config.port}${BRIDGE_WS_PATH}`,
    mcp: `http://${config.host}:${config.port}${MCP_HTTP_PATH}`,
    auth: config.token ? 'token' : 'none',
    audit: config.auditEnabled ? config.auditFile : 'off',
  });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`收到 ${signal}，正在关闭`);

    // 必须先掐断 WebSocket。`httpServer.close()` 只是停止 accept，它会等**现有连接**结束，
    // 而 WebSocket 是长连接、永远不会自己结束 —— 于是 close 的回调不触发、进程不退出，
    // 变成一个没有监听套接字、却仍攥着插件连接并继续发心跳的僵尸。
    // 后果极其隐蔽：新进程能正常绑定端口，插件却始终连在僵尸上、看到的是一条完全健康的连接，
    // 表现为"服务端重启后插件永远不重连"，而插件侧查不出任何毛病。
    for (const client of wss.clients) client.terminate();

    httpServer.close(() => process.exit(0));
    // 兜底：万一还有连接卡住，别把关闭流程也变成僵尸
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
