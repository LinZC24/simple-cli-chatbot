import { describe, expect, it } from 'vitest';

import type { LlmClient } from '../src/llm/llm-client.js';
import type { ChatMessage } from '../src/llm/types.js';
import { createChatSession, trimHistory } from '../src/session/chat-session.js';

const SYSTEM = '你是测试助手。';

/**
 * 记账用的假 LlmClient：`replies` 依次作为助手回复，并把每次收到的 messages 存下来。
 * 会话层的测试不该联网，也不该经过协议层 —— 这里只验证「拼了什么」。
 */
function createStubLlm(replies: readonly string[] = []): { llm: LlmClient; requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  let index = 0;

  const llm: LlmClient = {
    async chat(messages) {
      requests.push(messages.map((message) => ({ ...message })));
      const reply = replies[index] ?? `reply-${index + 1}`;
      index += 1;
      return { role: 'assistant', content: reply, finishReason: 'stop' };
    },
  };

  return { llm, requests };
}

function createSession(llm: LlmClient, maxHistoryMessages?: number) {
  return createChatSession({
    llm,
    systemPrompt: SYSTEM,
    ...(maxHistoryMessages === undefined ? {} : { maxHistoryMessages }),
  });
}

describe('ChatSession 不变量 ①②：system 不进历史，请求现拼', () => {
  it('snapshot 不含 system，且等于 [user, assistant]', async () => {
    const { llm } = createStubLlm(['a1']);
    const session = createSession(llm);

    await session.turn('u1');

    expect(session.snapshot()).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(session.snapshot().some((message) => message.role === 'system')).toBe(false);
  });

  it('请求体是 [system, ...snapshot, user]，system 排在最前', async () => {
    const { llm, requests } = createStubLlm(['a1']);
    const session = createSession(llm);

    await session.turn('u1');

    expect(requests[0]).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'u1' },
    ]);
  });

  it('三轮之后第 3 次请求能看到第 1、2 轮的 user 与 assistant', async () => {
    const { llm, requests } = createStubLlm(['a1', 'a2', 'a3']);
    const session = createSession(llm);

    await session.turn('u1');
    await session.turn('u2');
    await session.turn('u3');

    // docs/05-testing.md 测试矩阵第 14 条：上下文必须顺序拼接。
    expect(requests[2]).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);
  });

  it('只有一条 system，不会随轮次累积', async () => {
    const { llm, requests } = createStubLlm(['a1', 'a2']);
    const session = createSession(llm);

    await session.turn('u1');
    await session.turn('u2');

    const systems = requests[1]?.filter((message) => message.role === 'system') ?? [];
    expect(systems).toHaveLength(1);
  });

  it('turn 返回的 assistant 与提交进历史的内容一致', async () => {
    const { llm } = createStubLlm(['a1']);
    const session = createSession(llm);

    const result = await session.turn('u1');

    expect(result.assistant.content).toBe('a1');
    expect(result.assistant.role).toBe('assistant');
    expect(result.turnIndex).toBe(1);
    expect(result.messageCount).toBe(2);
  });

  it('turnIndex 随回合递增，messageCount 反映历史条数', async () => {
    const { llm } = createStubLlm(['a1', 'a2', 'a3']);
    const session = createSession(llm);

    const first = await session.turn('u1');
    const second = await session.turn('u2');
    const third = await session.turn('u3');

    expect([first.turnIndex, second.turnIndex, third.turnIndex]).toEqual([1, 2, 3]);
    expect([first.messageCount, second.messageCount, third.messageCount]).toEqual([2, 4, 6]);
  });
});

