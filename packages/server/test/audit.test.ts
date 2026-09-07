import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AuditEntry, AuditLog, redactParams, summarizeResult } from '../src/audit.ts';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audit-'));
  file = join(dir, 'audit.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: '2026-09-05T00:00:00.000Z',
    action: 'page.click',
    tabId: 1,
    params: {},
    ok: true,
    durationMs: 10,
    ...overrides,
  };
}

describe('参数脱敏', () => {
  it('隐去填入的值，只留长度 —— 它可能是密码且会永久落盘', () => {
    const out = redactParams({ selector: '#pw', value: 'hunter2' });
    expect(out.value).toBe('«已隐去 7 字符»');
    expect(out.selector).toBe('#pw');
  });

  it('过长的字符串截断，避免整段脚本写进日志', () => {
    const out = redactParams({ expression: 'x'.repeat(500) });
    expect(String(out.expression)).toHaveLength(201); // 200 + 省略号
  });

  it('非字符串字段原样保留', () => {
    expect(redactParams({ tabId: 42, includeStructure: true })).toEqual({
      tabId: 42,
      includeStructure: true,
    });
  });
});

describe('结果摘要', () => {
  it('快照只记体积和 ref 数，不记内容', () => {
    const summary = summarizeResult({ snapshot: 'x'.repeat(9000), refCount: 234 });
    expect(summary).toBe('快照 9000 字符 / 234 个 ref');
    expect(summary).not.toContain('xxx');
  });

  it('各类结果都有一句话摘要', () => {
    expect(summarizeResult({ text: 'abc' })).toBe('正文 3 字符');
    expect(summarizeResult({ tabs: [1, 2, 3] })).toBe('3 个标签页');
    expect(summarizeResult({ matches: [1, 2] })).toBe('命中 2 个元素');
    expect(summarizeResult({ tag: 'button', text: '确定' })).toBe('<button> 确定');
    expect(summarizeResult({ tab: { title: '首页', url: 'https://a.test/' } })).toBe(
      '首页 — https://a.test/',
    );
  });
});

describe('审计日志读写', () => {
  it('写进去能查出来', async () => {
    const log = new AuditLog(file, true);
    await log.append(entry({ action: 'tabs.list' }));
    await log.append(entry({ action: 'page.click' }));

    const entries = await log.query({ limit: 50 });
    expect(entries.map((e) => e.action)).toEqual(['tabs.list', 'page.click']);
  });

  it('文件是逐行 JSON，可以直接 grep / jq', async () => {
    const log = new AuditLog(file, true);
    await log.append(entry());
    const raw = await readFile(file, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw.trim()).action).toBe('page.click');
  });

  it('按标签页过滤', async () => {
    const log = new AuditLog(file, true);
    await log.append(entry({ tabId: 1 }));
    await log.append(entry({ tabId: 2 }));
    expect(await log.query({ tabId: 2, limit: 50 })).toHaveLength(1);
  });

  it('只看失败的操作', async () => {
    const log = new AuditLog(file, true);
    await log.append(entry({ ok: true }));
    await log.append(entry({ ok: false, errorCode: 'ERR_NO_TAB' }));
    const failures = await log.query({ onlyErrors: true, limit: 50 });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorCode).toBe('ERR_NO_TAB');
  });

  it('按时间过滤', async () => {
    const log = new AuditLog(file, true);
    await log.append(entry({ at: '2026-09-05T00:00:00.000Z' }));
    await log.append(entry({ at: '2026-09-05T10:00:00.000Z' }));
    const recent = await log.query({ since: '2026-09-05T05:00:00.000Z', limit: 50 });
    expect(recent).toHaveLength(1);
  });

  it('limit 取最近的若干条', async () => {
    const log = new AuditLog(file, true);
    for (let i = 0; i < 5; i++) await log.append(entry({ durationMs: i }));
    const entries = await log.query({ limit: 2 });
    expect(entries.map((e) => e.durationMs)).toEqual([3, 4]);
  });

  it('文件还不存在时查询返回空而不是报错', async () => {
    expect(await new AuditLog(file, true).query({ limit: 50 })).toEqual([]);
  });

  it('半行残留（崩溃或轮转留下的）被跳过，不影响其余记录', async () => {
    const log = new AuditLog(file, true);
    await log.append(entry({ action: 'tabs.list' }));
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, '{"截断的半行\n', 'utf8');
    await log.append(entry({ action: 'page.click' }));

    const entries = await log.query({ limit: 50 });
    expect(entries.map((e) => e.action)).toEqual(['tabs.list', 'page.click']);
  });

  it('关闭时不写文件也不报错', async () => {
    const log = new AuditLog(file, false);
    await log.append(entry());
    expect(await log.query({ limit: 50 })).toEqual([]);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});
