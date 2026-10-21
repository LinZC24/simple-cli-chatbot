import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthError,
  ConfigError,
  NetworkError,
  RateLimitError,
  ServerError,
  TimeoutError,
  UserAbortError,
} from '../src/http/errors.js';
import { JITTER_MAX_MS, decide, parseRetryAfter, type RetryOptions } from '../src/http/retry.js';

/** 契约里的默认参数（docs/03-interfaces.md §3）。 */
const opts: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 20_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('decide 判定顺序', () => {
  it('用户取消永远不重试（即使额度没用完）', () => {
    const decision = decide(new UserAbortError(), 1, opts);

    expect(decision).toEqual({ retry: false });
  });

  it('不可重试错误直接放弃', () => {
    expect(decide(new AuthError({ status: 401 }), 1, opts).retry).toBe(false);
  });

  it('不可重试错误的判断先于额度判断', () => {
    // 额度已经用完，但错误本身也不可重试：两个条件都满足时仍是「不重试」。
    expect(decide(new AuthError({ status: 401 }), 99, opts)).toEqual({ retry: false });
  });

  it('额度用尽不再重试（attemptsMade > maxRetries）', () => {
    expect(decide(new ServerError({ status: 500 }), 4, opts)).toEqual({ retry: false });
  });

  it('额度刚好用完的那次仍然重试（attemptsMade === maxRetries）', () => {
    const decision = decide(new ServerError({ status: 500 }), 3, opts);

    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe('backoff');
  });

  it('timeout / network 这类可重试错误按退避重试', () => {
    expect(decide(new TimeoutError({ timeoutMs: 30_000 }), 1, opts).retry).toBe(true);
    expect(decide(new NetworkError(), 1, opts).retry).toBe(true);
  });

  it('其它不可重试的配置错误不重试', () => {
    expect(decide(new ConfigError('missing key'), 1, opts)).toEqual({ retry: false });
  });
});

describe('decide 退避数值', () => {
  it.each([
    [1, 500],
    [2, 1_000],
    [3, 2_000],
    [4, 4_000],
  ])('第 %i 次失败基础退避 %i ms', (attemptsMade, base) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const decision = decide(new ServerError({ status: 500 }), attemptsMade, { ...opts, maxRetries: 4 });

    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(base);
    expect(decision.reason).toBe('backoff');
  });

  it.each([
    [1, 500, 600],
    [2, 1_000, 1_100],
    [3, 2_000, 2_100],
  ])('第 %i 次失败的 delayMs 落在 %i–%i 区间', (attemptsMade, low, high) => {
    const decision = decide(new ServerError({ status: 500 }), attemptsMade, opts);

    expect(decision.delayMs).toBeGreaterThanOrEqual(low);
    expect(decision.delayMs).toBeLessThanOrEqual(high);
  });

  it('jitter 是 0..100 的随机量，不是固定值', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const decision = decide(new ServerError({ status: 500 }), 1, opts);

    expect(decision.delayMs).toBe(500 + JITTER_MAX_MS / 2);
  });

  it('指数增长被 maxDelayMs 截断（jitter 另计）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const decision = decide(new ServerError({ status: 500 }), 10, { ...opts, maxRetries: 10 });

    expect(decision.delayMs).toBe(opts.maxDelayMs);
  });
});

describe('decide 与 Retry-After', () => {
  it('429 带 retryAfterMs 时优先于退避', () => {
    const decision = decide(new RateLimitError({ status: 429, retryAfterMs: 2_000 }), 1, opts);

    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(2_000);
    expect(decision.reason).toBe('retry-after');
  });

  it('retryAfterMs = 0 是合法的「立即重试」', () => {
    const decision = decide(new RateLimitError({ status: 429, retryAfterMs: 0 }), 1, opts);

    expect(decision.delayMs).toBe(0);
    expect(decision.reason).toBe('retry-after');
  });

  it('超过 maxRetryAfterMs 被截断', () => {
    const decision = decide(new RateLimitError({ status: 429, retryAfterMs: 999_999 }), 1, opts);

    expect(decision.delayMs).toBe(opts.maxRetryAfterMs);
    expect(decision.reason).toBe('retry-after');
  });

  it('没有 retryAfterMs 的 429 回落到指数退避', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const decision = decide(new RateLimitError({ status: 429 }), 2, opts);

    expect(decision.delayMs).toBe(1_000);
    expect(decision.reason).toBe('backoff');
  });

  it('额度用尽时即使有 Retry-After 也不再重试', () => {
    const decision = decide(new RateLimitError({ status: 429, retryAfterMs: 2_000 }), 4, opts);

    expect(decision).toEqual({ retry: false });
  });
});

describe('parseRetryAfter', () => {
  it.each<[string | null, number | undefined]>([
    ['2', 2_000],
    ['0', 0],
    ['120', 120_000],
    [' 2 ', 2_000],
    ['-1', undefined],
    ['abc', undefined],
    ['', undefined],
    [null, undefined],
  ])('parseRetryAfter(%o) === %o', (input, expected) => {
    expect(parseRetryAfter(input)).toBe(expected);
  });

  it('支持 HTTP-date（相对当前时间的毫秒数）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));

    expect(parseRetryAfter('Tue, 20 Oct 2026 00:00:05 GMT')).toBe(5_000);

    vi.useRealTimers();
  });

  it('已过期的 HTTP-date 返回 0，而不是负数', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));

    expect(parseRetryAfter('Tue, 20 Oct 2026 00:00:00 GMT')).toBe(0);
    expect(parseRetryAfter('Mon, 19 Oct 2026 00:00:00 GMT')).toBe(0);

    vi.useRealTimers();
  });

  it('看起来像数字但不是非负整数的输入回落到 undefined', () => {
    expect(parseRetryAfter('1.5')).toBeUndefined();
    expect(parseRetryAfter('1e3')).toBeUndefined();
  });
});
