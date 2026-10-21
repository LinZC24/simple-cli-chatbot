/**
 * 重试策略：**纯函数**，不做等待、不做 IO。
 *
 * 契约见 docs/03-interfaces.md §3：
 * - `decide()` 的判定顺序本身就是契约（用户取消永远排第一）；
 * - 退避时延可被单测精确断言，因此 jitter 上界固定 100ms，不用 full jitter；
 * - `parseRetryAfter()` 解析失败返回 `undefined`，由调用方回落到指数退避
 *   —— 绝不把「没有 Retry-After」当成 0，否则 429 会被打成雪崩。
 */

import { RateLimitError, UserAbortError, type AgentError } from './errors.js';

/** `decide()` 只需要这几项配置；`TransportOptions` 结构上包含它。 */
export interface RetryOptions {
  /** 最多重试次数；总尝试次数 = 1 + maxRetries。 */
  readonly maxRetries: number;
  /** 指数退避基数，默认 `DEFAULT_BASE_DELAY_MS`。 */
  readonly baseDelayMs: number;
  /** 指数退避上限（jitter 另计），默认 `DEFAULT_MAX_DELAY_MS`。 */
  readonly maxDelayMs: number;
  /** `Retry-After` 的等待上限，默认 `DEFAULT_MAX_RETRY_AFTER_MS`。 */
  readonly maxRetryAfterMs: number;
}

/**
 * 退避参数默认值。
 *
 * 这三个数不来自 `AppConfig`（.env 只管用户真的会调的东西），
 * 所以由协议层在拼 `TransportOptions` 时补上，集中放这里避免两处硬编码。
 */
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 20_000;

/** 一次重试的「为什么等」；会原样出现在 `RetryLogEvent.reason` 里。 */
export type RetryReason = 'retryable' | 'retry-after' | 'backoff';

export interface RetryDecision {
  readonly retry: boolean;
  /** 仅在 `retry === true` 时存在。 */
  readonly delayMs?: number;
  /** 仅在 `retry === true` 时存在。 */
  readonly reason?: RetryReason;
}

/** jitter 上界（毫秒）。固定值而非按比例，是为了测试能卡区间。 */
export const JITTER_MAX_MS = 100;

/** 不重试是常态，复用同一个冻结对象，避免每次失败都分配。 */
const NO_RETRY: RetryDecision = Object.freeze({ retry: false });

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 判断一次失败是否要重试，以及等多久。
 *
 * 判定顺序（不要重排）：
 * 1. `UserAbortError` → 不重试（用户不要了）；
 * 2. `retryable === false` → 不重试；
 * 3. 额度用完 → 不重试；
 * 4. 429 且带 `retryAfterMs` → 用它（截断到 `maxRetryAfterMs`）；
 * 5. 其余 → 指数退避 + jitter。
 *
 * @param error 刚失败的那次尝试抛出的错误
 * @param attemptsMade 已完成的尝试次数（1-based）
 */
export function decide(error: AgentError, attemptsMade: number, opts: RetryOptions): RetryDecision {
  // 1. 用户取消优先于一切：Ctrl-C 之后还能看到重试是最荒唐的 bug。
  if (error instanceof UserAbortError) {
    return NO_RETRY;
  }

  // 2. 错误类型自己声明「重试没意义」（鉴权、请求非法、响应格式）。
  if (!error.retryable) {
    return NO_RETRY;
  }

  // 3. 额度用完。attemptsMade 是「已经失败了几次」，所以 4 > 3 时收手。
  if (attemptsMade > opts.maxRetries) {
    return NO_RETRY;
  }

  // 4. 服务端明确告诉我们等多久，照办（但仍要 clamp，避免被一个巨大的值挂死）。
  if (error instanceof RateLimitError && error.retryAfterMs !== undefined) {
    return {
      retry: true,
      delayMs: clamp(error.retryAfterMs, 0, opts.maxRetryAfterMs),
      reason: 'retry-after',
    };
  }

  // 5. 指数退避：500 → 1000 → 2000 → 4000 …，封顶 maxDelayMs，再叠 0..100ms jitter。
  //    jitter 让同时失败的多路请求不会在同一毫秒一起重试。
  const base = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attemptsMade - 1));
  return {
    retry: true,
    delayMs: Math.round(base + Math.random() * JITTER_MAX_MS),
    reason: 'backoff',
  };
}

/** 纯数字形式：RFC 9110 的 delta-seconds（只接受非负整数）。 */
const DELTA_SECONDS_PATTERN = /^\+?\d+$/;

/**
 * 看起来像 HTTP-date 的输入必须带时间部分（三种合法格式都有 `HH:MM`）。
 *
 * 为什么要这层过滤：`Date.parse` 过于宽容，会把 `"-1"` / `"1.5"` 当成
 * 1970 年以前的日期，于是「非法 Retry-After」会被误判成「立即重试」。
 */
const HTTP_DATE_HINT = /\d{1,2}:\d{2}/;

/**
 * 把 `Retry-After` 头解析成毫秒。
 *
 * | 输入 | 结果 |
 * | --- | --- |
 * | `"2"` | `2000` |
 * | `"0"` | `0`（合法：立即重试） |
 * | HTTP-date | `max(0, date - now)` |
 * | `null` / `""` / 负数 / 既非数字也非日期 | `undefined` |
 *
 * 返回 `undefined` 的语义是「没有可用信息」，调用方据此回落到指数退避。
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const raw = value.trim();
  if (raw === '') {
    return undefined;
  }

  if (DELTA_SECONDS_PATTERN.test(raw)) {
    return Number(raw) * 1000;
  }

  // 负数会被 `DELTA_SECONDS_PATTERN` 拒绝，这里只剩「可能是 HTTP-date」。
  if (!HTTP_DATE_HINT.test(raw)) {
    return undefined;
  }

  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}
