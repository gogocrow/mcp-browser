import {
  ClientBoundMessage,
  type PongMessage,
  PROTOCOL_VERSION,
  type RequestMessage,
  type ResponseMessage,
} from '@browser-mcp/shared';
import { backoffDelay } from './backoff.ts';
import type { ConnectionState } from './badge.ts';
import { record } from './diag.ts';
import { endpointOf, readSettings } from './settings.ts';

export interface ConnectionHandlers {
  onRequest: (message: RequestMessage) => void;
  onState: (state: ConnectionState) => void;
}

/**
 * 多久没收到任何消息就判定连接已死。服务端每 20s 发一次 ping，取 3 倍留足余量。
 *
 * 这是**纵深防御**，不是在修某个已知 bug：真实网络里半开连接确实存在（笔记本睡眠、
 * 切网、NAT 超时），这些情况下 close 事件不保证会来，只看 `readyState` 会一直以为还连着。
 *
 * 别把它当成"断线不重连"的解药 —— 那个问题的真凶在服务端关闭流程（见 server/src/index.ts
 * 的信号处理）：僵尸进程仍在正常发心跳，连接是真活着的，判活自然也测不出来。
 */
const STALE_AFTER_MS = 60_000;

export class BridgeConnection {
  #ws: WebSocket | null = null;
  #endpoint: string | null = null;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastMessageAt = 0;
  readonly #handlers: ConnectionHandlers;

  constructor(handlers: ConnectionHandlers) {
    this.#handlers = handlers;
  }

  get isLive(): boolean {
    const state = this.#ws?.readyState;
    return state === WebSocket.OPEN || state === WebSocket.CONNECTING;
  }

  /** 半开连接：自称 OPEN，但已经很久没收到过服务端的任何字节。 */
  get isStale(): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    return Date.now() - this.#lastMessageAt > STALE_AFTER_MS;
  }

  async start(): Promise<void> {
    this.#endpoint = endpointOf(await readSettings());
    this.#open();
  }

  /**
   * alarm 每分钟调一次，兼作连接体检：
   * 先查半开（自称活着其实已死），再查真的没连上。
   */
  async ensure(): Promise<void> {
    // 把判断依据本身记下来。上一轮就是因为只记了"做了什么"、没记"看到了什么"，
    // 导致 ensure() 每次提前返回却查不出是哪个分支。
    const state = this.#ws === null ? 'null' : String(this.#ws.readyState);
    const idle =
      this.#lastMessageAt === 0
        ? 'never'
        : `${Math.round((Date.now() - this.#lastMessageAt) / 1000)}s`;
    void record('ensure_check', `readyState=${state} idle=${idle}`);

    if (this.isStale) {
      void record(
        'stale_detected',
        `${Math.round((Date.now() - this.#lastMessageAt) / 1000)}s 没收到消息`,
      );
      await this.restart();
      return;
    }
    if (this.isLive) return;
    await this.start();
  }

  /** 改了设置或用户手动点重连：立刻重来并清零退避，不要让用户等 30 秒。 */
  async restart(): Promise<void> {
    this.#clearTimer();
    this.#attempt = 0;
    const previous = this.#ws;
    this.#ws = null;
    previous?.close(1000, 'restart');
    await this.start();
  }

  send(message: ResponseMessage | PongMessage): void {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(message));
  }

  #open(): void {
    const endpoint = this.#endpoint;
    if (!endpoint) return;

    this.#handlers.onState('connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(endpoint);
    } catch {
      // 地址非法（用户填错）也走退避重试，否则要重装插件才能恢复
      this.#handlers.onState('disconnected');
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.addEventListener('open', () => {
      void record('ws_open');
      this.#lastMessageAt = Date.now();
      this.#attempt = 0;
      this.#handlers.onState('connected');
      ws.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          kind: 'hello',
          extensionVersion: chrome.runtime.getManifest().version,
          userAgent: navigator.userAgent,
        }),
      );
    });

    ws.addEventListener('message', (event: MessageEvent) => this.#onMessage(event));

    ws.addEventListener('close', () => {
      if (this.#ws !== ws) return; // 已被 restart 顶掉的旧连接，别干扰新连接
      void record('ws_close');
      this.#ws = null;
      this.#handlers.onState('disconnected');
      this.#scheduleReconnect();
    });

    // error 之后必定跟一个 close，重连只在 close 里做，避免排两次
    ws.addEventListener('error', () => {});
  }

  #onMessage(event: MessageEvent): void {
    // 心跳 ping 也算 —— 判活看的是"还能收到字节"，不关心内容
    this.#lastMessageAt = Date.now();
    let json: unknown;
    try {
      json = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = ClientBoundMessage.safeParse(json);
    if (!parsed.success) return;

    const message = parsed.data;
    if (message.kind === 'ping') {
      this.send({ v: PROTOCOL_VERSION, kind: 'pong', ts: Date.now() });
      return;
    }
    this.#handlers.onRequest(message);
  }

  #scheduleReconnect(): void {
    this.#clearTimer();
    const delay = backoffDelay(this.#attempt);
    void record('reconnect_scheduled', `第 ${this.#attempt + 1} 次，${delay}ms 后`);
    this.#attempt += 1;
    this.#timer = setTimeout(() => this.#open(), delay);
  }

  #clearTimer(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
