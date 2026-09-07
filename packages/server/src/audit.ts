import { Buffer } from 'node:buffer';
import { appendFile, mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  at: string;
  action: string;
  tabId: number | null;
  params: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
  summary?: string;
}

export interface AuditQuery {
  tabId?: number | undefined;
  since?: string | undefined;
  onlyErrors?: boolean | undefined;
  limit: number;
}

/** 超过这个大小就轮转一次，避免无限增长把磁盘吃满。 */
const MAX_BYTES = 5 * 1024 * 1024;
/** 查询时最多回读的尾部字节数，防止历史文件很大时把内存打爆。 */
const TAIL_BYTES = 2 * 1024 * 1024;

/**
 * 会被隐去的字段。**这些内容是永久落盘的**，而 `page.fill` 的 value 完全可能是密码，
 * 记全文等于把用户的凭据写进一个明文文件。只记长度足够回答"这里填过东西"。
 */
const REDACTED_FIELDS = new Set(['value', 'token', 'password']);
const MAX_PARAM_CHARS = 200;

export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && REDACTED_FIELDS.has(key)) {
      out[key] = `«已隐去 ${value.length} 字符»`;
      continue;
    }
    if (typeof value === 'string' && value.length > MAX_PARAM_CHARS) {
      out[key] = `${value.slice(0, MAX_PARAM_CHARS)}…`;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * 结果只留一句话。快照动辄几万字符，原样落盘既没人看也会让文件迅速膨胀 ——
 * 审计要回答的是"做了什么、成没成"，不是"返回了什么内容"。
 */
export function summarizeResult(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const record = result as Record<string, unknown>;

  if (typeof record.snapshot === 'string') {
    const refCount = typeof record.refCount === 'number' ? record.refCount : 0;
    return `快照 ${record.snapshot.length} 字符 / ${refCount} 个 ref`;
  }
  // tag 必须排在 text 前面：click / fill 返回的是 { tag, text }，
  // 先判 text 会把"点了哪个按钮"误记成"正文 N 字符"。
  if (typeof record.tag === 'string') {
    return typeof record.text === 'string' ? `<${record.tag}> ${record.text}` : `<${record.tag}>`;
  }
  if (typeof record.text === 'string') return `正文 ${record.text.length} 字符`;
  if (Array.isArray(record.tabs)) return `${record.tabs.length} 个标签页`;
  if (Array.isArray(record.matches)) return `命中 ${record.matches.length} 个元素`;
  if (typeof record.tab === 'object' && record.tab !== null) {
    const tab = record.tab as { title?: unknown; url?: unknown };
    return `${typeof tab.title === 'string' ? tab.title : '?'} — ${typeof tab.url === 'string' ? tab.url : '?'}`;
  }

  const json = JSON.stringify(result);
  return json.length > MAX_PARAM_CHARS ? `${json.slice(0, MAX_PARAM_CHARS)}…` : json;
}

export class AuditLog {
  readonly #file: string;
  readonly #enabled: boolean;

  constructor(file: string, enabled: boolean) {
    this.#file = file;
    this.#enabled = enabled;
  }

  get file(): string {
    return this.#file;
  }

  /** 写审计失败绝不能让动作本身失败 —— 调用方一律 fire-and-forget。 */
  async append(entry: AuditEntry): Promise<void> {
    if (!this.#enabled) return;
    try {
      await mkdir(dirname(this.#file), { recursive: true });
      await this.#rotateIfNeeded();
      // O_APPEND 的单次小写入是原子的，并发动作不会互相截断
      await appendFile(this.#file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 磁盘满、权限不足等一律吞掉
    }
  }

  async query(options: AuditQuery): Promise<AuditEntry[]> {
    if (!this.#enabled) return [];
    const lines = await this.#readTail();
    const entries: AuditEntry[] = [];

    for (const line of lines) {
      let parsed: AuditEntry;
      try {
        parsed = JSON.parse(line) as AuditEntry;
      } catch {
        continue; // 轮转或崩溃可能留下半行，跳过即可
      }
      if (options.tabId !== undefined && parsed.tabId !== options.tabId) continue;
      if (options.onlyErrors && parsed.ok) continue;
      if (options.since !== undefined && parsed.at < options.since) continue;
      entries.push(parsed);
    }
    return entries.slice(-options.limit);
  }

  async #rotateIfNeeded(): Promise<void> {
    try {
      const { size } = await stat(this.#file);
      if (size < MAX_BYTES) return;
      await rename(this.#file, `${this.#file}.1`);
    } catch {
      // 文件还不存在，不用轮转
    }
  }

  async #readTail(): Promise<string[]> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.#file, 'r');
    } catch {
      return []; // 还没写过任何一条
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      // 从中间截断时首行多半是残缺的
      if (start > 0) lines.shift();
      return lines.filter((line) => line.trim() !== '');
    } finally {
      await handle.close();
    }
  }
}
