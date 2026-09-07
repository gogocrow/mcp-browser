export type DiagEvent =
  | 'sw_start'
  | 'alarm_fire'
  | 'alarm_created'
  | 'ws_open'
  | 'ws_close'
  | 'ws_error'
  | 'reconnect_scheduled'
  | 'stale_detected'
  | 'ensure_check'
  | 'manual_restart';

interface DiagEntry {
  at: string;
  event: DiagEvent;
  detail?: string;
}

const KEY = 'diagLog';
const MAX = 60;

/**
 * 跨 service worker 重启存活的事件日志。
 *
 * 用 storage.local 而不是 session/内存：要诊断的恰恰是「SW 被回收之后发生了什么」，
 * 任何随 SW 消失的记录方式都看不到那段。断线期间也照样写得进去。
 */
export async function record(event: DiagEvent, detail?: string): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const log = Array.isArray(stored[KEY]) ? (stored[KEY] as DiagEntry[]) : [];
    log.push(
      detail === undefined
        ? { at: new Date().toISOString(), event }
        : { at: new Date().toISOString(), event, detail },
    );
    await chrome.storage.local.set({ [KEY]: log.slice(-MAX) });
  } catch {
    // 诊断日志写失败绝不能影响正常功能
  }
}

export async function readLog(): Promise<DiagEntry[]> {
  const stored = await chrome.storage.local.get(KEY);
  return Array.isArray(stored[KEY]) ? (stored[KEY] as DiagEntry[]) : [];
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