describe('ChatSession 不变量 ③：失败回合不改状态', () => {
  it('llm 抛错后 snapshot 与调用前 toEqual', async () => {
    let failNext = false;
    const llm: LlmClient = {
      chat: () => {
        if (failNext) {
          return Promise.reject(new Error('boom'));
        }
        return Promise.resolve({ role: 'assistant', content: 'a1', finishReason: 'stop' });
      },
    };
    const session = createChatSession({ llm, systemPrompt: SYSTEM });
    await session.turn('u1');

    const before = session.snapshot();
    failNext = true;

    await expect(session.turn('u2')).rejects.toThrow('boom');

    expect(session.snapshot()).toEqual(before);
    expect(before).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('第一轮就失败时历史保持为空', async () => {
    const session = createChatSession({ llm: { chat: () => Promise.reject(new Error('boom')) }, systemPrompt: SYSTEM });

    await expect(session.turn('u1')).rejects.toThrow('boom');

    expect(session.snapshot()).toEqual([]);
    expect(session.getSystemPrompt()).toBe(SYSTEM);
  });

  it('失败回合不推进 turnIndex（下一轮仍是第 1 回合）', async () => {
    let calls = 0;
    const llm: LlmClient = {
      chat: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ role: 'assistant', content: 'a1', finishReason: 'stop' });
      },
    };
    const session = createChatSession({ llm, systemPrompt: SYSTEM });

    await expect(session.turn('u1')).rejects.toThrow('boom');
    const result = await session.turn('u1-retry');

    expect(result.turnIndex).toBe(1);
    expect(session.snapshot()).toEqual([
      { role: 'user', content: 'u1-retry' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('请求进行中读 snapshot 仍是调用前的状态（事务未提交）', async () => {
    let seen: readonly ChatMessage[] = [];
    const session = createChatSession({
      llm: {
        chat: () => {
          seen = session.snapshot();
          return Promise.resolve({ role: 'assistant', content: 'a1', finishReason: 'stop' });
        },
      },
      systemPrompt: SYSTEM,
    });

    await session.turn('u1');

    expect(seen).toEqual([]);
  });

  it('空字符串回复也是合法的一轮（content 为空串不是错误）', async () => {
    const { llm } = createStubLlm(['']);
    const session = createSession(llm);

    await session.turn('u1');

    expect(session.snapshot()).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '' },
    ]);
  });
});

describe('ChatSession 不变量 ④⑤：reset 与 setSystemPrompt', () => {
  it('reset 后 snapshot 为空且 system prompt 不变', async () => {
    const { llm } = createStubLlm(['a1']);
    const session = createSession(llm);
    await session.turn('u1');

    session.reset();

    expect(session.snapshot()).toEqual([]);
    expect(session.getSystemPrompt()).toBe(SYSTEM);
  });

  it('reset 之后回合序号从 1 重新开始', async () => {
    const { llm } = createStubLlm(['a1', 'a2']);
    const session = createSession(llm);
    await session.turn('u1');
    session.reset();

    const result = await session.turn('u2');

    expect(result.turnIndex).toBe(1);
  });

  it('setSystemPrompt 不改历史，但下一次请求用新的 system', async () => {
    const { llm, requests } = createStubLlm(['a1', 'a2']);
    const session = createSession(llm);
    await session.turn('u1');
    const before = session.snapshot();

    session.setSystemPrompt('新的 system');
    expect(session.snapshot()).toEqual(before);
    expect(session.getSystemPrompt()).toBe('新的 system');

    await session.turn('u2');
    expect(requests[1]?.[0]).toEqual({ role: 'system', content: '新的 system' });
  });
});

describe('ChatSession 不变量 ⑥：历史裁剪', () => {
  it('默认上限 40 条：20 轮之内不丢消息', async () => {
    const replies = Array.from({ length: 20 }, (_unused, index) => `a${index + 1}`);
    const { llm } = createStubLlm(replies);
    const session = createSession(llm);

    for (let index = 1; index <= 20; index += 1) {
      await session.turn(`u${index}`);
    }

    expect(session.snapshot()).toHaveLength(40);
    expect(session.snapshot()[0]).toEqual({ role: 'user', content: 'u1' });
  });

  it('超出上限时从最旧开始按整轮丢弃，且保持 user/assistant 配对', async () => {
    const { llm } = createStubLlm(['a1', 'a2', 'a3']);
    const session = createSession(llm, 4);

    await session.turn('u1');
    await session.turn('u2');
    await session.turn('u3');

    expect(session.snapshot()).toEqual([
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    ]);
  });

  it('上限为奇数时保留偶数条，宁可少一条也不留下孤儿消息', async () => {
    const { llm } = createStubLlm(['a1', 'a2', 'a3']);
    const session = createSession(llm, 5);

    await session.turn('u1');
    await session.turn('u2');
    await session.turn('u3');

    const snapshot = session.snapshot();
    expect(snapshot).toHaveLength(4);
    expect(snapshot[0]?.role).toBe('user');
    expect(snapshot.at(-1)?.role).toBe('assistant');
  });

  it('裁剪后发出的请求同样不含被丢掉的那一轮', async () => {
    const { llm, requests } = createStubLlm(['a1', 'a2', 'a3']);
    const session = createSession(llm, 2);

    await session.turn('u1');
    await session.turn('u2');
    await session.turn('u3');

    expect(requests[2]).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);
  });
});

describe('ChatSession 防御性拷贝', () => {
  it('改动 snapshot 返回的消息对象不影响内部历史', async () => {
    const { llm } = createStubLlm(['a1']);
    const session = createSession(llm);
    await session.turn('u1');

    const [first] = session.snapshot();
    expect(first).toBeDefined();
    // `readonly` 只是编译期约束；这里验证的是运行时确实给了拷贝。
    Object.assign(first ?? {}, { content: '被改' });

    expect(session.snapshot()).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('两次 snapshot 返回不同的数组实例', async () => {
    const { llm } = createStubLlm(['a1']);
    const session = createSession(llm);
    await session.turn('u1');

    expect(session.snapshot()).not.toBe(session.snapshot());
  });
});

describe('trimHistory', () => {
  const history: readonly ChatMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
  ];

  it('未超限时原样返回内容', () => {
    expect(trimHistory(history, 10)).toEqual(history);
  });

  it('按整轮从最旧开始丢', () => {
    expect(trimHistory(history, 2)).toEqual([
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('上限为 0 时清空', () => {
    expect(trimHistory(history, 0)).toEqual([]);
  });

  it('负数上限当作 0 处理', () => {
    expect(trimHistory(history, -3)).toEqual([]);
  });

  it('不修改入参', () => {
    const input = [...history];
    trimHistory(input, 2);

    expect(input).toHaveLength(4);
  });

  it('返回新数组（即便没有裁剪）', () => {
    expect(trimHistory(history, 10)).not.toBe(history);
  });
});
