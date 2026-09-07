import { randomUUID } from 'node:crypto';
import {
  ACTIONS,
  type ActionDef,
  type ActionInput,
  type ActionName,
  type ActionOutput,
  BridgeError,
  PROTOCOL_VERSION,
  type RequestMessage,
  ServerBoundMessage,
} from '@browser-mcp/shared';
import type { RawData, WebSocket } from 'ws';
import { log } from './logger.ts';

/**
 * MV3 的 service worker 空闲约 30s 就会被回收，而 WebSocket 上的收发会重置这个计时器。
 * 心跳间隔必须明显小于 30s，否则插件会在空闲时被杀掉、连接静默断开。
 */
const HEARTBEAT_MS = 20_000;

/**
 * 必须是 type 而不是 interface：MCP 的 structuredContent 要求 `Record<string, unknown>`，
 * 而 interface 拿不到隐式索引签名，换成 interface 会直接编译不过。
 */
export type BridgeStatus = {
  connected: boolean;
  extensionVersion: string | null;
  userAgent: string | null;
  connectedAt: string | null;
  pending: number;
};

interface Pending {
  action: ActionName;
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: NodeJS.Timeout;
}

/**
 * 服务端侧的桥。**同一时刻只保留一条插件连接** —— 浏览器里装着的就一个插件实例，
 * 允许多条只会让"请求发给了哪个"变得不确定。新连接顶掉旧连接。
 */
export class BridgeHub {
  #socket: WebSocket | null = null;
  #hello: { extensionVersion: string; userAgent: string } | null = null;
  #connectedAt: Date | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;
  readonly #onDetach: (() => void) | undefined;

  constructor(timeoutMs: number, onDetach?: () => void) {
    this.#timeoutMs = timeoutMs;
    this.#onDetach = onDetach;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#hello !== null;
  }

  status(): BridgeStatus {
    return {
      connected: this.connected,
      extensionVersion: this.#hello?.extensionVersion ?? null,
      userAgent: this.#hello?.userAgent ?? null,
      connectedAt: this.#connectedAt?.toISOString() ?? null,
      pending: this.#pending.size,
    };
  }

  attach(socket: WebSocket): void {
    if (this.#socket) {
      log.warn('已有插件连接，用新连接替换旧连接');
      this.#detach(new BridgeError('ERR_DISCONNECTED', '插件连接被新连接替换'));
    }

    this.#socket = socket;
    this.#hello = null;
    this.#connectedAt = new Date();

    socket.on('message', (data: RawData) => this.#onMessage(data));
    socket.on('close', (code, reason) => {
      if (socket !== this.#socket) return; // 被顶掉的旧连接，状态早已交给新连接
      log.info('插件连接关闭', { code, reason: reason.toString() });
      this.#detach(new BridgeError('ERR_DISCONNECTED', '插件连接已关闭'));
    });
    // ws 对没有监听器的 'error' 会直接 throw，进而崩掉整个服务进程
    socket.on('error', (error: Error) => log.error('插件连接出错', { message: error.message }));

    this.#heartbeat = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ping', ts: Date.now() }));
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  async call<K extends ActionName>(action: K, input: ActionInput<K>): Promise<ActionOutput<K>> {
    const socket = this.#socket;
    if (!socket || !this.#hello) {
      throw new BridgeError(
        'ERR_NO_EXTENSION',
        '浏览器插件未连接：请确认 Chrome 已加载插件、且插件图标显示为已连接',
      );
    }

    const def: ActionDef = ACTIONS[action];
    const parsedInput = def.input.safeParse(input);
    if (!parsedInput.success) {
      throw new BridgeError('ERR_INVALID_PAYLOAD', `动作 ${action} 的参数不合法`, {
        issues: parsedInput.error.issues,
      });
    }

    const id = randomUUID();
    const message: RequestMessage = {
      v: PROTOCOL_VERSION,
      kind: 'request',
      id,
      action,
      payload: parsedInput.data,
    };

    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError('ERR_TIMEOUT', `动作 ${action} 超过 ${this.#timeoutMs}ms 仍无回执`));
      }, this.#timeoutMs);
      timer.unref();

      this.#pending.set(id, { action, resolve, reject, timer });

      socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        reject(new BridgeError('ERR_DISCONNECTED', `下发失败：${error.message}`));
      });
    });

    // 插件是独立部署的、版本可能比服务端旧，回执一律当作不可信输入重新校验
    const parsedOutput = def.output.safeParse(raw);
    if (!parsedOutput.success) {
      throw new BridgeError('ERR_INVALID_RESULT', `动作 ${action} 的返回值不符合约定`, {
        issues: parsedOutput.error.issues,
      });
    }
    return parsedOutput.data as ActionOutput<K>;
  }

  #detach(reason: BridgeError): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    const previous = this.#socket;
    this.#socket = null;
    this.#hello = null;
    this.#connectedAt = null;

    // 必须主动关掉被顶下来的旧连接。不关的话插件那侧收不到任何事件、也不再收到心跳，
    // 只能等它自己的判活超时才恢复（实测约 72 秒）。关掉则是秒级重连。
    // 对已经关闭的 socket 再调一次是空操作，走 close 事件那条路径也安全。
    previous?.close(4000, 'replaced');

    this.#failAllPending(reason);
    this.#onDetach?.();
  }

  /** 连接消失时必须清空在途请求，否则调用方会一直挂到超时，且 Map 只增不减。 */
  #failAllPending(reason: BridgeError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #onMessage(data: RawData): void {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      log.warn('收到非 JSON 消息，已丢弃');
      return;
    }

    const parsed = ServerBoundMessage.safeParse(json);
    if (!parsed.success) {
      log.warn('收到不符合协议的消息，已丢弃', { issues: parsed.error.issues });
      return;
    }

    const message = parsed.data;
    if (message.kind === 'hello') {
      this.#hello = {
        extensionVersion: message.extensionVersion,
        userAgent: message.userAgent,
      };
      log.info('插件握手完成', { extensionVersion: message.extensionVersion });
      return;
    }
    if (message.kind === 'pong') return;

    const pending = this.#pending.get(message.id);
    if (!pending) {
      log.warn('收到未知 id 的回执（多半已超时被清理）', { id: message.id });
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.ok) pending.resolve(message.result);
    else pending.reject(BridgeError.from(message.error));
  }
}
