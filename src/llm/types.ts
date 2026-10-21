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
 * `stream` 恒为 `false`：本项目的流式输出留到 v2。
 * `tools` 是预留位，当前永不发送。
 */
export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: false;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly tools?: readonly unknown[];
}

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
 */
export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: string;
  readonly finishReason: FinishReason;
  readonly usage?: Usage;
}
