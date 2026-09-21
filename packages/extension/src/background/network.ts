import { BridgeError } from '@browser-mcp/shared';
import { ensureAttached, send } from './cdp.ts';

export interface NetEntry {
  requestId: string;
  method: string;
  url: string;
  type: string | null;
  status: number | null;
  mimeType: string | null;
  bytes: number | null;
  durationMs: number | null;
  failed: string | null;
  postData: string | null;
  /** 请求确实带了体，但可能因超过 maxPostDataSize 而没内联进事件 */
  hasPostData: boolean;
  requestHeaders: Record<string, string> | null;
  responseHeaders: Record<string, string> | null;
  startedAt: number;
}

/**
 * 每个标签页保留的最大条数。一个重页面几秒就能打出上百个请求（实测 QQ 音乐首页 113 个），
 * 不设上限的话 service worker 的内存会被慢慢吃光。
 */
const MAX_ENTRIES = 1000;

const recording = new Set<number>();
const buffers = new Map<number, NetEntry[]>();

function bufferFor(tabId: number): NetEntry[] {
  let buffer = buffers.get(tabId);
  if (!buffer) {
    buffer = [];
    buffers.set(tabId, buffer);
  }
  return buffer;
}

function findEntry(tabId: number, requestId: string): NetEntry | undefined {
  return buffers.get(tabId)?.find((e) => e.requestId === requestId);
}

