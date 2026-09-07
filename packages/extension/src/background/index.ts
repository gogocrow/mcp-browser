import { PROTOCOL_VERSION, type RequestMessage, toBridgeError } from '@browser-mcp/shared';
import { paintState } from './badge.ts';
import { BridgeConnection } from './connection.ts';
import { record } from './diag.ts';
import { runAction } from './dispatch.ts';

const KEEPALIVE_ALARM = 'bridge-keepalive';

const connection = new BridgeConnection({
  onState: (state) => void paintState(state),
  onRequest: (message) => void handleRequest(message),
});

async function handleRequest(message: RequestMessage): Promise<void> {
  try {
    const result = await runAction(message.action, message.payload);
    connection.send({ v: PROTOCOL_VERSION, kind: 'response', id: message.id, ok: true, result });
  } catch (cause) {
    connection.send({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: message.id,
      ok: false,
      error: toBridgeError(cause).toWire(),
    });
  }
}

// service worker 每次被拉起都会重跑本模块，连接也就跟着重建
void record('sw_start');
void connection.start();

chrome.runtime.onStartup.addListener(() => void connection.ensure());
chrome.runtime.onInstalled.addListener(() => void connection.ensure());

/**
 * MV3 的 service worker 空闲会被回收，回收后 setTimeout 排的重连也一起没了。
 * alarm 是唯一能把它重新叫醒的机制（最小周期 1 分钟），作为重连的兜底。
 *
 * **只在不存在时创建。** create() 同名会重置计时，而本模块在 SW 每次启动时都会跑 ——
 * 如果 SW 因为别的事件被频繁唤醒，每次都把闹钟推迟一分钟，它就可能永远不响。
 */
void (async () => {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (existing) return;
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  void record('alarm_created');
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  void record('alarm_fire');
  void connection.ensure();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return false;
  if ((message as { type?: unknown }).type !== 'reconnect') return false;
  void record('manual_restart');
  void connection.restart().then(() => sendResponse({ ok: true }));
  return true; // 保持消息通道开着，等异步 sendResponse
});
