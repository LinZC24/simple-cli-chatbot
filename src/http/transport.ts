/**
 * 传输层：唯一碰 `fetch` 的地方，也是唯一知道「要不要重试」的地方。
 *
 * 契约见 docs/03-interfaces.md §2、§4：
 * - `postJson` 要么返回成功响应，要么抛 `AgentError` 子类，**绝不返回失败响应对象**；
 * - 重试全部发生在函数内部，调用方只看得到最终结果；
 * - 超时与用户取消靠 `abort(reason)` 显式写入的原因判别，**不靠错误名**；
 * - 每次尝试新建 `AbortController`，`finally` 清 timer，不留句柄。
 */

import {
  AgentError,
  AuthError,
  BadRequestError,
  NetworkError,
  RateLimitError,
  ResponseShapeError,
  ServerError,
  TimeoutError,
  UserAbortError,
  isAgentError,
  type HttpErrorOptions,
} from './errors.js';
import { decide, parseRetryAfter, type RetryOptions, type RetryReason } from './retry.js';

export interface TransportOptions extends RetryOptions {
  /** 单次尝试的超时（毫秒），默认 30_000。 */
  readonly timeoutMs: number;
  /** 用户取消（Ctrl-C）从这里进来；abort 后不重试。 */
  readonly signal?: AbortSignal;
  /** 每次决定重试时回调一次，CLI 用它打印 `[retry] ...` 日志。 */
  readonly log?: (event: RetryLogEvent) => void;
}

/** 一次重试的观测事件；`attempt` 指**刚刚失败**的那次。 */
export interface RetryLogEvent {
  readonly attempt: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly status?: number;
  readonly reason: RetryReason;
}

export interface JsonResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

/** 我们写进 `abort(reason)` 的两种原因。 */
type AbortCause = 'timeout' | 'user';

interface AbortReason {
  readonly cause: AbortCause;
}

/** 从 `signal.reason` 读出我们自己写入的原因；读不出来返回 undefined。 */
function readAbortCause(reason: unknown): AbortCause | undefined {
  if (typeof reason !== 'object' || reason === null || !('cause' in reason)) {
    return undefined;
  }
  const cause: unknown = reason.cause;
  return cause === 'timeout' || cause === 'user' ? cause : undefined;
}

/** 请求目标的 host，只用于错误信息；URL 非法时放弃（不掩盖真正的错误）。 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** 用 `host === undefined` 时不产生该字段的写法，满足 exactOptionalPropertyTypes。 */
function hostOption(host: string | undefined): { readonly host?: string } {
  return host === undefined ? {} : { host };
}

/** 把 `undefined` 的 cause 变成「没有 cause 字段」，避免污染 cause 链。 */
function causeOption(cause: unknown): { readonly cause?: unknown } {
  return cause === undefined ? {} : { cause };
}

/**
 * 从错误对象里读 HTTP 状态码；非 HTTP 错误（网络 / 超时）返回 undefined。
 *
 * 不 import 具体错误类做 instance 判断，是因为 `RetryLogEvent` 只关心
 * 「有没有状态码」，不该为此把错误体系的分支写死在这里。
 */
function readHttpStatus(error: AgentError): number | undefined {
  if (!('http' in error)) {
    return undefined;
  }
  const http: unknown = error.http;
  if (typeof http !== 'object' || http === null || !('status' in http)) {
    return undefined;
  }
  const status: unknown = http.status;
  return typeof status === 'number' ? status : undefined;
}

/** 5xx/429 之外的状态码一律算「请求本身有问题」，重试没用。 */
function statusToError(response: Response, body: string, host: string | undefined): AgentError {
  const options: HttpErrorOptions = {
    status: response.status,
    ...(body === '' ? {} : { body }),
    ...(host === undefined ? {} : { host }),
  };

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return retryAfterMs === undefined ? new RateLimitError(options) : new RateLimitError({ ...options, retryAfterMs });
  }
  if (response.status === 401 || response.status === 403) {
    return new AuthError(options);
  }
  if (response.status >= 500) {
    return new ServerError(options);
  }
  return new BadRequestError(options);
}

