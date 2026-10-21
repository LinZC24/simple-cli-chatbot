/**
 * 协议层：**唯一**知道 OpenAI 兼容协议长什么样的地方。
 *
 * 契约见 docs/03-interfaces.md §5。职责边界（越界即架构违规）：
 * - 负责：拼 `ChatCompletionRequest`、取 `Authorization`、调 `postJson`、
 *   校验响应形状、翻译成 `AssistantMessage`；
 * - 不负责：重试（传输层）、历史管理（会话层）、打印（CLI 层）。
 *
 * `ResponseShapeError` 只在这里产生 —— HTTP 层只保证「JSON 可解析」，
 * 「结构符合协议」是协议层的判断。
 */

import type { AppConfig } from '../config.js';
import { ResponseShapeError } from '../http/errors.js';
import { DEFAULT_BASE_DELAY_MS, DEFAULT_MAX_DELAY_MS, DEFAULT_MAX_RETRY_AFTER_MS } from '../http/retry.js';
import type { JsonResponse, RetryLogEvent, TransportOptions } from '../http/transport.js';
import type { AssistantMessage, ChatCompletionRequest, ChatMessage, FinishReason, Usage } from './types.js';

/**
 * 传输层注入点。
 *
 * 结构上与 `postJson` 一致（泛型参数在这里取 `unknown`），
 * 测试可以塞一个记账用的假实现，不必起服务器。
 */
export type TransportRequest = (
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>>,
  options: TransportOptions,
) => Promise<JsonResponse<unknown>>;

export interface LlmClientDeps {
  readonly config: AppConfig;
  readonly transport: TransportRequest;
  /** 重试日志回调：`[retry] attempt 1 failed: ServerError 500, retrying in 512ms (backoff)`。 */
  readonly log?: (message: string) => void;
}

export interface ChatOptions {
  readonly signal?: AbortSignal;
}

export interface LlmClient {
  chat(messages: readonly ChatMessage[], opts?: ChatOptions): Promise<AssistantMessage>;
}

/** 相对 `baseUrl` 的补全路径（`baseUrl` 已在配置层去掉尾斜杠）。 */
export const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** `finish_reason` 缺失时的占位值：既不谎称 `stop`，也不是错误。 */
const UNKNOWN_FINISH_REASON = 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * wire 形状：我们只读 `choices[0].message.content` 与可选的 `usage`。
 *
 * `choices` 声明成「至少一项」的 tuple，是为了让 `noUncheckedIndexedAccess`
 * 下的 `body.choices[0]` 不需要再加一次 `undefined` 判断 —— 长度检查在守卫里做。
 */
interface ChatCompletionResponse {
  readonly choices: readonly [{ readonly message: { readonly content: string }; readonly finish_reason?: unknown }, ...unknown[]];
  readonly usage?: unknown;
}

/**
 * 响应形状守卫：`choices[0].message.content` 必须是 string。
 *
 * 空串是合法的（模型可能只回了 tool call），所以判 `typeof === 'string'`
 * 而不是判真值 —— 判真值会把「合法空回复」误报成响应格式异常。
 */
export function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  if (!isRecord(value)) {
    return false;
  }

  const { choices } = value;
  if (!Array.isArray(choices) || choices.length === 0) {
    return false;
  }

  const first: unknown = choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    return false;
  }

  return typeof first.message.content === 'string';
}

/** `usage` 是诊断信息：三个数缺任意一个就当没有，绝不因为用量字段报错。 */
function readUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } = value;
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number' || typeof totalTokens !== 'number') {
    return undefined;
  }

  return { promptTokens, completionTokens, totalTokens };
}

function readFinishReason(value: unknown): FinishReason {
  return typeof value === 'string' && value !== '' ? value : UNKNOWN_FINISH_REASON;
}

/** 把任意 body 变成可截断的一行文本，给 `ResponseShapeError` 用。 */
function describeBody(body: unknown): string {
  try {
    return JSON.stringify(body) ?? String(body);
  } catch {
    return String(body);
  }
}

/** 构造请求体。可选字段「没配置就不产生该字段」，与配置层的口径保持一致。 */
function buildPayload(config: AppConfig, messages: readonly ChatMessage[]): ChatCompletionRequest {
  return {
    model: config.model,
    // 拷贝一份：调用方随后改动自己的数组也不该影响「已经发出的请求」。
    messages: [...messages],
    stream: false,
    ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
  };
}

function buildHeaders(config: AppConfig): Readonly<Record<string, string>> {
  // content-type 由传输层统一加，这里只放鉴权。
  return { authorization: `Bearer ${config.apiKey}` };
}

/** 退避参数不来自 .env，由这里补默认值；`signal` 只在有值时出现。 */
function buildTransportOptions(
  config: AppConfig,
  log: ((message: string) => void) | undefined,
  opts: ChatOptions | undefined,
): TransportOptions {
  const signal = opts?.signal;

  return {
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
    maxRetryAfterMs: DEFAULT_MAX_RETRY_AFTER_MS,
    ...(signal === undefined ? {} : { signal }),
    ...(log === undefined ? {} : { log: (event: RetryLogEvent) => log(formatRetryEvent(event)) }),
  };
}

/** 重试日志的单行格式（与 docs/04-roadmap.md 的演示输出一致）。 */
function formatRetryEvent(event: RetryLogEvent): string {
  const status = event.status === undefined ? '' : ` ${event.status}`;
  return `[retry] attempt ${event.attempt} failed: ${event.errorName}${status}, retrying in ${event.delayMs}ms (${event.reason})`;
}

export function createLlmClient(deps: LlmClientDeps): LlmClient {
  const { config, transport } = deps;
  const url = `${config.baseUrl}${CHAT_COMPLETIONS_PATH}`;

  return {
    async chat(messages, opts) {
      const response = await transport(url, buildPayload(config, messages), buildHeaders(config), buildTransportOptions(config, deps.log, opts));

      const body = response.body;
      if (!isChatCompletionResponse(body)) {
        throw new ResponseShapeError('missing choices[0].message.content', {
          body: describeBody(body),
          meta: { status: response.status, url },
        });
      }

      const [choice] = body.choices;
      const usage = readUsage(body.usage);

      return {
        role: 'assistant',
        content: choice.message.content,
        finishReason: readFinishReason(choice.finish_reason),
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}
