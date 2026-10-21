import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { AuthError, ResponseShapeError } from '../src/http/errors.js';
import { postJson, type TransportOptions } from '../src/http/transport.js';
import {
  CHAT_COMPLETIONS_PATH,
  createLlmClient,
  isChatCompletionResponse,
  type TransportRequest,
  type TransportStreamRequest,
} from '../src/llm/llm-client.js';
import type { ChatMessage } from '../src/llm/types.js';
import { startFlakyServer } from './helpers/flaky-server.js';

const config = loadConfig({ LLM_API_KEY: 'sk-test' });

const MESSAGES: readonly ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '你好' },
];

interface TransportCall {
  readonly url: string;
  readonly payload: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly options: TransportOptions;
}

/** 记账用的假传输层：不联网，把收到的参数原样存下来。 */
function createFakeTransport(body: unknown, status = 200): { transport: TransportRequest; calls: TransportCall[] } {
  const calls: TransportCall[] = [];

  const transport: TransportRequest = (url, payload, headers, options) => {
    calls.push({ url, payload, headers, options });
    return Promise.resolve({ status, headers: new Headers(), body });
  };

  return { transport, calls };
}

function okBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好呀' }, finish_reason: 'stop' }],
    ...overrides,
  };
}

describe('isChatCompletionResponse 守卫', () => {
  it('接受最小合法形状', () => {
    expect(isChatCompletionResponse(okBody())).toBe(true);
  });

  it('接受 content 为空字符串（模型可能只回了 tool call）', () => {
    expect(isChatCompletionResponse({ choices: [{ message: { content: '' } }] })).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['字符串', 'nope'],
    ['数组', []],
    ['缺少 choices', {}],
    ['choices 为空数组', { choices: [] }],
    ['choices 非数组', { choices: 'x' }],
    ['choice 不是对象', { choices: ['x'] }],
    ['缺少 message', { choices: [{ finish_reason: 'stop' }] }],
    ['message 不是对象', { choices: [{ message: 'x' }] }],
    ['content 是数字', { choices: [{ message: { content: 42 } }] }],
    ['content 缺失', { choices: [{ message: {} }] }],
  ])('%s → false', (_label, value) => {
    expect(isChatCompletionResponse(value)).toBe(false);
  });
});

describe('createLlmClient 请求构造', () => {
  it('拼接 baseUrl + /chat/completions', async () => {
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(calls[0]?.url).toBe(`${config.baseUrl}${CHAT_COMPLETIONS_PATH}`);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('发送指定 model、stream:false 与原始 messages', async () => {
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(calls[0]?.payload).toEqual({
      model: config.model,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
      ],
      stream: false,
    });
  });

  it('未配置 maxTokens / temperature 时不产生这两个字段', async () => {
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(calls[0]?.payload).not.toHaveProperty('max_tokens');
    expect(calls[0]?.payload).not.toHaveProperty('temperature');
  });

  it('配置了 maxTokens / temperature 时按 wire 名字发送', async () => {
    const tuned = loadConfig({ LLM_API_KEY: 'sk-test', LLM_MAX_TOKENS: '256', LLM_TEMPERATURE: '0.2' });
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => tuned, transport }).chat(MESSAGES);

    expect(calls[0]?.payload).toEqual({
      model: tuned.model,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '你好' },
      ],
      stream: false,
      max_tokens: 256,
      temperature: 0.2,
    });
  });

  it('带上 Bearer 鉴权头，不自己塞 content-type', async () => {
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(calls[0]?.headers).toEqual({ authorization: 'Bearer sk-test' });
  });

  it('请求里的 messages 是拷贝：调用方事后改数组不影响已发出的请求', async () => {
    const mutable: ChatMessage[] = [{ role: 'user', content: '第一句' }];
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(mutable);
    mutable.push({ role: 'user', content: '事后追加' });

    expect(calls[0]?.payload).toEqual({
      model: config.model,
      messages: [{ role: 'user', content: '第一句' }],
      stream: false,
    });
  });

  it('传输参数来自 config，退避参数用默认值', async () => {
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(calls[0]?.options).toMatchObject({
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      maxRetryAfterMs: 20_000,
    });
    expect(calls[0]?.options).not.toHaveProperty('signal');
  });

  it('透传 AbortSignal', async () => {
    const ac = new AbortController();
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(MESSAGES, { signal: ac.signal });

    expect(calls[0]?.options.signal).toBe(ac.signal);
  });
});

