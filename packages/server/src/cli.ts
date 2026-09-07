#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BRIDGE_PORT ?? 8777);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.BRIDGE_TOKEN;

/**
 * 退出码是 skill 的主要分支依据，让它不必解析 stderr 文本。
 * 改动这里要同步改 SKILL.md。
 */
const EXIT = {
  ok: 0,
  usage: 2,
  noExtension: 3,
  notFound: 4,
  timeout: 5,
  blocked: 6,
  other: 1,
} as const;

const EXIT_BY_CODE: Record<string, number> = {
  ERR_NO_EXTENSION: EXIT.noExtension,
  ERR_DISCONNECTED: EXIT.noExtension,
  ERR_NO_TAB: EXIT.notFound,
  ERR_ELEMENT_NOT_FOUND: EXIT.notFound,
  ERR_STALE_REF: EXIT.notFound,
  ERR_ELEMENT_COVERED: EXIT.notFound,
  ERR_TIMEOUT: EXIT.timeout,
  ERR_TAB_BLOCKED: EXIT.blocked,
  ERR_DEBUGGER_UNAVAILABLE: EXIT.blocked,
};

function die(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// ---------- 守护进程 ----------

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 首次运行时自动把守护进程拉起来，用户不需要记得先开服务。
 * 并发调用时抢输的一方会因端口被占而退出，这里只等健康检查通过即可，不必加锁。
 */
async function bridgeConnected(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { bridge?: { connected?: boolean } };
    return body.bridge?.connected === true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const entry = [join(here, 'index.js'), join(here, 'index.ts')].find((p) => existsSync(p));
  if (!entry) die('找不到守护进程入口，先在仓库里跑一次 pnpm build', EXIT.other);

  spawn(process.execPath, [entry], { detached: true, stdio: 'ignore' }).unref();

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(150);
    up = await healthy();
  }
  if (!up) die(`守护进程启动失败，看看 ${BASE}/healthz 通不通`, EXIT.other);

  // 守护进程刚起来时插件还连不上。既然是我们把它拉起来的，就该等一等 ——
  // 否则冷启动后的第一条命令会莫名其妙地报「插件未连接」。
  // 等 20 秒是因为插件此时多半正处在退避中（退避上限 30s），实测等 9 秒不够。
  for (let i = 0; i < 133; i++) {
    if (await bridgeConnected()) return;
    await sleep(150);
  }
}

// ---------- 与守护进程通信 ----------

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  await ensureDaemon();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) die(`守护进程返回 HTTP ${res.status}`, EXIT.other);

  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const parsed = JSON.parse(line ? line.slice(6) : text) as {
    result?: { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
  };

  if (parsed.result?.isError) {
    const message = parsed.result.content?.[0]?.text ?? '未知错误';
    const code = message.split(':')[0]?.trim() ?? '';
    die(message, EXIT_BY_CODE[code] ?? EXIT.other);
  }
  return parsed.result?.structuredContent;
}

// ---------- 参数解析 ----------

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

const num = (v: string | boolean | undefined, fallback: number): number =>
  typeof v === 'string' && v !== '' ? Number(v) : fallback;

/** 除非显式给了 --tab，否则不传 tabId，交给守护进程用「已选中的页面」兜底。 */
const tabArg = (flags: Args['flags']): Record<string, number> =>
  flags.tab === undefined ? {} : { tabId: num(flags.tab, 0) };

// ---------- 输出 ----------

let jsonMode = false;

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function emit(value: unknown, format: (v: never) => string): void {
  if (jsonMode) out(JSON.stringify(value, null, 2));
  else out(format(value as never));
}

/**
 * 走 stderr：stdout 常被 grep 吃掉，而"你看到的是残缺内容"这件事必须还能看见。
 * total 可能拿不到（守护进程或插件是旧版），那就别报数字 —— 宁可少说也不能说错。
 */
