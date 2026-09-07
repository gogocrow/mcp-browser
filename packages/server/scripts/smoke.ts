/**
 * 不开 Chrome 的联调脚本：起一个真的服务端，用一个假插件接到 /bridge 上，
 * 再按 MCP 协议打 /mcp，把「MCP 工具 → 桥 → 插件 → 回执」整条链路跑一遍。
 *
 * 重点验证「列出页面 → 选中页面 → 在该页面上操作」这条主线，
 * 包括选中后省略 tabId 会落到选中页、显式传 tabId 会覆盖选中。
 *
 * 插件那一半没法在单元测试里覆盖，改动协议、动作注册表或 MCP 装配后请跑这个：
 *   pnpm --filter @browser-mcp/server smoke
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@browser-mcp/shared';
import { WebSocket } from 'ws';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

interface RpcResult {
  result?: {
    tools?: { name: string }[];
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
}

const server = spawn('node', [join(packageRoot, 'src/index.ts')], {
  env: { ...process.env, BRIDGE_PORT: String(PORT), BRIDGE_LOG: 'off' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      // 还没监听上，继续等
    }
    await sleep(100);
  }
  throw new Error('服务端没能在 5 秒内启动');
}

async function rpc(method: string, params: unknown): Promise<RpcResult> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  // 传输层可能回 SSE，也可能回纯 JSON
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text) as RpcResult;
}

const TABS = [
  { id: 11, windowId: 1, url: 'https://a.test/', title: '页面 A', active: true },
  { id: 22, windowId: 1, url: 'https://b.test/', title: '页面 B', active: false },
];

/** 假插件：省略 tabId 时退回活动标签页，和真插件 resolveTabId 的行为一致。 */
function resolveTab(payload: Record<string, unknown>) {
  const id = payload.tabId;
  return id === undefined ? TABS.find((tab) => tab.active) : TABS.find((tab) => tab.id === id);
}

function fakeRespond(action: string, payload: Record<string, unknown>): unknown | null {
  if (action === 'tabs.list') return { tabs: TABS };
  const tab = resolveTab(payload);
  if (!tab) return null;
  if (action === 'tabs.select' || action === 'tabs.activate') return { tab };
  if (action === 'page.snapshot') {
    return {
      url: tab.url,
      title: tab.title,
      snapshot: `- heading "${tab.title}"\n- button "确定" [ref=e0]`,
      refCount: 1,
      truncated: false,
    };
  }
  if (action === 'page.text') {
    return { url: tab.url, title: tab.title, text: `${tab.title} 的正文`, truncated: false };
  }
  return null;
}

function attachFakeExtension(): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`);
  ws.on('message', (raw: Buffer) => {
    const message = JSON.parse(raw.toString()) as {
      kind: string;
      id: string;
      action: string;
      payload: Record<string, unknown>;
    };
    if (message.kind !== 'request') return;
    console.log(`    插件收到 ${message.action} ${JSON.stringify(message.payload)}`);
    const result = fakeRespond(message.action, message.payload);
    ws.send(
      JSON.stringify(
        result
          ? { v: PROTOCOL_VERSION, kind: 'response', id: message.id, ok: true, result }
          : {
              v: PROTOCOL_VERSION,
              kind: 'response',
              id: message.id,
              ok: false,
              error: { code: 'ERR_NO_TAB', message: '假插件没有这个标签页' },
            },
      ),
    );
  });
  return ws;
}

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  const out = await rpc('tools/call', { name, arguments: args });
  const payload = out.result?.structuredContent ?? out.result?.content?.[0]?.text;
  console.log(`  ${name}(${JSON.stringify(args)}) → ${JSON.stringify(payload)}`);
  return payload;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`);
}

try {
  await waitForServer();

  const ws = attachFakeExtension();
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: 'hello',
      extensionVersion: '0.1.0',
      userAgent: 'smoke-test',
    }),
  );
  await sleep(200);

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1' },
  });

  const tools = await rpc('tools/list', {});
  console.log('工具列表', JSON.stringify(tools.result?.tools?.map((t) => t.name)));

  console.log('\n[1] 列出页面');
  const listed = (await call('tabs_list', {})) as { tabs: unknown[] };
  assert(listed.tabs.length === 2, 'tabs_list 应返回 2 个标签页');

  console.log('\n[2] 还没选中时，页面操作落到活动标签页');
  const beforeSelect = (await call('page_snapshot', {})) as { title: string };
  assert(beforeSelect.title === '页面 A', '未选中时应落到活动标签页 A');

  console.log('\n[3] 选中页面 B');
  await call('tabs_select', { tabId: 22 });
  const status = (await call('browser_status', {})) as { selectedTabId: number };
  assert(status.selectedTabId === 22, 'browser_status 应报告选中 22');

  console.log('\n[4] 选中之后，省略 tabId 的操作落到页面 B');
  const afterSelect = (await call('page_snapshot', {})) as { title: string };
  assert(afterSelect.title === '页面 B', '选中后应落到页面 B');

  console.log('\n[5] 显式传 tabId 仍然优先于选中');
  const explicit = (await call('page_snapshot', { tabId: 11 })) as { title: string };
  assert(explicit.title === '页面 A', '显式 tabId 应覆盖选中');

  console.log('\n[6] 选中一个不存在的页面：报错且不改变原有选中');
  await call('tabs_select', { tabId: 999 });
  const after = (await call('browser_status', {})) as { selectedTabId: number };
  assert(after.selectedTabId === 22, '失败的 tabs_select 不应改变选中');

  ws.close();
  console.log('\n联调通过');
} finally {
  server.kill('SIGTERM');
}
