import {
  ACTION_NAMES,
  ACTIONS,
  type ActionDef,
  type ActionInput,
  type ActionName,
  type ActionOutput,
  toBridgeError,
} from '@browser-mcp/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type AuditLog, redactParams, summarizeResult } from './audit.ts';
import type { BridgeHub } from './bridge.ts';
import type { Selection } from './selection.ts';

/** MCP 工具名不能带点，`page.navigate` → `page_navigate`。 */
export function toolNameFor(action: ActionName): string {
  return action.replaceAll('.', '_');
}

/**
 * 省略 tabId 时补上当前选中的页面。显式传入的 tabId 永远优先 ——
 * 模型想临时操作另一个页面时不该被选中状态劫持。
 */
export function applySelection(
  action: ActionName,
  args: Record<string, unknown>,
  selectedTabId: number | null,
): Record<string, unknown> {
  if (selectedTabId === null) return args;
  if (args.tabId !== undefined) return args;
  const def: ActionDef = ACTIONS[action];
  if (!Object.hasOwn(def.input.shape, 'tabId')) return args;
  return { ...args, tabId: selectedTabId };
}

function registerAction<K extends ActionName>(
  server: McpServer,
  hub: BridgeHub,
  selection: Selection,
  audit: AuditLog,
  action: K,
): void {
  const def = ACTIONS[action];
  server.registerTool(
    toolNameFor(action),
    {
      description: def.description,
      inputSchema: def.input.shape,
      outputSchema: def.output.shape,
    },
    async (args: unknown) => {
      const startedAt = Date.now();
      // 在 applySelection 之后取 tabId，这样"省略 tabId 落到选中页"的动作也能记下真实目标
      const payload = applySelection(
        action,
        (args ?? {}) as Record<string, unknown>,
        selection.current,
      );
      const tabId = typeof payload.tabId === 'number' ? payload.tabId : null;

      try {
        const result = await hub.call(action, payload as ActionInput<K>);

        // 只有插件确认这个标签页存在（动作成功）之后才记住它，失败时不改变当前选中
        if (action === 'tabs.select') {
          selection.set((result as ActionOutput<'tabs.select'>).tab.id);
        }

        const summary = summarizeResult(result);
        void audit.append({
          at: new Date(startedAt).toISOString(),
          action,
          tabId,
          params: redactParams(payload),
          ok: true,
          durationMs: Date.now() - startedAt,
          ...(summary === undefined ? {} : { summary }),
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (cause) {
        // 失败走 isError 而不是抛出：模型需要看见 code 才能判断该重试还是换个选择器
        const error = toBridgeError(cause);

        void audit.append({
          at: new Date(startedAt).toISOString(),
          action,
          tabId,
          params: redactParams(payload),
          ok: false,
          durationMs: Date.now() - startedAt,
          errorCode: error.code,
          summary: error.message,
        });

        return {
          isError: true,
          content: [{ type: 'text' as const, text: `${error.code}: ${error.message}` }],
        };
      }
    },
  );
}

const statusOutput = z.object({
  connected: z.boolean(),
  extensionVersion: z.string().nullable(),
  userAgent: z.string().nullable(),
  connectedAt: z.string().nullable(),
  pending: z.number().int(),
  selectedTabId: z.number().int().nullable(),
});

const historyEntry = z.object({
  at: z.string(),
  action: z.string(),
  tabId: z.number().int().nullable(),
  params: z.record(z.string(), z.unknown()),
  ok: z.boolean(),
  durationMs: z.number(),
  errorCode: z.string().optional(),
  summary: z.string().optional(),
});

export function createMcpServer(
  hub: BridgeHub,
  selection: Selection,
  audit: AuditLog,
  version: string,
): McpServer {
  const server = new McpServer({ name: 'browser-mcp', version });

  // 所有页面动作在插件没连上时都会失败，先给模型一个便宜的探活手段
  server.registerTool(
    'browser_status',
    {
      description: '查询插件连接状态与当前选中的标签页；其他 browser 工具都依赖插件处于已连接状态',
      inputSchema: {},
      outputSchema: statusOutput.shape,
    },
    async () => {
      const status = { ...hub.status(), selectedTabId: selection.current };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    },
  );

  // 只读的元操作（查状态、查历史）不写审计，否则日志会被自己的查询淹没
  server.registerTool(
    'history_query',
    {
      description:
        '查询已经执行过的浏览器操作记录（时间、动作、参数、成败、耗时）。用于回答"刚才在这个页面上做过什么""哪一步失败了"。记录落盘保存，跨服务端重启存活',
      inputSchema: {
        tabId: z.number().int().optional().describe('只看这个标签页；省略则看全部'),
        limit: z.number().int().positive().max(500).default(50),
        since: z.string().optional().describe('ISO 时间戳，只看这之后的记录'),
        onlyErrors: z.boolean().default(false).describe('只看失败的操作'),
      },
      outputSchema: { entries: z.array(historyEntry), file: z.string() },
    },
    async (args: unknown) => {
      const input = (args ?? {}) as {
        tabId?: number;
        limit?: number;
        since?: string;
        onlyErrors?: boolean;
      };
      const entries = await audit.query({
        tabId: input.tabId,
        since: input.since,
        onlyErrors: input.onlyErrors,
        limit: input.limit ?? 50,
      });
      const payload = { entries, file: audit.file };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );

  for (const action of ACTION_NAMES) registerAction(server, hub, selection, audit, action);

  return server;
}
