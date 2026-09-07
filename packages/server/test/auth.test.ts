import { describe, expect, it } from 'vitest';
import { bearerOf, isOriginAllowed, isTokenValid } from '../src/auth.ts';

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describe('WebSocket 来源校验', () => {
  it('放行扩展来源', () => {
    expect(isOriginAllowed(EXTENSION, undefined)).toBe(true);
  });

  it('挡掉网页来源 —— 这是本校验存在的唯一理由', () => {
    expect(isOriginAllowed('https://evil.example', undefined)).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', undefined)).toBe(false);
    expect(isOriginAllowed('null', undefined)).toBe(false);
  });

  it('不带 Origin 的非浏览器客户端放行（联调脚本、curl）', () => {
    expect(isOriginAllowed(undefined, undefined)).toBe(true);
  });

  it('配了具体来源后，其他扩展也会被挡掉', () => {
    expect(isOriginAllowed(EXTENSION, EXTENSION)).toBe(true);
    expect(isOriginAllowed('chrome-extension://someotherextensionidhere', EXTENSION)).toBe(false);
  });

  it('不能靠伪造前缀绕过', () => {
    expect(isOriginAllowed('https://chrome-extension://x', undefined)).toBe(false);
    expect(isOriginAllowed('https://evil.com/chrome-extension://', undefined)).toBe(false);
  });
});

describe('令牌校验', () => {
  it('没配 token 时一律放行', () => {
    expect(isTokenValid(undefined, null)).toBe(true);
    expect(isTokenValid(undefined, 'whatever')).toBe(true);
  });

  it('配了 token 就必须完全一致', () => {
    expect(isTokenValid('s3cret', 's3cret')).toBe(true);
    expect(isTokenValid('s3cret', 'wrong')).toBe(false);
    expect(isTokenValid('s3cret', null)).toBe(false);
  });

  it('长度不同不会抛异常（timingSafeEqual 的坑）', () => {
    expect(() => isTokenValid('s3cret', 'x')).not.toThrow();
    expect(isTokenValid('s3cret', 'x')).toBe(false);
    expect(isTokenValid('s3cret', 's3cret-longer')).toBe(false);
  });
});

describe('Bearer 解析', () => {
  it('取出 Bearer 后面的部分', () => {
    expect(bearerOf('Bearer abc123')).toBe('abc123');
  });

  it('缺失或格式不对时返回 null', () => {
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf('abc123')).toBeNull();
    expect(bearerOf('Basic abc123')).toBeNull();
  });
});
