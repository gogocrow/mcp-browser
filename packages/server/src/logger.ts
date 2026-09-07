type Level = 'info' | 'warn' | 'error';

const enabled = process.env.BRIDGE_LOG !== 'off';

function emit(level: Level, message: string, extra?: unknown): void {
  if (!enabled) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  // 一律走 stderr：留出 stdout，便于以后接 stdio 形态的 MCP 传输
  if (extra === undefined) process.stderr.write(`${line}\n`);
  else process.stderr.write(`${line} ${JSON.stringify(extra)}\n`);
}

export const log = {
  info: (message: string, extra?: unknown) => emit('info', message, extra),
  warn: (message: string, extra?: unknown) => emit('warn', message, extra),
  error: (message: string, extra?: unknown) => emit('error', message, extra),
};