describe('createLlmClient 响应转换', () => {
  it('返回 AssistantMessage，并把 usage 转成驼峰', async () => {
    const body = okBody({
      choices: [{ message: { role: 'assistant', content: '你好呀' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const { transport } = createFakeTransport(body);

    const assistant = await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(assistant).toEqual({
      role: 'assistant',
      content: '你好呀',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it('usage 缺失时不产生 usage 字段', async () => {
    const { transport } = createFakeTransport(okBody());

    const assistant = await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(assistant).not.toHaveProperty('usage');
  });

  it('usage 字段类型不对时整块丢弃，不报错', async () => {
    const body = okBody({ usage: { prompt_tokens: 'ten', completion_tokens: 5, total_tokens: 15 } });
    const { transport } = createFakeTransport(body);

    const assistant = await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(assistant).not.toHaveProperty('usage');
  });

  it('content 为空串照样返回（不当作响应格式异常）', async () => {
    const body = okBody({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] });
    const { transport } = createFakeTransport(body);

    const assistant = await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(assistant.content).toBe('');
  });

  it('finish_reason 为 length 时原样保留（截断由渲染层提示）', async () => {
    const body = okBody({ choices: [{ message: { role: 'assistant', content: '半句话' }, finish_reason: 'length' }] });
    const { transport } = createFakeTransport(body);

    const assistant = await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(assistant.finishReason).toBe('length');
  });

  it('finish_reason 缺失时回落为 unknown，而不是报错', async () => {
    const body = okBody({ choices: [{ message: { role: 'assistant', content: 'hi' } }] });
    const { transport } = createFakeTransport(body);

    const assistant = await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(assistant.finishReason).toBe('unknown');
  });

  it('只取 choices[0]，忽略后续 choice', async () => {
    const body = okBody({
      choices: [
        { message: { role: 'assistant', content: '第一个' }, finish_reason: 'stop' },
        { message: { role: 'assistant', content: '第二个' }, finish_reason: 'stop' },
      ],
    });
    const { transport } = createFakeTransport(body);

    const assistant = await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(assistant.content).toBe('第一个');
  });
});

describe('createLlmClient 响应形状异常', () => {
  it('缺少 choices 时抛 ResponseShapeError', async () => {
    const { transport, calls } = createFakeTransport({ object: 'chat.completion' });

    await expect(createLlmClient({ config: () => config, transport }).chat(MESSAGES)).rejects.toBeInstanceOf(ResponseShapeError);
    expect(calls).toHaveLength(1);
  });

  it('content 不是字符串时抛 ResponseShapeError', async () => {
    const body = okBody({ choices: [{ message: { role: 'assistant', content: null } }] });
    const { transport } = createFakeTransport(body);

    await expect(createLlmClient({ config: () => config, transport }).chat(MESSAGES)).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('错误信息里带状态码与截断后的 body', async () => {
    const { transport } = createFakeTransport({ object: 'unexpected' }, 200);

    const error: unknown = await createLlmClient({ config: () => config, transport })
      .chat(MESSAGES)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ResponseShapeError);
    expect(error instanceof Error ? error.message : '').toContain('choices[0].message.content');
    expect(error instanceof ResponseShapeError ? error.meta : undefined).toMatchObject({
      status: 200,
      url: 'https://api.openai.com/v1/chat/completions',
    });
  });
});

describe('createLlmClient 与传输层错误的边界', () => {
  it('传输层的 AgentError 原样上抛，不被包装成响应形状错误', async () => {
    const original = new AuthError({ status: 401 });
    const transport: TransportRequest = () => Promise.reject(original);

    await expect(createLlmClient({ config: () => config, transport }).chat(MESSAGES)).rejects.toBe(original);
  });

  it('重试日志被格式化成单行 [retry] 文案', async () => {
    const logs: string[] = [];
    const { transport, calls } = createFakeTransport(okBody());
    const client = createLlmClient({ config: () => config, transport, log: (message: string) => logs.push(message) });

    await client.chat(MESSAGES);
    calls[0]?.options.log?.({
      attempt: 1,
      delayMs: 512,
      errorName: 'ServerError',
      status: 500,
      reason: 'backoff',
    });

    expect(logs).toEqual(['[retry] attempt 1 failed: ServerError 500, retrying in 512ms (backoff)']);
  });

  it('Retry-After 场景的日志同样带状态码与原因', async () => {
    const logs: string[] = [];
    const { transport, calls } = createFakeTransport(okBody());
    const client = createLlmClient({ config: () => config, transport, log: (message: string) => logs.push(message) });

    await client.chat(MESSAGES);
    calls[0]?.options.log?.({
      attempt: 2,
      delayMs: 2_000,
      errorName: 'RateLimitError',
      status: 429,
      reason: 'retry-after',
    });

    expect(logs).toEqual(['[retry] attempt 2 failed: RateLimitError 429, retrying in 2000ms (retry-after)']);
  });

  it('没有 log 回调时传输层提供的 log 也不存在（不炸）', async () => {
    const { transport, calls } = createFakeTransport(okBody());

    await createLlmClient({ config: () => config, transport }).chat(MESSAGES);

    expect(calls[0]?.options.log).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L3：协议层 + 真传输层 + 本地假服务器（证明三层能装到一起）
// ---------------------------------------------------------------------------

describe('协议层与传输层串联', () => {
  it('500 一次后成功：拿到 assistant 内容，且日志里出现一行 retry', async () => {
    const server = await startFlakyServer([
      { kind: 'status', code: 500 },
      { kind: 'ok', body: { choices: [{ message: { role: 'assistant', content: 'from-server' }, finish_reason: 'stop' }] } },
    ]);
    try {
      const logs: string[] = [];
      const client = createLlmClient({
        config: () => loadConfig({ LLM_API_KEY: 'sk-test', LLM_BASE_URL: server.url }),
        transport: postJson,
        log: (message: string) => logs.push(message),
      });

      const assistant = await client.chat(MESSAGES);

      expect(assistant.content).toBe('from-server');
      expect(assistant.finishReason).toBe('stop');
      expect(server.hits).toBe(2);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^\[retry\] attempt 1 failed: ServerError 500, retrying in \d+ms \(backoff\)$/);
    } finally {
      await server.close();
    }
  });

  it('配置读取器让改动在下一回合生效（model / maxTokens 都是现取的）', async () => {
    let current = loadConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'first-model' });
    const { transport, calls } = createFakeTransport(okBody());
    const client = createLlmClient({ config: () => current, transport });

    await client.chat(MESSAGES);
    current = loadConfig({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'second-model', LLM_MAX_TOKENS: '64' });
    await client.chat(MESSAGES);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.payload).toMatchObject({ model: 'first-model' });
    expect(calls[1]?.payload).toMatchObject({ model: 'second-model', max_tokens: 64 });
    // 每次都要重新拼 URL：改 baseUrl 之后也应当打到新地址。
    expect(calls[1]?.url).toBe(calls[0]?.url);
  });

  it('401 直接抛 AuthError，一次请求都不重试', async () => {
    const server = await startFlakyServer([{ kind: 'status', code: 401 }]);
    try {
      const client = createLlmClient({
        config: () => loadConfig({ LLM_API_KEY: 'sk-test', LLM_BASE_URL: server.url }),
        transport: postJson,
      });

      await expect(client.chat(MESSAGES)).rejects.toBeInstanceOf(AuthError);
      expect(server.hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('200 但 body 形状不对时由协议层报 ResponseShapeError', async () => {
    const server = await startFlakyServer([{ kind: 'ok', body: { object: 'chat.completion' } }]);
    try {
      const client = createLlmClient({
        config: () => loadConfig({ LLM_API_KEY: 'sk-test', LLM_BASE_URL: server.url }),
        transport: postJson,
      });

      await expect(client.chat(MESSAGES)).rejects.toBeInstanceOf(ResponseShapeError);
      expect(server.hits).toBe(1);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 流式路径（`onDelta` + `streamTransport`）
// ---------------------------------------------------------------------------

interface StreamCall {
  readonly url: string;
  readonly payload: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/** 把若干 `data:` 负荷拼成一段 SSE 文本流（一次给完整块，跨块切分由 sse 测试覆盖）。 */
async function* sseChunks(payloads: readonly string[]): AsyncIterable<string> {
  for (const payload of payloads) {
    yield `data: ${payload}\n\n`;
  }
}

function createFakeStreamTransport(
  payloads: readonly string[],
): { streamTransport: TransportStreamRequest; calls: StreamCall[] } {
  const calls: StreamCall[] = [];
  const streamTransport: TransportStreamRequest = (url, payload, headers) => {
    calls.push({ url, payload, headers });
    return Promise.resolve({ status: 200, headers: new Headers(), chunks: sseChunks(payloads) });
  };
  return { streamTransport, calls };
}

function chunkOf(delta: Record<string, unknown>, finishReason?: string): string {
  const choice: Record<string, unknown> = { index: 0, delta };
  if (finishReason !== undefined) {
    choice.finish_reason = finishReason;
  }
  return JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', choices: [choice] });
}

describe('流式：增量上报与聚合', () => {
  it('思维链与正文分别上报，聚合后的 message 两者都留', async () => {
    const { streamTransport, calls } = createFakeStreamTransport([
      chunkOf({ role: 'assistant', reasoning_content: '先算 ' }),
      chunkOf({ reasoning_content: '9.9 - 9.11' }),
      chunkOf({ content: '9.9 ' }),
      chunkOf({ content: '更大' }),
      chunkOf({}, 'stop'),
      '[DONE]',
    ]);
    const client = createLlmClient({ config: () => config, transport: postJson, streamTransport });
    const deltas: string[] = [];

    const message = await client.chat(MESSAGES, {
      onDelta: (delta) => deltas.push(`${delta.kind}:${delta.text}`),
    });

    expect(deltas).toEqual(['reasoning:先算 ', 'reasoning:9.9 - 9.11', 'content:9.9 ', 'content:更大']);
    expect(message.content).toBe('9.9 更大');
    expect(message.reasoning).toBe('先算 9.9 - 9.11');
    expect(message.finishReason).toBe('stop');

    const payload = calls[0]?.payload as Record<string, unknown>;
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
  });

  it('`reasoning` 字段名也认（不同家叫法不同）', async () => {
    const { streamTransport } = createFakeStreamTransport([chunkOf({ reasoning: '想一想' }), '[DONE]']);
    const client = createLlmClient({ config: () => config, transport: postJson, streamTransport });
    const kinds: string[] = [];

    const message = await client.chat(MESSAGES, { onDelta: (delta) => kinds.push(delta.kind) });

    expect(kinds).toEqual(['reasoning']);
    expect(message.reasoning).toBe('想一想');
    expect(message.content).toBe('');
  });

  it('收尾帧只带 usage：不上报空 delta，用量写进结果', async () => {
    const { streamTransport } = createFakeStreamTransport([
      chunkOf({ content: '好' }, 'stop'),
      JSON.stringify({
        id: 'chatcmpl-x',
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
      '[DONE]',
    ]);
    const client = createLlmClient({ config: () => config, transport: postJson, streamTransport });
    const deltas: string[] = [];

    const message = await client.chat(MESSAGES, { onDelta: (delta) => deltas.push(delta.text) });

    expect(deltas).toEqual(['好']);
    expect(message.usage).toEqual({ promptTokens: 7, completionTokens: 2, totalTokens: 9 });
  });

  it('一个帧都没有：响应形状错误', async () => {
    const { streamTransport } = createFakeStreamTransport(['[DONE]']);
    const client = createLlmClient({ config: () => config, transport: postJson, streamTransport });

    await expect(client.chat(MESSAGES, { onDelta: () => {} })).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('delta.content 不是字符串：报形状错误而不是静默丢掉', async () => {
    const { streamTransport } = createFakeStreamTransport([chunkOf({ content: 42 })]);
    const client = createLlmClient({ config: () => config, transport: postJson, streamTransport });

    await expect(client.chat(MESSAGES, { onDelta: () => {} })).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('流里出现 error 载荷：报形状错误（附上原始负荷）', async () => {
    const { streamTransport } = createFakeStreamTransport([
      JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }),
    ]);
    const client = createLlmClient({ config: () => config, transport: postJson, streamTransport });

    await expect(client.chat(MESSAGES, { onDelta: () => {} })).rejects.toThrow(/error payload/);
  });

  it('没有 finish_reason 时回落 unknown，而不是当成错误', async () => {
    const { streamTransport } = createFakeStreamTransport([chunkOf({ content: '半句' })]);
    const client = createLlmClient({ config: () => config, transport: postJson, streamTransport });

    const message = await client.chat(MESSAGES, { onDelta: () => {} });

    expect(message.finishReason).toBe('unknown');
  });

  it('没要增量时即使接了流式通道也走整包请求（stream: false）', async () => {
    const { transport, calls } = createFakeTransport(okBody());
    const { streamTransport, calls: streamCalls } = createFakeStreamTransport([chunkOf({ content: '不该出现' })]);
    const client = createLlmClient({ config: () => config, transport, streamTransport });

    const message = await client.chat(MESSAGES);

    expect(message.content).toBe('你好呀');
    expect(streamCalls).toHaveLength(0);
    expect((calls[0]?.payload as Record<string, unknown>).stream).toBe(false);
  });

  it('没有流式通道时把整包结果当成一帧上报', async () => {
    const { transport } = createFakeTransport(
      okBody({ choices: [{ message: { content: '整包', reasoning_content: '先想' }, finish_reason: 'stop' }] }),
    );
    const client = createLlmClient({ config: () => config, transport });
    const deltas: string[] = [];

    const message = await client.chat(MESSAGES, { onDelta: (delta) => deltas.push(`${delta.kind}:${delta.text}`) });

    expect(deltas).toEqual(['reasoning:先想', 'content:整包']);
    expect(message.reasoning).toBe('先想');
  });
});
