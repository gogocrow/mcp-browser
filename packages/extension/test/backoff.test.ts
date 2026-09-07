import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelay } from '../src/background/backoff.ts';

describe('重连退避', () => {
  it('首次重连不会立即打过去', () => {
    expect(backoffDelay(0, () => 0)).toBe(BACKOFF_BASE_MS / 2);
  });

  it('随尝试次数指数增长', () => {
    const noJitter = () => 1;
    expect(backoffDelay(0, noJitter)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(1, noJitter)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelay(2, noJitter)).toBe(BACKOFF_BASE_MS * 4);
  });

  it('封顶后不再增长', () => {
    expect(backoffDelay(99, () => 1)).toBe(BACKOFF_MAX_MS);
  });

  it('抖动始终落在上限的一半到上限之间', () => {
    for (const random of [0, 0.25, 0.5, 0.99, 1]) {
      const delay = backoffDelay(3, () => random);
      const ceiling = BACKOFF_BASE_MS * 8;
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('负数尝试次数不会算出比基数还短的延迟', () => {
    expect(backoffDelay(-5, () => 1)).toBe(BACKOFF_BASE_MS);
  });
});
