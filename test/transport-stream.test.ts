import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthError, NetworkError, ResponseShapeError, ServerError, TimeoutError, UserAbortError } from '../src/http/errors.js';
import { postSse, type RetryLogEvent, type TransportOptions } from '../src/http/transport.js';
import { startFlakyServer } from './helpers/flaky-server.js';

/**
 * 流式的重试用例同样把退避压到 1ms：数值断言在 retry.test.ts，这里只看行为。
 * `timeoutMs` 在流式下是**空闲超时**（两块数据之间允许的最长间隔）。
 */
const fastOptions: TransportOptions = {
  timeoutMs: 5_000,
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 8,
  maxRetryAfterMs: 20_000,
};

function sseResponse(chunks: readonly string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** 收集整个流；中途抛错时把已收到的块一起带出来。 */
async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const seen: string[] = [];
  for await (const chunk of chunks) {
    seen.push(chunk);
  }
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// L2：桩替换 fetch
// ---------------------------------------------------------------------------

describe('postSse 成功路径', () => {
  it('返回状态码并逐块吐出正文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['data: 1\n\n', 'data: 2\n\n'])));

    const response = await postSse('https://x/y', { a: 1 }, {}, fastOptions);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await collect(response.chunks)).toEqual(['data: 1\n\n', 'data: 2\n\n']);
  });

  it('请求头要 accept: text/event-stream，body 原样序列化', async () => {
    const fake = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(['data: x\n\n']));
    vi.stubGlobal('fetch', fake);

    const response = await postSse('https://x/y', { stream: true }, { authorization: 'Bearer k' }, fastOptions);
    await collect(response.chunks);

    const init = fake.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.accept).toBe('text/event-stream');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer k');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ stream: true }));
  });

  it('多字节字符被切在两块之间也不会碎', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: 中文\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 从「中」的字节中间切开：第一块停在半个字符上。
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));

    const response = await postSse('https://x/y', {}, {}, fastOptions);

    expect((await collect(response.chunks)).join('')).toBe('data: 中文\n\n');
  });

  it('服务端无视 stream: true 回了整包 JSON：包成 SSE 帧交给上层', async () => {
    // 有的兼容网关（或本地调试代理）直接把整包 JSON 拿回来，内容仍是对的，不该算错。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"choices":[]}', { status: 200, headers: { 'content-type': 'application/json' } })),
    );

    const response = await postSse('https://x/y', {}, {}, fastOptions);

    expect((await collect(response.chunks)).join('')).toBe('data: {"choices":[]}\n\ndata: [DONE]\n\n');
  });
});

describe('postSse 错误映射', () => {
  it('401 抛 AuthError 且只请求一次', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));

    await expect(postSse('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(AuthError);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it('500 先重试再成功，日志记录重试事件', async () => {
    const log: RetryLogEvent[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 1 ? new Response('boom', { status: 500 }) : sseResponse(['data: ok\n\n']);
      }),
    );

    const response = await postSse('https://x/y', {}, {}, { ...fastOptions, log: (event) => log.push(event) });

    expect(await collect(response.chunks)).toEqual(['data: ok\n\n']);
    expect(log).toHaveLength(1);
    expect(log[0]?.errorName).toBe('ServerError');
    expect(log[0]?.status).toBe(500);
  });

  it('重试耗尽抛最后一次的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    await expect(postSse('https://x/y', {}, {}, { ...fastOptions, maxRetries: 2 })).rejects.toBeInstanceOf(ServerError);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
  });

  it('200 但没有 body 抛 ResponseShapeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const promise = postSse('https://x/y', {}, {}, fastOptions);
    await expect(promise).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('发送前就已取消：一次请求都不发', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: x\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(postSse('https://x/y', {}, {}, { ...fastOptions, signal: controller.signal })).rejects.toBeInstanceOf(
      UserAbortError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('重试等待期间取消：不再发第二次', async () => {
    const controller = new AbortController();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        // 第一次失败后立刻取消，退避等待应该被中断。
        controller.abort();
        return new Response('boom', { status: 500 });
      }),
    );

    await expect(
      postSse('https://x/y', {}, {}, { ...fastOptions, baseDelayMs: 50, signal: controller.signal }),
    ).rejects.toBeInstanceOf(UserAbortError);
    expect(call).toBe(1);
  });
});

describe('postSse 中途出错', () => {
  it('读流时断连抛 NetworkError（不重试）', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
            controller.error(new Error('socket hang up'));
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    const response = await postSse('https://x/y', {}, {}, fastOptions);
    await expect(collect(response.chunks)).rejects.toBeInstanceOf(NetworkError);
    // 已经开头了就不该重来：重试会把同样的字重复打一遍。
    expect(call).toBe(1);
  });

  it('中途取消抛 UserAbortError', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(inner) {
        inner.enqueue(new TextEncoder().encode('data: 1\n\n'));
        // 之后不再产出，等客户端取消。
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })));

    const response = await postSse('https://x/y', {}, {}, { ...fastOptions, signal: controller.signal });
    const seen: string[] = [];

    const promise = (async () => {
      for await (const chunk of response.chunks) {
        seen.push(chunk);
        controller.abort();
      }
    })();

    await expect(promise).rejects.toBeInstanceOf(UserAbortError);
    expect(seen).toEqual(['data: 1\n\n']);
  });

  it('两块数据间隔超过 timeoutMs 抛 TimeoutError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: 1\n\n'));
            // 之后永远不来数据：由空闲超时兜底。
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );

    const response = await postSse('https://x/y', {}, {}, { ...fastOptions, timeoutMs: 30 });
    await expect(collect(response.chunks)).rejects.toBeInstanceOf(TimeoutError);
  });
});

// ---------------------------------------------------------------------------
// L3：真 socket —— 证明「读完了就关连接、不泄漏句柄」
// ---------------------------------------------------------------------------

describe('postSse 真服务器', () => {
  it('按服务端节奏收块，读完正常结束', async () => {
    const server = await startFlakyServer([
      { kind: 'sse', chunks: ['{"a":1}', '{"a":2}', '[DONE]'], gapMs: 5 },
    ]);

    try {
      const response = await postSse(server.url, { stream: true }, {}, { ...fastOptions, timeoutMs: 1_000 });
      const chunks = await collect(response.chunks);

      expect(chunks.join('')).toBe('data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n');
      expect(server.hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('服务端中途断开：已收到的块保留，随后抛 NetworkError', async () => {
    const server = await startFlakyServer([{ kind: 'sse-destroy', chunks: ['{"a":1}'] }]);

    try {
      const response = await postSse(server.url, {}, {}, { ...fastOptions, timeoutMs: 2_000 });
      const seen: string[] = [];

      await expect(
        (async () => {
          for await (const chunk of response.chunks) {
            seen.push(chunk);
          }
        })(),
      ).rejects.toBeInstanceOf(NetworkError);
      expect(seen.join('')).toContain('{"a":1}');
    } finally {
      await server.close();
    }
  });

  it('服务端一直不结束：空闲超时真的把 socket 关掉', async () => {
    const server = await startFlakyServer([{ kind: 'sse', chunks: ['{"a":1}'], gapMs: 5_000 }]);

    try {
      const response = await postSse(server.url, {}, {}, { ...fastOptions, timeoutMs: 60 });
      await expect(collect(response.chunks)).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      await server.close();
    }
  });
});
