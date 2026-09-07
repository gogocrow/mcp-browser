import { describe, expect, it } from 'vitest';
import { ACTION_NAMES, ACTIONS, isActionName } from '../src/actions.ts';
import { BridgeError } from '../src/errors.ts';
import { ClientBoundMessage, PROTOCOL_VERSION, ServerBoundMessage } from '../src/protocol.ts';

describe('动作 schema', () => {
  it('page.navigate 会补上默认超时', () => {
    const parsed = ACTIONS['page.navigate'].input.parse({ url: 'https://example.com' });
    expect(parsed).toMatchObject({ url: 'https://example.com', timeoutMs: 30_000 });
  });

  it('page.navigate 拒绝非 URL', () => {
    expect(ACTIONS['page.navigate'].input.safeParse({ url: 'not a url' }).success).toBe(false);
  });

  it('page.snapshot 省略参数时也有默认上限', () => {
    expect(ACTIONS['page.snapshot'].input.parse({})).toMatchObject({ maxChars: 20_000 });
  });

  it('isActionName 只认注册过的动作', () => {
    expect(isActionName('page.click')).toBe(true);
    expect(isActionName('page.explode')).toBe(false);
  });

  it('每个动作的 input/output 都是 ZodObject（server 需要 .shape）', () => {
    for (const name of ACTION_NAMES) {
      expect(ACTIONS[name].input.shape).toBeTypeOf('object');
      expect(ACTIONS[name].output.shape).toBeTypeOf('object');
    }
  });
});

describe('消息信封', () => {
  it('接受成功回执并保留 result', () => {
    const parsed = ServerBoundMessage.safeParse({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: 'abc',
      ok: true,
      result: { tabs: [] },
    });
    expect(parsed.success).toBe(true);
  });

  it('失败回执必须带 error，缺了就不合法', () => {
    const parsed = ServerBoundMessage.safeParse({
      v: PROTOCOL_VERSION,
      kind: 'response',
      id: 'abc',
      ok: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('拒绝版本不匹配的消息', () => {
    const parsed = ClientBoundMessage.safeParse({
      v: PROTOCOL_VERSION + 1,
      kind: 'ping',
      ts: 1,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('BridgeError', () => {
  it('toWire / from 往返后 code 与 message 不变', () => {
    const original = new BridgeError('ERR_TIMEOUT', '超时了', { action: 'page.click' });
    const restored = BridgeError.from(original.toWire());
    expect(restored.code).toBe('ERR_TIMEOUT');
    expect(restored.message).toBe('超时了');
    expect(restored.details).toEqual({ action: 'page.click' });
  });

  it('没有 details 时不会往线上塞 undefined 字段', () => {
    expect(Object.hasOwn(new BridgeError('ERR_INTERNAL', 'x').toWire(), 'details')).toBe(false);
  });
});
