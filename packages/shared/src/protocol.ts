import { z } from 'zod';
import { ERROR_CODES } from './errors.ts';

/** 协议版本。插件与服务端版本不一致时服务端直接拒连，避免出现"半懂"的握手。 */
export const PROTOCOL_VERSION = 1;

const version = z.literal(PROTOCOL_VERSION);

export const WireErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.unknown().optional(),
});

/** 插件连上后的第一条消息，服务端据此判断桥是否可用。 */
export const HelloMessage = z.object({
  v: version,
  kind: z.literal('hello'),
  extensionVersion: z.string(),
  userAgent: z.string(),
});

export const PongMessage = z.object({
  v: version,
  kind: z.literal('pong'),
  ts: z.number(),
});

const responseBase = {
  v: version,
  kind: z.literal('response'),
  id: z.string(),
};

export const ResponseMessage = z.discriminatedUnion('ok', [
  z.object({ ...responseBase, ok: z.literal(true), result: z.unknown() }),
  z.object({ ...responseBase, ok: z.literal(false), error: WireErrorSchema }),
]);

/** 服务端 → 插件 */
export const RequestMessage = z.object({
  v: version,
  kind: z.literal('request'),
  id: z.string(),
  action: z.string(),
  payload: z.unknown(),
});

export const PingMessage = z.object({
  v: version,
  kind: z.literal('ping'),
  ts: z.number(),
});

/** 插件 → 服务端的全部消息 */
export const ServerBoundMessage = z.union([HelloMessage, ResponseMessage, PongMessage]);

/** 服务端 → 插件的全部消息 */
export const ClientBoundMessage = z.union([RequestMessage, PingMessage]);

export type HelloMessage = z.output<typeof HelloMessage>;
export type PongMessage = z.output<typeof PongMessage>;
export type ResponseMessage = z.output<typeof ResponseMessage>;
export type RequestMessage = z.output<typeof RequestMessage>;
export type PingMessage = z.output<typeof PingMessage>;
export type ServerBoundMessage = z.output<typeof ServerBoundMessage>;
export type ClientBoundMessage = z.output<typeof ClientBoundMessage>;

/** 默认端口。插件与服务端都从这里取，避免两边各写一个常量后漂移。 */
export const DEFAULT_BRIDGE_PORT = 8777;
export const BRIDGE_WS_PATH = '/bridge';
export const MCP_HTTP_PATH = '/mcp';
