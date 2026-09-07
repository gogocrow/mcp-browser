import { type ConnectionState, STATE_KEY } from '../background/badge.ts';
import { readLog } from '../background/diag.ts';
import { DEFAULT_URL, readSettings, writeSettings } from '../background/settings.ts';

const LABELS: Record<ConnectionState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '未连接',
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup.html 缺少 #${id}`);
  return found as T;
}

const dot = element<HTMLSpanElement>('dot');
const stateLabel = element<HTMLSpanElement>('state');
const urlInput = element<HTMLInputElement>('url');
const tokenInput = element<HTMLInputElement>('token');
const saveButton = element<HTMLButtonElement>('save');
const logBox = element<HTMLPreElement>('log');

function render(state: ConnectionState): void {
  dot.dataset.state = state;
  stateLabel.textContent = LABELS[state];
}

/**
 * popup 直接读 storage.local，不经过 background 也不依赖桥 ——
 * 需要看日志的时候恰恰是连不上的时候，走 MCP 读日志是死循环。
 */
async function renderLog(): Promise<void> {
  const entries = await readLog();
  logBox.textContent =
    entries.length === 0
      ? '（空）'
      : entries
          .slice(-40)
          .map((e) => `${e.at.slice(11, 19)} ${e.event}${e.detail ? ` ${e.detail}` : ''}`)
          .join('\n');
}

async function load(): Promise<void> {
  const settings = await readSettings();
  urlInput.value = settings.url;
  urlInput.placeholder = DEFAULT_URL;
  tokenInput.value = settings.token;

  const stored = await chrome.storage.session.get(STATE_KEY);
  const state = stored[STATE_KEY];
  render(state === 'connected' || state === 'connecting' ? state : 'disconnected');

  await renderLog();
}

// 状态由 background 写进 session storage，这里跟着变化实时刷新
chrome.storage.session.onChanged.addListener((changes) => {
  const next = changes[STATE_KEY]?.newValue;
  if (next === 'connected' || next === 'connecting' || next === 'disconnected') render(next);
});

saveButton.addEventListener('click', () => {
  void (async () => {
    saveButton.disabled = true;
    try {
      await writeSettings({
        url: urlInput.value.trim() || DEFAULT_URL,
        token: tokenInput.value.trim(),
      });
      await chrome.runtime.sendMessage({ type: 'reconnect' });
    } finally {
      saveButton.disabled = false;
    }
  })();
});

void load();
