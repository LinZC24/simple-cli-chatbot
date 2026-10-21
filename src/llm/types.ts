/**
 * 协议类型：**只描述「消息」与「一次补全请求/响应」，不含任何运行时逻辑**。
 *
 * 契约见 docs/03-interfaces.md §1。这里的字段名（`max_tokens`、`finish_reason`）
 * 是 wire 形状，故意保持 snake_case：只有协议层（`llm-client.ts`）能碰它们，
 * 上层看到的一律是 `AssistantMessage`。
 */

/** 消息角色。`system` 永不进入会话历史，只在本轮请求时临时拼接。 */
export type Role = 'system' | 'user' | 'assistant';

/** 一条对话消息。`content` 恒为 string（空串合法，不是错误）。 */
export interface ChatMessage {
  readonly role: Role;
  readonly content: string;
}

/**
 * 一次 Chat Completions 请求体。
 *
 * `stream` 决定拿的是「整包 JSON」还是「SSE 增量」：开着思维链时必须是 `true`
 * （想边生成边看，就只能收增量）。
 * `tools` 是预留位，当前永不发送。
 */
export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly max_tokens?: number;
  readonly temperature?: number;
  /** 流式时让服务端在最后一帧带上 token 用量（OpenAI / DeepSeek 都支持）。 */
  readonly stream_options?: { readonly include_usage: boolean };
  readonly tools?: readonly unknown[];
}

/**
 * 流式增量：要么是思维链，要么是正文。
 *
 * 两者分开上报，是因为它们的渲染方式不同（思维链灰、正文正常），合成一个 `text`
 * 就没法在上层区分「该不该缩进」了。`kind` 取闭集，上层 `switch` 穷尽即可。
 */
export type ChatDelta =
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'content'; readonly text: string };

/** token 用量。仅用于诊断输出，缺失不算错误。 */
export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * 结束原因，来自 `finish_reason`。
 *
 * 不枚举成 union：各家 OpenAI 兼容服务会返回 `stop` / `length` / `content_filter`
 * 之外的私有值，硬枚举会让「上游多一个值」变成类型错误。
 */
export type FinishReason = string;

/**
 * 助手回复（会话层唯一接受的形态）。
 *
 * `content` 为空串是合法的：模型可能只回了 tool call 或直接触发 `length`。
 * `finishReason === 'length'` 也不是错误，由渲染层提示「回答被截断」。
 *
 * `reasoning` 是思维链（DeepSeek 的 `reasoning_content`）：只用于展示，
 * **永不进入会话历史** —— 历史里只有 `ChatMessage`，用不上它。
 */
export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly finishReason: FinishReason;
  readonly usage?: Usage;
  readonly reasoning?: string;
}
