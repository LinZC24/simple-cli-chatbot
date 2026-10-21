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

/**
 * 流式响应：状态与头先到，正文一块块来。
 *
 * `chunks` 的切分点**没有任何保证**（可能是半行、也可能是三条事件），
 * 拼行属于协议层（`src/llm/sse.ts`）。
 */
export interface StreamResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly chunks: AsyncIterable<string>;
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
 * 重试循环本身。
 *
 * 抽出来是因为「整包 JSON」与「流式」的重试条件完全一样：只到**拿到响应头**为止。
 * 流式的一旦开始趟正文就不能再重试了（已经映到屏幕上的字收不回来）。
 */
async function withRetry<T>(url: string, options: TransportOptions, attemptFn: () => Promise<T>): Promise<T> {
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await attemptFn();
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
  return withRetry(url, options, () => attemptOnce<T>(url, payload, headers, options));
}

// ---------------------------------------------------------------------------
// 流式（SSE）
// ---------------------------------------------------------------------------

/**
 * 流式请求的生命周期把手：空闲计时器与用户取消监听都在这里，
 * 正文读完（或中断）后必须 `dispose()`，否则定时器和监听会一直挂着。
 */
interface StreamControl {
  readonly controller: AbortController;
  /** 每收到一块就重新计时 —— 流式下 `timeoutMs` 是「多久没新数据」（空闲超时）。 */
  touch(): void;
  dispose(): void;
}

export function createStreamControl(timeoutMs: number, userSignal: AbortSignal | undefined): StreamControl {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const touch = (): void => {
    clear();
    timer = setTimeout(() => {
      controller.abort({ cause: 'timeout' } satisfies AbortReason);
    }, timeoutMs);
  };
  const onUserAbort = (): void => {
    controller.abort({ cause: 'user' } satisfies AbortReason);
  };

  touch();
  userSignal?.addEventListener('abort', onUserAbort, { once: true });

  return {
    controller,
    touch,
    dispose() {
      clear();
      userSignal?.removeEventListener('abort', onUserAbort);
    },
  };
}

/**
 * 一个「只在 abort 时拒绝」的 promise，用来和 `reader.read()` 赛跑。
 *
 * 为什么不能只靠 fetch 的 signal：`reader.read()` 是否因 abort 而拒绝，取决于底层流的实现
 * （真 fetch 会，手搓的 / 某些 polyfill 不会）。让 abort 赢下赛跑，才能保证
 * 「超时 / Ctrl-C」在任何实现上都能立刻结束，而不是挂在 `await read()` 上。
 */
function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * 把 `ReadableStream` 解成文本块。
 *
 * 两件事必须在这里做对：
 * - **空闲超时与用户取消**：靠 `control.controller.signal.reason` 分辨，不靠错误名；
 * - **收尾**：`dispose()` + `reader.cancel()`，否则中断之后连接和定时器都会漏。
 */
