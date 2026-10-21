/**
 * 自定义错误体系。
 *
 * 分层原则（见 docs/01-architecture.md §6）：
 * - 传输层负责把「状态码 / fetch reject / abort」翻译成这里的某一类；
 * - 上层的判断只依赖 `AgentError` 的语义（`retryable`、`instanceof`），
 *   而不是去嗅探 `Response.status` 或错误消息文本。
 *
 * 谁来决定「要不要重试」：`retryable` 字段。不重试的错误继承 `FatalError`，
 * 重试的错误继承 `RetryableError` —— 两者互斥，不会再出现「4xx 也重试了三次」。
 */

/** 所有自定义错误的构造参数。 */
export interface AgentErrorOptions {
  /** 被包装的原始错误（通常来自 fetch / JSON.parse），保留完整调用链。 */
  readonly cause?: unknown;
  /** 附带的诊断信息，会挂在 `error.meta` 上，便于日志与测试断言。 */
  readonly meta?: Record<string, unknown>;
}

/**
 * 全局错误基类。
 *
 * 注意 `retryable` 由子类经构造函数传入，不开放给调用方覆盖：
 * 重试策略是**类型**的一部分，不是调用点的临时决定。
 */
export abstract class AgentError extends Error {
  /** 是否适合原样重试。 */
  readonly retryable: boolean;

  /** 诊断信息（已冻结，防止下游意外改写）。 */
  readonly meta: Readonly<Record<string, unknown>>;

  protected constructor(message: string, retryable: boolean, options: AgentErrorOptions = {}) {
    // exactOptionalPropertyTypes 下不能无条件传 { cause: undefined }，
    // 否则 error.cause 会从「不存在」变成「存在且为 undefined」，影响 cause 链断言。
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.retryable = retryable;
    this.meta = Object.freeze({ ...options.meta });
  }
}

/** 重试没有意义的错误：配置错、鉴权错、请求错、响应格式错。 */
export abstract class FatalError extends AgentError {
  protected constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, false, options);
  }
}

/** 重试可能成功的错误：限流、服务端抖动、网络抖动、超时。 */
export abstract class RetryableError extends AgentError {
  protected constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, true, options);
  }
}

// ---------------------------------------------------------------------------
// 非 HTTP 错误
// ---------------------------------------------------------------------------

/** 环境变量缺失或非法。启动阶段就抛，不进入网络流程。 */
export interface ConfigErrorOptions extends AgentErrorOptions {
  /** 出问题的环境变量名；非单变量问题（例如 baseUrl 非法）时为 undefined。 */
  readonly variable?: string;
}

export class ConfigError extends FatalError {
  readonly variable: string | undefined;

  constructor(message: string, options: ConfigErrorOptions = {}) {
    super(message, options);
    this.variable = options.variable;
  }
}

/** 2xx 但 JSON 结构不符合 OpenAI 兼容协议。 */
export interface ResponseShapeErrorOptions extends AgentErrorOptions {
  /** 原始响应体，会截断到前 200 字符。 */
  readonly body?: string;
}

export class ResponseShapeError extends FatalError {
  /** 响应体前 200 字符（超出部分被丢弃，不会把整页 HTML 喷到终端）。 */
  readonly bodySnippet: string;

  constructor(reason: string, options: ResponseShapeErrorOptions = {}) {
    const snippet = options.body === undefined ? '' : toBodySnippet(options.body);
    const message = snippet === '' ? `unexpected response shape — ${reason}` : `unexpected response shape — ${reason}. ${snippet}`;
    super(message, options);
    this.bodySnippet = snippet;
  }
}

/** fetch 本身 reject：DNS 失败、连接重置、TLS 错误、代理拒绝。 */
export interface NetworkErrorOptions extends AgentErrorOptions {
  /** 请求目标的 host，便于用户判断是网络问题还是配错了端点。 */
  readonly host?: string;
}

export class NetworkError extends RetryableError {
  readonly host: string | undefined;

  constructor(options: NetworkErrorOptions = {}) {
    const detail = options.cause === undefined ? 'fetch failed' : `fetch failed — ${describeCause(options.cause)}`;
    super(options.host === undefined ? detail : `${detail} (${options.host})`, options);
    this.host = options.host;
  }
}

/** 单次尝试超过 `timeoutMs`。与用户按 Ctrl-C 严格区分。 */
export interface TimeoutErrorOptions extends AgentErrorOptions {
  readonly timeoutMs: number;
  readonly host?: string;
}

export class TimeoutError extends RetryableError {
  readonly timeoutMs: number;
  readonly host: string | undefined;

  constructor(options: TimeoutErrorOptions) {
    const where = options.host === undefined ? '' : ` (${options.host})`;
    super(`attempt timed out after ${options.timeoutMs}ms${where}`, options);
    this.timeoutMs = options.timeoutMs;
    this.host = options.host;
  }
}

