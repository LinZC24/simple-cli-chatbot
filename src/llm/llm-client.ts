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
import type { JsonResponse, RetryLogEvent, StreamResponse, TransportOptions } from '../http/transport.js';
import { parseSseStream } from './sse.js';
import type {
  AssistantMessage,
  ChatCompletionRequest,
  ChatDelta,
  ChatMessage,
  FinishReason,
  Usage,
} from './types.js';

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

/**
 * 流式传输注入点，结构上与 `postSse` 一致。
 *
 * 不设成必填：不注它的时候 `chat` 走整包 JSON，把内容当成一个 delta 交出去 ——
 * 上层（会话层 / CLI）只写一份逻辑，不用为「流不流」分叉。
 */
export type TransportStreamRequest = (
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>>,
  options: TransportOptions,
) => Promise<StreamResponse>;

export interface LlmClientDeps {
  /**
   * 配置**读取器**而不是配置本身：`/config` 可以在会话内改 model / maxTokens / temperature，
   * 每次请求现取一次，改动下一回合就生效（启动时的对象是 `Object.freeze` 的，改不动）。
   */
  readonly config: () => AppConfig;
  readonly transport: TransportRequest;
  /** 流式通道（`postSse`）。不注入时退化成整包请求。 */
  readonly streamTransport?: TransportStreamRequest;
  /** 重试日志回调：`[retry] attempt 1 failed: ServerError 500, retrying in 512ms (backoff)`。 */
  readonly log?: (message: string) => void;
}