async function* decodeChunks(
  body: ReadableStream<Uint8Array>,
  control: StreamControl,
  host: string | undefined,
  timeoutMs: number,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  // `stream: true` 让跨块的多字节字符（中文）不会被切碎成半个。
  const decoder = new TextDecoder();
  const aborted = abortRace(control.controller.signal);

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        break;
      }
      control.touch();
      const text = value === undefined ? '' : decoder.decode(value, { stream: true });
      if (text !== '') {
        yield text;
      }
    }

    const tail = decoder.decode();
    if (tail !== '') {
      yield tail;
    }
  } catch (cause) {
    if (cause instanceof AgentError) {
      throw cause;
    }

    switch (readAbortCause(control.controller.signal.reason)) {
      case 'user':
        throw new UserAbortError('request cancelled by user while streaming', {
          ...causeOption(cause),
          meta: { host },
        });
      case 'timeout':
        throw new TimeoutError({ timeoutMs, ...hostOption(host), ...causeOption(cause) });
      default:
        // 包括服务端中途断连：没有重试机会了，直接当作网络错误。
        throw new NetworkError({ ...hostOption(host), ...causeOption(cause) });
    }
  } finally {
    control.dispose();
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * 发一次流式请求，拿到「状态码 + 文本块流」。
 *
 * 与 `attemptOnce` 的差别只有一个：超时的起算点从「整个请求」变成「两块数据之间」。
 * 否则长回答必然在 `timeoutMs` 处被砍断（模型还在正常吐字）。
 */
/**
 * 响应头声明的是「整包」而不是流。
 *
 * 没有 `content-type` 时仍然按 SSE 处理：请求里已经明确要了 `text/event-stream`，
 * 缺头更可能是中间的怪代理，而不是对面真回了一包 JSON。
 */
function isWholeBodyResponse(contentType: string | null): boolean {
  return contentType !== null && !contentType.toLowerCase().includes('text/event-stream');
}

/**
 * 把一整包 JSON 包成两帧 SSE（`data: <json>` + `data: [DONE]`）。
 *
 * 多行文本每行都补 `data:` 前缀 —— 否则解析器会把后面的行当成新的字段丢掉。
 */
async function* singleFrame(text: string): AsyncIterable<string> {
  yield `data: ${text.replaceAll('\n', '\ndata: ')}\n\n`;
  yield 'data: [DONE]\n\n';
}

async function attemptStreamOnce(
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>>,
  options: TransportOptions,
): Promise<StreamResponse> {
  const host = hostOf(url);
  const userSignal = options.signal;

  if (userSignal?.aborted === true) {
    throw new UserAbortError('request cancelled by user before it was sent', { meta: { host } });
  }

  const control = createStreamControl(options.timeoutMs, userSignal);
  let handedOff = false;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: control.controller.signal,
    });

    if (!response.ok) {
      // 错误体是一小包 JSON/HTML，整读比流式更好用（错误信息要完整）。
      const text = await response.text();
      throw statusToError(response, text, host);
    }

    const body = response.body;
    if (body === null) {
      throw new ResponseShapeError('streaming response has no body', {
        meta: { status: response.status, url },
      });
    }

    // 服务端（或中间的代理）没理会 `stream: true`，回了整包 JSON。
    // 包成一帧 SSE 喂给同一个解析器：上层不必为「到底有没有流」分叉。
    if (isWholeBodyResponse(response.headers.get('content-type'))) {
      const text = await response.text();
      handedOff = true;
      return { status: response.status, headers: response.headers, chunks: singleFrame(text) };
    }

    handedOff = true;
    return {
      status: response.status,
      headers: response.headers,
      chunks: decodeChunks(body, control, host, options.timeoutMs),
    };
  } catch (cause) {
    if (cause instanceof AgentError) {
      throw cause;
    }

    switch (readAbortCause(control.controller.signal.reason)) {
      case 'user':
        throw new UserAbortError('request cancelled by user', { ...causeOption(cause), meta: { host } });
      case 'timeout':
        throw new TimeoutError({ timeoutMs: options.timeoutMs, ...hostOption(host), ...causeOption(cause) });
      default:
        throw new NetworkError({ ...hostOption(host), ...causeOption(cause) });
    }
  } finally {
    // 交出去了就由 chunks 的消费者负责 dispose（现在还要继续计时）。
    if (!handedOff) {
      control.dispose();
    }
  }
}

/**
 * POST 一个 SSE 请求。
 *
 * 重试只覆盖到「拿到响应头」为止：
 * - 还没开始趟正文时遇到 429/5xx/网络错，跟普通请求一样重试；
 * - 已经映到屏幕上的字收不回来，中途断流只能报错 —— 重试反而会重复输出。
 *
 * @throws {AgentError} 同时刻的 `postJson`，另外中途断流抛 `NetworkError`
 */
export async function postSse(
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>>,
  options: TransportOptions,
): Promise<StreamResponse> {
  return withRetry(url, options, () => attemptStreamOnce(url, payload, headers, options));
}