function warnTruncated(truncated: boolean, total: number | undefined): void {
  if (!truncated) return;
  const size = typeof total === 'number' ? `，全文 ${total} 字符` : '';
  process.stderr.write(`（已截断${size}；要 grep 全文请加 --max 0）\n`);
}

const HELP = `bx — 操作你已经打开的 Chrome 标签页

用法: bx <命令> [参数] [选项]

标签页
  tabs                     列出标签页（* 当前活动，> 已选中）
  select <tabId>           选定后续操作的目标（不切前台）
  activate <tabId>         把标签页切到前台

读取
  snapshot [--structure]   语义快照，可操作元素带 [ref]；默认只给可交互元素
  text [--css <选择器>]     读可见正文（默认截断 2000 字符，--max 0 不截断）
  query <选择器>            按选择器列出匹配元素  [--limit 20]

操作
  click <ref>              点击；也可 --css <选择器>
  fill <ref> <值>          填入输入框；也可 --css <选择器>
  nav <url>                导航并等待加载完成
  eval <表达式>             在页面里求值

网络
  net start                开始录制网络请求（有开销，用完 net stop）
  net list [--api]         列出请求：method + URL + requestId  [--url <子串>] [--failed]
  net body <requestId>     取响应体，可分页  [--offset N] [--max N] [--headers]
  net stop [--clear]       停止录制

其他
  status                   守护进程与插件连接状态
  history [--errors]       操作审计记录  [--tab <id>] [--limit 20]
  daemon status|stop       管理守护进程（平时不用，首次调用会自动启动）

全局选项
  --json      输出 JSON（默认紧凑文本，更省 token）
  --tab <id>  临时指定标签页，覆盖已选中的
  --max <n>   截断上限，0 表示不截断

退出码: 0 成功 / 2 用法错 / 3 插件未连 / 4 找不到目标或 ref 失效 / 5 超时 / 6 页面禁止注入
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    out(HELP);
    return;
  }

  const [command, ...rest] = argv;
  const { positional, flags } = parse(rest);
  jsonMode = flags.json === true;
  const max = (fallback: number): number => num(flags.max, fallback);

  switch (command) {
    case 'tabs': {
      const r = (await callTool('tabs_list', {})) as {
        tabs: { id: number; title: string; url: string; active: boolean }[];
      };
      const selected = ((await callTool('browser_status', {})) as { selectedTabId: number | null })
        .selectedTabId;
      emit(r, (v: typeof r) =>
        v.tabs
          .map((t) => {
            const mark = t.id === selected ? '>' : t.active ? '*' : ' ';
            return `${t.id}  ${mark}  ${t.title.slice(0, 40).padEnd(40)}  ${t.url.slice(0, 60)}`;
          })
          .join('\n'),
      );
      return;
    }

    case 'select':
    case 'activate': {
      const tabId = Number(positional[0]);
      if (!Number.isFinite(tabId)) die(`用法: bx ${command} <tabId>`, EXIT.usage);
      const tool = command === 'select' ? 'tabs_select' : 'tabs_activate';
      const r = (await callTool(tool, { tabId })) as { tab: { title: string; url: string } };
      emit(r, (v: typeof r) => `✓ ${v.tab.title}  ${v.tab.url}`);
      return;
    }

    case 'snapshot': {
      const r = (await callTool('page_snapshot', {
        ...tabArg(flags),
        includeStructure: flags.structure === true,
        maxChars: max(20_000) || 200_000,
      })) as {
        snapshot: string;
        refCount: number;
        hiddenCount: number;
        totalChars?: number;
        truncated: boolean;
      };
      emit(
        r,
        (v: typeof r) =>
          `${v.snapshot}\n\n${v.refCount} 个可操作元素（滤掉 ${v.hiddenCount} 个不可见）`,
      );
      warnTruncated(r.truncated, r.totalChars);
      return;
    }

    case 'text': {
      const limit = max(2_000);
      const r = (await callTool('page_text', {
        ...tabArg(flags),
        ...(typeof flags.css === 'string' ? { selector: flags.css } : {}),
        maxChars: limit === 0 ? 200_000 : limit,
      })) as { text: string; totalChars?: number; truncated: boolean };
      emit(r, (v: typeof r) => v.text);
      warnTruncated(r.truncated, r.totalChars);
      return;
    }

    case 'query': {
      const selector = positional[0];
      if (!selector) die('用法: bx query <选择器>', EXIT.usage);
      const r = (await callTool('page_query', {
        ...tabArg(flags),
        selector,
        limit: num(flags.limit, 20),
      })) as { matches: { tag: string; text: string }[]; total: number };
      emit(
        r,
        (v: typeof r) =>
          `${v.matches.map((m) => `<${m.tag}> ${m.text}`).join('\n')}\n共 ${v.total} 个匹配`,
      );
      return;
    }

    case 'click': {
      const ref = positional[0];
      const css = typeof flags.css === 'string' ? flags.css : undefined;
      if (!ref && !css) die('用法: bx click <ref>  或  bx click --css <选择器>', EXIT.usage);
      const r = (await callTool('page_click', {
        ...tabArg(flags),
        ...(ref ? { ref } : {}),
        ...(css ? { selector: css } : {}),
      })) as { tag: string; text: string };
      emit(r, (v: typeof r) => `✓ <${v.tag}> ${v.text}`);
      return;
    }

    case 'fill': {
      const css = typeof flags.css === 'string' ? flags.css : undefined;
      const ref = css ? undefined : positional[0];
      const value = css ? positional[0] : positional[1];
      if (value === undefined)
        die('用法: bx fill <ref> <值>  或  bx fill --css <选择器> <值>', EXIT.usage);
      const r = (await callTool('page_fill', {
        ...tabArg(flags),
        ...(ref ? { ref } : {}),
        ...(css ? { selector: css } : {}),
        value,
      })) as { tag: string };
      emit(r, (v: typeof r) => `✓ 已填入 <${v.tag}>`);
      return;
    }

    case 'nav': {
      const url = positional[0];
      if (!url) die('用法: bx nav <url>', EXIT.usage);
      const r = (await callTool('page_navigate', { ...tabArg(flags), url })) as {
        tab: { title: string; url: string };
      };
      emit(r, (v: typeof r) => `✓ ${v.tab.title}  ${v.tab.url}`);
      return;
    }

    case 'eval': {
      const expression = positional[0];
      if (!expression) die('用法: bx eval <表达式>', EXIT.usage);
      const r = (await callTool('page_eval', { ...tabArg(flags), expression })) as {
        value: unknown;
      };
      emit(r, (v: typeof r) => JSON.stringify(v.value, null, 2));
      return;
    }

    case 'net': {
      const sub = positional[0];
      if (sub === 'start') {
        await callTool('network_start', tabArg(flags));
        out('✓ 已开始录制网络请求（用完记得 bx net stop）');
        return;
      }
      if (sub === 'stop') {
        const r = (await callTool('network_stop', {
          ...tabArg(flags),
          clear: flags.clear === true,
        })) as { kept: number };
        emit(r, (v: typeof r) => `✓ 已停止录制，保留 ${v.kept} 条记录`);
        return;
      }
      if (sub === 'list') {
        const r = (await callTool('network_list', {
          ...tabArg(flags),
          offset: num(flags.offset, 0),
          limit: num(flags.limit, 30),
          ...(typeof flags.url === 'string' ? { urlContains: flags.url } : {}),
          ...(typeof flags.method === 'string' ? { method: flags.method } : {}),
          onlyApi: flags.api === true,
          onlyFailed: flags.failed === true,
        })) as {
          total: number;
          offset: number;
          entries: {
            requestId: string;
            method: string;
            url: string;
            status: number | null;
            bytes: number | null;
          }[];
        };
        emit(r, (v: typeof r) => {
          const rows = v.entries.map(
            (e) =>
              `${e.requestId.padEnd(14)} ${e.method.padEnd(5)} ${String(e.status ?? '-').padEnd(4)} ${String(e.bytes ?? '-').padStart(8)}B  ${e.url.slice(0, 90)}`,
          );
          const shown = v.offset + v.entries.length;
          const more =
            shown < v.total ? `（还有 ${v.total - shown} 条，用 --offset ${shown}）` : '';
          return `${rows.join('\n')}\n共 ${v.total} 条${more}`;
        });
        return;
      }
      if (sub === 'body') {
        const requestId = positional[1];
        if (!requestId) die('用法: bx net body <requestId>', EXIT.usage);
        const limit = max(2_000);
        const r = (await callTool('network_body', {
          ...tabArg(flags),
          requestId,
          offset: num(flags.offset, 0),
          maxChars: limit === 0 ? 100_000 : limit,
          includeHeaders: flags.headers === true,
        })) as {
          method: string;
          url: string;
          status: number | null;
          mimeType: string | null;
          postData: string | null;
          chunk: string;
          totalChars: number;
          offset: number;
          truncated: boolean;
        };
        emit(r, (v: typeof r) => {
          const head = `${v.method} ${v.status ?? '-'} ${v.mimeType ?? ''}\n${v.url}`;
          const post = v.postData ? `\n--- 请求体 ---\n${v.postData}` : '';
          return `${head}${post}\n--- 响应体 (${v.offset}..${v.offset + v.chunk.length} / ${v.totalChars}) ---\n${v.chunk}`;
        });
        if (r.truncated) {
          process.stderr.write(
            `（还有 ${r.totalChars - r.offset - r.chunk.length} 字符，用 --offset ${r.offset + r.chunk.length} 继续）\n`,
          );
        }
        return;
      }
      die('用法: bx net start|list|body|stop', EXIT.usage);
      return;
    }

    case 'status': {
      const r = (await callTool('browser_status', {})) as {
        connected: boolean;
        selectedTabId: number | null;
        extensionVersion: string | null;
      };
      emit(r, (v: typeof r) =>
        v.connected
          ? `✓ 插件已连接 (v${v.extensionVersion})　选中标签页: ${v.selectedTabId ?? '无'}`
          : '✗ 插件未连接 —— 去 chrome://extensions 加载已解压的扩展程序',
      );
      if (!r.connected) process.exit(EXIT.noExtension);
      return;
    }

    case 'history': {
      const r = (await callTool('history_query', {
        ...(flags.tab === undefined ? {} : { tabId: num(flags.tab, 0) }),
        limit: num(flags.limit, 20),
        onlyErrors: flags.errors === true,
      })) as {
        entries: {
          at: string;
          action: string;
          ok: boolean;
          durationMs: number;
          summary?: string;
        }[];
      };
      emit(r, (v: typeof r) =>
        v.entries
          .map(
            (e) =>
              `${e.at.slice(11, 19)} ${e.ok ? '✓' : '✗'} ${e.action.padEnd(15)} ${String(e.durationMs).padStart(5)}ms  ${e.summary ?? ''}`,
          )
          .join('\n'),
      );
      return;
    }

    case 'daemon': {
      const sub = positional[0];
      if (sub === 'stop') {
        try {
          await fetch(`${BASE}/healthz`);
        } catch {
          out('守护进程本来就没在跑');
          return;
        }
        // 没有专门的关停接口，直接按端口找进程
        spawn('sh', ['-c', `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | xargs -r kill`], {
          stdio: 'ignore',
        }).unref();
        out('✓ 已请求停止守护进程');
        return;
      }
      out((await healthy()) ? `✓ 守护进程在跑 ${BASE}` : '✗ 守护进程没在跑');
      return;
    }

    default:
      die(`未知命令: ${command}\n\n${HELP}`, EXIT.usage);
  }
}

main().catch((cause: unknown) => {
  die(cause instanceof Error ? cause.message : String(cause), EXIT.other);
});