/**
 * CDP 事件是**推送**的，而本项目的协议是请求-应答。所以这里把事件收进环形缓冲区，
 * 由 network.list 轮询取走 —— 不用为了网络监听给协议加一种推送消息。
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || !recording.has(tabId)) return;
  const payload = params as Record<string, unknown> | undefined;
  if (!payload) return;

  const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
  if (!requestId) return;

  if (method === 'Network.requestWillBeSent') {
    const request = payload.request as
      | {
          method?: string;
          url?: string;
          postData?: string;
          hasPostData?: boolean;
          headers?: Record<string, string>;
        }
      | undefined;
    const buffer = bufferFor(tabId);
    buffer.push({
      requestId,
      method: request?.method ?? '?',
      url: request?.url ?? '',
      type: typeof payload.type === 'string' ? payload.type : null,
      status: null,
      mimeType: null,
      bytes: null,
      durationMs: null,
      failed: null,
      postData: request?.postData ?? null,
      hasPostData: request?.hasPostData === true || typeof request?.postData === 'string',
      requestHeaders: request?.headers ?? null,
      responseHeaders: null,
      startedAt: Date.now(),
    });
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
    return;
  }

  const entry = findEntry(tabId, requestId);
  if (!entry) return;

  if (method === 'Network.responseReceived') {
    const response = payload.response as
      | { status?: number; mimeType?: string; headers?: Record<string, string> }
      | undefined;
    entry.status = response?.status ?? null;
    entry.mimeType = response?.mimeType ?? null;
    entry.responseHeaders = response?.headers ?? null;
    if (typeof payload.type === 'string') entry.type = payload.type;
    return;
  }

  if (method === 'Network.loadingFinished') {
    entry.bytes = typeof payload.encodedDataLength === 'number' ? payload.encodedDataLength : null;
    entry.durationMs = Date.now() - entry.startedAt;
    return;
  }

  if (method === 'Network.loadingFailed') {
    entry.failed = typeof payload.errorText === 'string' ? payload.errorText : '请求失败';
    entry.durationMs = Date.now() - entry.startedAt;
  }
});

export async function startRecording(tabId: number): Promise<{ cleared: number }> {
  await ensureAttached(tabId);
  const cleared = buffers.get(tabId)?.length ?? 0;
  buffers.set(tabId, []);
  // maxPostDataSize 不设的话 requestWillBeSent 里根本不带 postData，POST 请求体就永远看不到
  await send(tabId, 'Network.enable', {
    maxTotalBufferSize: 10_000_000,
    maxResourceBufferSize: 5_000_000,
    maxPostDataSize: 65_536,
  });
  recording.add(tabId);
  return { cleared };
}

export async function stopRecording(tabId: number, clear: boolean): Promise<{ kept: number }> {
  recording.delete(tabId);
  try {
    await send(tabId, 'Network.disable');
  } catch {
    // 标签页可能已经关了，停录本身不该失败
  }
  if (clear) buffers.delete(tabId);
  return { kept: buffers.get(tabId)?.length ?? 0 };
}

export function isRecording(tabId: number): boolean {
  return recording.has(tabId);
}

export interface ListOptions {
  offset: number;
  limit: number;
  urlContains?: string | undefined;
  method?: string | undefined;
  onlyApi: boolean;
  onlyFailed: boolean;
}

export function listEntries(tabId: number, options: ListOptions) {
  const all = buffers.get(tabId) ?? [];
  const filtered = all.filter((e) => {
    if (options.urlContains && !e.url.includes(options.urlContains)) return false;
    if (options.method && e.method.toUpperCase() !== options.method.toUpperCase()) return false;
    if (options.onlyApi && e.type !== 'XHR' && e.type !== 'Fetch') return false;
    if (
      options.onlyFailed &&
      !e.failed &&
      (e.status === null || (e.status >= 200 && e.status < 300))
    )
      return false;
    return true;
  });

  return {
    recording: recording.has(tabId),
    total: filtered.length,
    offset: options.offset,
    entries: filtered.slice(options.offset, options.offset + options.limit).map((e) => ({
      requestId: e.requestId,
      method: e.method,
      url: e.url,
      status: e.status,
      type: e.type,
      bytes: e.bytes,
      durationMs: e.durationMs,
      failed: e.failed,
    })),
  };
}

export async function getBody(
  tabId: number,
  requestId: string,
  offset: number,
  maxChars: number,
  includeHeaders: boolean,
) {
  const entry = findEntry(tabId, requestId);
  if (!entry) {
    throw new BridgeError(
      'ERR_ELEMENT_NOT_FOUND',
      `没有 requestId=${requestId} 的记录。它可能早于本次录制，或已被缓冲区挤掉`,
    );
  }

  // requestWillBeSent 只内联 maxPostDataSize 以内的请求体（实测 100KB 的 POST 就拿不到），
  // 超出的要单独取一次。这条不能省，否则大 body 的接口调试就是瞎的。
  let postData = entry.postData;
  if (postData === null && entry.hasPostData) {
    try {
      const r = await send<{ postData?: string }>(tabId, 'Network.getRequestPostData', {
        requestId,
      });
      postData = r.postData ?? null;
    } catch {
      postData = null; // 浏览器已释放，只能作罢
    }
  }

  // 请求体同样要截断。响应体有分页保护而请求体没有的话，一次文件上传就能把调用方的
  // 上下文冲垮 —— 同一个接口里两种待遇是设计漏洞。
  const postDataTotalChars = postData?.length ?? 0;
  if (postData !== null && postData.length > maxChars) postData = postData.slice(0, maxChars);

  let body = '';
  let base64Encoded = false;
  try {
    const result = await send<{ body?: string; base64Encoded?: boolean }>(
      tabId,
      'Network.getResponseBody',
      { requestId },
    );
    body = result.body ?? '';
    base64Encoded = result.base64Encoded ?? false;
  } catch (cause) {
    // 浏览器只在有限时间内保留响应体，导航或缓冲区淘汰后就取不到了 —— 这不是 bug
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new BridgeError(
      'ERR_SCRIPT_FAILED',
      `取不到响应体（浏览器可能已释放）：${message}。摘要信息仍可用 network.list 查看`,
    );
  }

  const chunk = body.slice(offset, offset + maxChars);
  return {
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    mimeType: entry.mimeType,
    postData,
    postDataTotalChars,
    requestHeaders: includeHeaders ? entry.requestHeaders : null,
    responseHeaders: includeHeaders ? entry.responseHeaders : null,
    base64Encoded,
    totalChars: body.length,
    offset,
    chunk,
    truncated: offset + chunk.length < body.length,
  };
}

// 标签页关闭后缓冲区没有任何意义，留着只是漏内存
chrome.tabs.onRemoved.addListener((tabId) => {
  recording.delete(tabId);
  buffers.delete(tabId);
});
