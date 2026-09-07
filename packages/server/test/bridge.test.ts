import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { PROTOCOL_VERSION } from '@browser-mcp/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { BridgeHub } from '../src/bridge.ts';

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(code = 1000, reason = ''): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  deliver(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }

  hello(): void {
    this.deliver({
      v: PROTOCOL_VERSION,
      kind: 'hello',
      extensionVersion: '0.1.0',
      userAgent: 'test',
    });
  }

  /** 取出最近一次下发的 request 的 id —— 回执必须带同一个 id 才能配对 */
  lastRequestId(): string {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error('没有下发过任何消息');
    return (JSON.parse(raw) as { id: string }).id;
  }
}

function connectedHub(timeoutMs = 1000): { hub: BridgeHub; socket: FakeSocket } {
  const hub = new BridgeHub(timeoutMs);
  const socket = new FakeSocket();
  hub.attach(socket.asWebSocket());
  socket.hello();
  return { hub, socket };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BridgeHub 握手', () => {
  it('只有收到 hello 之后才算连上', () => {
    const hub = new BridgeHub(1000);
    const socket = new FakeSocket();
    hub.attach(socket.asWebSocket());
    expect(hub.connected).toBe(false);
    socket.hello();
    expect(hub.connected).toBe(true);
    expect(hub.status().extensionVersion).toBe('0.1.0');
  });

  it('插件没连时调用动作直接失败，而不是排队等待', async () => {
    const hub = new BridgeHub(1000);
    await expect(hub.call('tabs.list', {})).rejects.toMatchObject({ code: 'ERR_NO_EXTENSION' });
  });
});

describe('BridgeHub 请求应答', () => {
  it('回执按 id 配对并返回结果', async () => {
    const { hub, socket } = connectedHub();
    const pending = hub.call('tabs.list', {});
    socket.deliver({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: socket.lastRequestId(),
      ok: true,
      result: { tabs: [] },
    });
    await expect(pending).resolves.toEqual({ tabs: [] });
    expect(hub.status().pending).toBe(0);
  });

  it('把插件回传的错误码原样抛给调用方', async () => {
    const { hub, socket } = connectedHub();
    const pending = hub.call('page.click', { selector: '#missing' });
    socket.deliver({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: socket.lastRequestId(),
      ok: false,
      error: { code: 'ERR_ELEMENT_NOT_FOUND', message: '没找到' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'ERR_ELEMENT_NOT_FOUND' });
  });

  it('参数不合法时压根不下发', async () => {
    const { hub, socket } = connectedHub();
    await expect(hub.call('page.navigate', { url: 'not a url' })).rejects.toMatchObject({
      code: 'ERR_INVALID_PAYLOAD',
    });
    expect(socket.sent).toHaveLength(0);
  });

  it('回执结构不符合约定时报 ERR_INVALID_RESULT，而不是把脏数据透传出去', async () => {
    const { hub, socket } = connectedHub();
    const pending = hub.call('tabs.list', {});
    socket.deliver({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: socket.lastRequestId(),
      ok: true,
      result: { tabs: 'nope' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'ERR_INVALID_RESULT' });
  });

  it('未知 id 的回执被忽略，不会影响在途请求', async () => {
    const { hub, socket } = connectedHub();
    const pending = hub.call('tabs.list', {});
    socket.deliver({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: 'nobody-asked',
      ok: true,
      result: { tabs: [] },
    });
    expect(hub.status().pending).toBe(1);
    socket.deliver({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: socket.lastRequestId(),
      ok: true,
      result: { tabs: [] },
    });
    await expect(pending).resolves.toEqual({ tabs: [] });
  });
});

describe('BridgeHub 连接生命周期', () => {
  it('连接关闭时在途请求立刻失败，不留到超时', async () => {
    const { hub, socket } = connectedHub();
    const pending = hub.call('tabs.list', {});
    socket.emit('close', 1006, Buffer.from('gone'));
    await expect(pending).rejects.toMatchObject({ code: 'ERR_DISCONNECTED' });
    expect(hub.connected).toBe(false);
    expect(hub.status().pending).toBe(0);
  });

  it('新连接顶掉旧连接，旧连接的在途请求被清理', async () => {
    const { hub, socket: first } = connectedHub();
    const pending = hub.call('tabs.list', {});

    const second = new FakeSocket();
    hub.attach(second.asWebSocket());
    await expect(pending).rejects.toMatchObject({ code: 'ERR_DISCONNECTED' });

    // 不主动关旧连接的话，插件那侧要等判活超时（实测约 72 秒）才会重连
    expect(first.closed).not.toBeNull();

    second.hello();
    expect(hub.connected).toBe(true);

    // 旧连接迟到的 close 不能把新连接的状态带走
    first.emit('close', 1006, Buffer.from('late'));
    expect(hub.connected).toBe(true);
  });

  it('超时后请求被拒绝并从待处理表里清掉', async () => {
    vi.useFakeTimers();
    const { hub } = connectedHub(50);
    const pending = hub.call('tabs.list', {});
    vi.advanceTimersByTime(51);
    await expect(pending).rejects.toMatchObject({ code: 'ERR_TIMEOUT' });
    expect(hub.status().pending).toBe(0);
  });

  it('断开时回调 onDetach，好让服务端丢掉选中的标签页等会话状态', () => {
    const onDetach = vi.fn();
    const hub = new BridgeHub(1000, onDetach);
    const socket = new FakeSocket();
    hub.attach(socket.asWebSocket());
    socket.hello();
    socket.emit('close', 1006, Buffer.from('gone'));
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it('socket 的 error 事件不会让进程崩掉', () => {
    const { socket } = connectedHub();
    expect(() => socket.emit('error', new Error('boom'))).not.toThrow();
  });
});