// ---------------------------------------------------------------------------
// 单次尝试
// ---------------------------------------------------------------------------

/**
 * 执行一次请求：超时 / 用户取消 / 状态码 / 解析，全部在这里翻译成 `AgentError`。
 *
 * 返回的 body 只保证「是合法 JSON」，结构校验属于协议层（llm-client）。
 */
async function attemptOnce<T>(
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>>,
  options: TransportOptions,
): Promise<JsonResponse<T>> {
  const host = hostOf(url);
  const userSignal = options.signal;

  // 上一轮就在等待重试时被取消了：一次请求都不该发出去。
  if (userSignal?.aborted === true) {
    throw new UserAbortError('request cancelled by user before it was sent', { meta: { host } });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort({ cause: 'timeout' } satisfies AbortReason);
  }, options.timeoutMs);
  const onUserAbort = (): void => {
    ac.abort({ cause: 'user' } satisfies AbortReason);
  };
  userSignal?.addEventListener('abort', onUserAbort, { once: true });

  try {
    // 每次尝试都重新 fetch：绝不复用上一次的 Response（body 已被消费）。
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });

    // body 只读一次，存进变量；错误分支同样用这份文本，不再二次消费。
    const text = await response.text();

    if (!response.ok) {
      throw statusToError(response, text, host);
    }

    return {
      status: response.status,
      headers: response.headers,
      // 2xx 但不是 JSON（HTML 错误页 / 网关页）由这里归为响应形状错误。
      body: parseJsonBody<T>(text),
    };
  } catch (cause) {
    // 状态错误 / 响应形状错误已经是 AgentError，原样上抛。
    if (cause instanceof AgentError) {
      throw cause;
    }

    switch (readAbortCause(ac.signal.reason)) {
      case 'user':
        throw new UserAbortError('request cancelled by user', { ...causeOption(cause), meta: { host } });
      case 'timeout':
        throw new TimeoutError({ timeoutMs: options.timeoutMs, ...hostOption(host), ...causeOption(cause) });
      default:
        throw new NetworkError({ ...hostOption(host), ...causeOption(cause) });
    }
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener('abort', onUserAbort);
  }
}

/**
 * 2xx 但不是 JSON：供应商返回了 HTML 错误页 / 网关页面。
 *
 * 返回值断言成 `T` 是传输层的未校验边界：传输层只保证「JSON 可解析」，
 * 「结构对不对」由协议层（llm-client 的守卫）负责。
 */
function parseJsonBody<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ResponseShapeError('body is not valid JSON', { body: text, ...causeOption(cause) });
  }
}

// ---------------------------------------------------------------------------
// 重试循环
// ---------------------------------------------------------------------------

/**
 * 可中断的等待。
 *
 * 重试等待期间用户按 Ctrl-C 必须立刻退出 —— 用一个不可打断的 `setTimeout`
 * 会让「取消」延迟到退避结束，体验上等同于没取消。
 */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    throw new UserAbortError('request cancelled by user while waiting to retry');
  }
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new UserAbortError('request cancelled by user while waiting to retry'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toRetryLogEvent(attempt: number, delayMs: number, error: AgentError, reason: RetryReason): RetryLogEvent {
  const status = readHttpStatus(error);
  return {
    attempt,
    delayMs,
    errorName: error.name,
    reason,
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * POST JSON，并在内部完成超时 / 重试 / 状态码归类。
 *
 * @throws {AgentError} 重试耗尽或遇到不可重试错误时，抛对应的错误子类
 */
export async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>>,
  options: TransportOptions,
): Promise<JsonResponse<T>> {
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await attemptOnce<T>(url, payload, headers, options);
    } catch (cause) {
      const error: AgentError = isAgentError(cause)
        ? cause
        : new NetworkError({ ...causeOption(cause), ...hostOption(hostOf(url)) });

      const decision = decide(error, attempt, options);
      if (!decision.retry) {
        throw error;
      }

      const delayMs = decision.delayMs ?? 0;
      options.log?.(toRetryLogEvent(attempt, delayMs, error, decision.reason ?? 'retryable'));
      await sleep(delayMs, options.signal);
    }
  }
}