export interface ChatOptions {
  readonly signal?: AbortSignal;
  /**
   * 增量回调：给了就尽量走流式（思维链与正文分开上报）。
   *
   * 回调抛错不算协议错误 —— 那是渲染层的问题，这里不拦。
   */
  readonly onDelta?: (delta: ChatDelta) => void;
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
function buildPayload(config: AppConfig, messages: readonly ChatMessage[], stream: boolean): ChatCompletionRequest {
  return {
    model: config.model,
    // 拷贝一份：调用方随后改动自己的数组也不该影响「已经发出的请求」。
    messages: [...messages],
    stream,
    ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    // 只要流式，就要用量：否则 debug 日志里永远没有 token 数。
    ...(stream ? { stream_options: { include_usage: true } } : {}),
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

/** 流式里一帧的 wire 形状：`choices[0].delta`，最后一帧带 `finish_reason`。 */
interface ChatCompletionChunk {
  readonly choices?: readonly unknown[];
  readonly usage?: unknown;
  readonly error?: unknown;
}

/**
 * 读一段 `delta` 字段：思维链可能叫 `reasoning_content`（DeepSeek）或 `reasoning`（其它家）。
 *
 * `null` 当作没有（有些服务端会显式发 `"content": null`）；数字/对象则算形状错误 ——
 * 默默忽略会让「模型回复被吞掉」变成一个查不出来的 bug。
 */
function readDeltaText(delta: Record<string, unknown>, field: 'content' | 'reasoning_content' | 'reasoning'): string | undefined {
  const value = delta[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ResponseShapeError(`stream delta.${field} is not a string`, { body: describeBody(delta) });
  }
  return value === '' ? undefined : value;
}

/**
 * 把一帧 chunk 翻成增量，并累加器装上思维链 / 正文 / 结束原因 / 用量。
 *
 * 一个 chunk 理论上可以同时带思维链与正文（切换到回答的那一帧），所以两个 `onDelta`
 * 先后上报而不互斥。
 */
function applyChunk(
  chunk: ChatCompletionChunk,
  state: { content: string; reasoning: string; finishReason: FinishReason | undefined; usage: Usage | undefined },
  onDelta: (delta: ChatDelta) => void,
): void {
  const usage = readUsage(chunk.usage);
  if (usage !== undefined) {
    state.usage = usage;
  }

  const { choices } = chunk;
  if (!Array.isArray(choices) || choices.length === 0) {
    // 只带 usage 的收尾帧就属于这种：合法，不再往下读。
    return;
  }

  const first: unknown = choices[0];
  if (!isRecord(first)) {
    throw new ResponseShapeError('stream choices[0] is not an object', { body: describeBody(chunk) });
  }

  const finishReason = readFinishReasonOrUndefined(first.finish_reason);
  if (finishReason !== undefined) {
    state.finishReason = finishReason;
  }

  const rawDelta = first.delta;
  if (rawDelta === undefined) {
    return;
  }
  if (!isRecord(rawDelta)) {
    throw new ResponseShapeError('stream choices[0].delta is not an object', { body: describeBody(chunk) });
  }

  const reasoning = readDeltaText(rawDelta, 'reasoning_content') ?? readDeltaText(rawDelta, 'reasoning');
  if (reasoning !== undefined) {
    state.reasoning += reasoning;
    onDelta({ kind: 'reasoning', text: reasoning });
  }

  const content = readDeltaText(rawDelta, 'content');
  if (content !== undefined) {
    state.content += content;
    onDelta({ kind: 'content', text: content });
  }
}

function readFinishReasonOrUndefined(value: unknown): FinishReason | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 一个 `data:` 负荷。`[DONE]` 是 OpenAI 系的收尾哨兵，不是 JSON。 */
function parseSsePayload(data: string, url: string): ChatCompletionChunk | 'done' {
  if (data === '[DONE]') {
    return 'done';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ResponseShapeError('stream chunk is not valid JSON', { body: data, meta: { url } });
  }

  if (!isRecord(parsed)) {
    throw new ResponseShapeError('stream chunk is not an object', { body: data, meta: { url } });
  }

  // 有的服务端在过载时用一帧 `{"error": ...}` 代替正常帧：这不是命令错误，
  // 而是上游在罢工，归入服务端错误更诚实（且不会重试起步式的多次请求）。
  if (parsed.error !== undefined) {
    throw new ResponseShapeError('stream reported an error payload', {
      body: describeBody(parsed.error),
      meta: { url },
    });
  }

  return parsed;
}

/**
 * 消完整个 SSE 流，返回聚合后的 `AssistantMessage`。
 *
 * 边界：
 * - `[DONE]` 提前结束（不依赖服务端关连接）；
 * - 流里一个帧都没有 → 响应形状错误（多半是网关把流吃了）；
 * - 只有思维链没有正文 → 合法（模型被 `length` 截断在思考阶段），交给渲染层处理。
 */
async function readChatStream(
  chunks: AsyncIterable<string>,
  url: string,
  onDelta: (delta: ChatDelta) => void,
): Promise<AssistantMessage> {
  const state: {
    content: string;
    reasoning: string;
    finishReason: FinishReason | undefined;
    usage: Usage | undefined;
  } = { content: '', reasoning: '', finishReason: undefined, usage: undefined };
  let frames = 0;

  for await (const event of parseSseStream(chunks)) {
    const chunk = parseSsePayload(event.data, url);
    if (chunk === 'done') {
      break;
    }
    frames += 1;
    applyChunk(chunk, state, onDelta);
  }

  if (frames === 0) {
    throw new ResponseShapeError('stream contains no chunk', { meta: { url } });
  }

  return {
    role: 'assistant',
    content: state.content,
    finishReason: state.finishReason ?? UNKNOWN_FINISH_REASON,
    ...(state.usage === undefined ? {} : { usage: state.usage }),
    ...(state.reasoning === '' ? {} : { reasoning: state.reasoning }),
  };
}

export function createLlmClient(deps: LlmClientDeps): LlmClient {
  const { transport, streamTransport } = deps;

  return {
    async chat(messages, opts) {
      const config = deps.config();
      const url = `${config.baseUrl}${CHAT_COMPLETIONS_PATH}`;
      const onDelta = opts?.onDelta;
      const transportOptions = buildTransportOptions(config, deps.log, opts);

      // 没要增量、或没接流式通道：整包请求，把结果当成一个 delta 交出去。
      if (onDelta === undefined || streamTransport === undefined) {
        const response = await transport(
          url,
          buildPayload(config, messages, false),
          buildHeaders(config),
          transportOptions,
        );
        const message = readResponse(response, url);
        emitMessage(onDelta, message);
        return message;
      }

      const response = await streamTransport(
        url,
        buildPayload(config, messages, true),
        buildHeaders(config),
        transportOptions,
      );
      return readChatStream(response.chunks, url, onDelta);
    },
  };
}

/** 整包响应退化成流式上报：把结果当成一两帧交出去，上层不用为「流不流」分叉。 */
function emitMessage(onDelta: ((delta: ChatDelta) => void) | undefined, message: AssistantMessage): void {
  if (onDelta === undefined) {
    return;
  }
  if (message.reasoning !== undefined) {
    onDelta({ kind: 'reasoning', text: message.reasoning });
  }
  onDelta({ kind: 'content', text: message.content });
}

/** 整包 JSON 路径的读出：形状校验 + 翻成 `AssistantMessage`。 */
function readResponse(response: JsonResponse<unknown>, url: string): AssistantMessage {
  const body = response.body;
  if (!isChatCompletionResponse(body)) {
    throw new ResponseShapeError('missing choices[0].message.content', {
      body: describeBody(body),
      meta: { status: response.status, url },
    });
  }

  const [choice] = body.choices;
  const usage = readUsage(body.usage);
  const reasoning = readNonStreamingReasoning(choice.message);

  return {
    role: 'assistant',
    content: choice.message.content,
    finishReason: readFinishReason(choice.finish_reason),
    ...(usage === undefined ? {} : { usage }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** 非流式响应里的思维链（DeepSeek 的 `reasoning_content`）—— 只用于展示。 */
function readNonStreamingReasoning(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const value = message.reasoning_content ?? message.reasoning;
  return typeof value === 'string' && value !== '' ? value : undefined;
}