/**
 * 用户主动取消（Ctrl-C）。
 *
 * 既不是 `FatalError` 也不是 `RetryableError`：它不代表系统出了问题，
 * 重试更是违背用户意愿 —— 这正是「Ctrl-C 之后还能看到 3 次重试」的根因。
 */
export class UserAbortError extends AgentError {
  constructor(message = 'request cancelled by user', options: AgentErrorOptions = {}) {
    super(message, false, options);
  }
}

// ---------------------------------------------------------------------------
// HTTP 状态错误
// ---------------------------------------------------------------------------

/** 截断长度：错误信息里只保留响应体前 200 字符。 */
export const BODY_SNIPPET_MAX = 200;

/** 从响应体里截取可读片段。 */
export function toBodySnippet(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= BODY_SNIPPET_MAX ? trimmed : trimmed.slice(0, BODY_SNIPPET_MAX);
}

export interface HttpErrorOptions extends AgentErrorOptions {
  readonly status: number;
  /** 例如 `Unauthorized`；HTTP/2 不提供 reason phrase，故允许缺省。 */
  readonly statusText?: string;
  /** 原始响应体，会截断到前 200 字符。 */
  readonly body?: string;
  /** 请求目标的 host，例如 `api.openai.com`。 */
  readonly host?: string;
}

/** HTTP 错误的可断言字段集合。 */
export interface HttpDetails {
  readonly status: number;
  readonly statusText: string;
  readonly bodySnippet: string;
  readonly host: string | undefined;
}

interface DescribedHttpError {
  readonly message: string;
  readonly http: HttpDetails;
}

function describeHttpError(hint: string, options: HttpErrorOptions): DescribedHttpError {
  const statusText = options.statusText ?? '';
  const bodySnippet = options.body === undefined ? '' : toBodySnippet(options.body);
  const head = statusText === '' ? `${options.status}` : `${options.status} ${statusText}`;

  let message = `${head} — ${hint}.`;
  if (options.host !== undefined) {
    message += ` ${options.host}:`;
  }
  if (bodySnippet !== '') {
    message += ` ${bodySnippet}`;
  }

  return {
    message,
    http: { status: options.status, statusText, bodySnippet, host: options.host },
  };
}

/** 需要重试的 HTTP 状态错误基类（429 / 5xx）。 */
abstract class RetryableHttpError extends RetryableError {
  readonly http: HttpDetails;

  protected constructor(hint: string, options: HttpErrorOptions) {
    const described = describeHttpError(hint, options);
    super(described.message, options);
    this.http = described.http;
  }
}

/** 不需要重试的 HTTP 状态错误基类（400 / 401 / 403 / 404 / 422）。 */
abstract class FatalHttpError extends FatalError {
  readonly http: HttpDetails;

  protected constructor(hint: string, options: HttpErrorOptions) {
    const described = describeHttpError(hint, options);
    super(described.message, options);
    this.http = described.http;
  }
}

/** 401 / 403：key 无效、过期、与端点不匹配。 */
export class AuthError extends FatalHttpError {
  constructor(options: HttpErrorOptions) {
    // 401 是 key 本身不对，403 是 key 有效但没权限 —— 两者提示必须不同，
    // 否则用户会拿着一个完全正确的 key 去反复检查拼写。
    super(options.status === 403 ? 'api key has no permission for this endpoint' : 'invalid api key', options);
  }
}

/** 400 / 404 / 422：请求本身有问题（最常见的是模型 id 不存在）。 */
export class BadRequestError extends FatalHttpError {
  constructor(options: HttpErrorOptions) {
    super('request rejected by server', options);
  }
}

/** 429：触发限流。`retryAfterMs` 存在时优先于指数退避。 */
export interface RateLimitErrorOptions extends HttpErrorOptions {
  /** 由 `Retry-After` 解析出的等待毫秒数；缺失或非法时为 undefined。 */
  readonly retryAfterMs?: number;
}

export class RateLimitError extends RetryableHttpError {
  readonly retryAfterMs: number | undefined;

  constructor(options: RateLimitErrorOptions) {
    super('rate limit exceeded', options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** 500 / 502 / 503 / 504：服务端临时故障。 */
export class ServerError extends RetryableHttpError {
  constructor(options: HttpErrorOptions) {
    super('server error', options);
  }
}

// ---------------------------------------------------------------------------
// 守卫与工具
// ---------------------------------------------------------------------------

/** 判断任意 catch 到的值是否是本项目的自定义错误。 */
export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}

/** 把任意 catch 到的值转成可读字符串，用于错误信息与日志。 */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message === '' ? cause.name : `${cause.name}: ${cause.message}`;
  }
  if (typeof cause === 'string') {
    return cause;
  }
  return String(cause);
}
