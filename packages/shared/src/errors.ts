export const ERROR_CODES = [
  'ERR_UNKNOWN_ACTION',
  'ERR_INVALID_PAYLOAD',
  'ERR_INVALID_RESULT',
  'ERR_NO_EXTENSION',
  'ERR_DISCONNECTED',
  'ERR_TIMEOUT',
  'ERR_NO_TAB',
  'ERR_TAB_BLOCKED',
  'ERR_SCRIPT_FAILED',
  'ERR_ELEMENT_NOT_FOUND',
  'ERR_ELEMENT_COVERED',
  'ERR_STALE_REF',
  'ERR_DEBUGGER_UNAVAILABLE',
  'ERR_PROTOCOL',
  'ERR_INTERNAL',
] as const;

export type BridgeErrorCode = (typeof ERROR_CODES)[number];

export interface WireError {
  code: BridgeErrorCode;
  message: string;
  details?: unknown;
}

/**
 * 桥接层所有失败的唯一表示。不存在"返回错误字符串"的路径 —— 每个失败都带稳定 code，
 * 便于 MCP 侧把可重试（ERR_TIMEOUT / ERR_DISCONNECTED）与不可重试（ERR_ELEMENT_NOT_FOUND）区分开。
 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details?: unknown;

  constructor(code: BridgeErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static from(wire: WireError): BridgeError {
    return new BridgeError(wire.code, wire.message, wire.details);
  }

  toWire(): WireError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/** 把任意 catch 到的值收敛成 BridgeError，避免 unknown 泄漏到协议层。 */
export function toBridgeError(
  cause: unknown,
  fallback: BridgeErrorCode = 'ERR_INTERNAL',
): BridgeError {
  if (cause instanceof BridgeError) return cause;
  if (cause instanceof Error) return new BridgeError(fallback, cause.message);
  return new BridgeError(fallback, String(cause));
}
