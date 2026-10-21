/**
 * 会话层：**唯一**允许修改消息历史的地方。
 *
 * 契约见 docs/03-interfaces.md §6，6 条不变量逐条对应下面的实现：
 * 1. `snapshot()` 永不包含 system 消息（system 单独存）；
 * 2. 每次请求都是 `[system, ...snapshot(), user]` 现拼的；
 * 3. 回合是**事务式**的：只有模型成功返回才提交 user+assistant，
 *    失败时内部状态与调用前完全一致（不留半轮）；
 * 4. `reset()` 清空历史但保留 system prompt；
 * 5. `setSystemPrompt()` 只改 system prompt，不动历史；
 * 6. 超过 `maxHistoryMessages` 时从最旧开始**按整轮**丢弃，
 *    保持 user/assistant 配对（绝不留下「只有回答没有提问」的孤儿）。
 */

import { DEFAULT_MAX_HISTORY_MESSAGES } from '../config.js';
import type { LlmClient } from '../llm/llm-client.js';
import type { AssistantMessage, ChatMessage } from '../llm/types.js';

export interface TurnResult {
  readonly assistant: AssistantMessage;
  /** 本次回合的序号，1-based（`reset()` 后重置为 1）。 */
  readonly turnIndex: number;
  /** 提交后历史里的消息条数（不含 system）。 */
  readonly messageCount: number;
}

export interface TurnOptions {
  readonly signal?: AbortSignal;
}

export interface ChatSession {
  turn(userText: string, opts?: TurnOptions): Promise<TurnResult>;
  reset(): void;
  setSystemPrompt(text: string): void;
  getSystemPrompt(): string;
  /** 历史内容的拷贝（不含 system），调用方改不动内部状态。 */
  snapshot(): readonly ChatMessage[];
}

export interface ChatSessionDeps {
  readonly llm: LlmClient;
  readonly systemPrompt: string;
  /** 送进请求的历史消息上限，默认 `DEFAULT_MAX_HISTORY_MESSAGES`（40）。 */
  readonly maxHistoryMessages?: number;
}

/**
 * 把历史裁到 `maxMessages` 条以内。
 *
 * 丢弃单位是「一整轮」而不是「一条消息」：user/assistant 必须成对出现，
 * 否则模型会看到一条孤立的 assistant 消息，上下文直接错位。
 * 因此上限为奇数时实际保留偶数条 —— 少一条好过配对错位。
 */
export function trimHistory(messages: readonly ChatMessage[], maxMessages: number): ChatMessage[] {
  const limit = Math.max(0, maxMessages);
  const kept = [...messages];

  while (kept.length > limit) {
    // 每一轮固定两条：user 在前、assistant 在后。
    kept.splice(0, Math.min(2, kept.length));
  }

  return kept;
}

export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const maxHistoryMessages = deps.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;

  let systemPrompt = deps.systemPrompt;
  let history: ChatMessage[] = [];
  let turnCount = 0;

  /** system 永远临拼，不进 `history`。 */
  const buildMessages = (userText: string): readonly ChatMessage[] => [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userText },
  ];

  return {
    async turn(userText, opts) {
      // 先把请求发出去；这一行抛错时下面的提交代码不会执行 —— 事务的形。
      const assistant = await deps.llm.chat(buildMessages(userText), opts);

      turnCount += 1;
      history = trimHistory(
        [...history, { role: 'user', content: userText }, { role: 'assistant', content: assistant.content }],
        maxHistoryMessages,
      );

      return { assistant, turnIndex: turnCount, messageCount: history.length };
    },

    reset() {
      history = [];
      turnCount = 0;
    },

    setSystemPrompt(text) {
      systemPrompt = text;
    },

    getSystemPrompt() {
      return systemPrompt;
    },

    snapshot() {
      // 连消息对象一起拷贝：返回的数组既不能被 push，也不能被就地改写。
      return history.map((message) => ({ ...message }));
    },
  };
}
