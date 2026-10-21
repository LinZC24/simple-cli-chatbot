import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AuthError,
  BadRequestError,
  NetworkError,
  RateLimitError,
  ResponseShapeError,
  ServerError,
  TimeoutError,
  UserAbortError,
} from '../src/http/errors.js';
import { postJson, type RetryLogEvent, type TransportOptions } from '../src/http/transport.js';
import { startFlakyServer } from './helpers/flaky-server.js';

/**
 * 退避压到 1ms 是刻意的：重试逻辑的**数值**在 retry.test.ts 里断言，
 * 这里只关心「次数与分类」，不该为了验证逻辑真的等 1.5 秒。
 */
const fastOptions: TransportOptions = {
  timeoutMs: 5_000,
  maxRetries: 3,
  baseDelayMs: 1,
  maxDelayMs: 8,
  maxRetryAfterMs: 20_000,
};

function jsonResponse(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function textResponse(status: number, body: string, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// L2：桩替换 fetch —— 断言次数与分类
// ---------------------------------------------------------------------------

describe('postJson 成功路径', () => {
  it('200 返回解析后的 JSON、状态码与响应头', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ok: 1 }, { 'x-request-id': 'req-1' })));

    const response = await postJson<{ ok: number }>('https://x/y', { a: 1 }, {}, fastOptions);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: 1 });
    expect(response.headers.get('x-request-id')).toBe('req-1');
  });

  it('按契约发送 POST + JSON 头 + 序列化后的 body', async () => {
    const fake = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fake);

    await postJson('https://x/y', { model: 'm' }, { authorization: 'Bearer k' }, fastOptions);

    expect(fake).toHaveBeenCalledTimes(1);
    const [url, init] = fake.mock.calls[0] ?? ['', {}];
    expect(url).toBe('https://x/y');
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ model: 'm' }),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer k',
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('postJson 重试', () => {
  it('500 两次后成功，共请求 3 次', async () => {
    let calls = 0;
    const fake = vi.fn(async () => {
      calls += 1;
      return calls <= 2 ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, { ok: 1 });
    });
    vi.stubGlobal('fetch', fake);

    const response = await postJson('https://x/y', {}, {}, fastOptions);

    expect(fake).toHaveBeenCalledTimes(3);
    expect(response.body).toEqual({ ok: 1 });
  });

  it('503 两次后成功', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls <= 2 ? jsonResponse(503, {}) : jsonResponse(200, { ok: 1 });
      }),
    );

    await expect(postJson('https://x/y', {}, {}, fastOptions)).resolves.toMatchObject({ status: 200 });
  });

  it('500 × 4 时抛 ServerError，共请求 4 次（1 + maxRetries）', async () => {
    const fake = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(ServerError);
    expect(fake).toHaveBeenCalledTimes(4);
  });

  it('maxRetries = 0 时 500 只请求 1 次', async () => {
    const fake = vi.fn(async () => jsonResponse(500, {}));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, { ...fastOptions, maxRetries: 0 })).rejects.toBeInstanceOf(ServerError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('fetch 自身 reject 归为 NetworkError，并按退避重试', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError('fetch failed');
        }
        return jsonResponse(200, { ok: 1 });
      }),
    );

    const response = await postJson('https://x/y', {}, {}, fastOptions);

    expect(response.body).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it('一直连不上时最终抛 NetworkError，共 4 次请求', async () => {
    const fake = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(NetworkError);
    expect(fake).toHaveBeenCalledTimes(4);
  });

  it('每次重试都重新 fetch，不复用上一次的 Response', async () => {
    // 复用同一个 Response 实例会在第二次 .text() 时抛 "body used already"。
    const shared = jsonResponse(500, { error: 'boom' });
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? shared : jsonResponse(200, { ok: 1 });
      }),
    );

    await expect(postJson('https://x/y', {}, {}, fastOptions)).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });
});

describe('postJson 不重试分支', () => {
  it('401 只请求 1 次并立刻抛 AuthError', async () => {
    const fake = vi.fn(async () => jsonResponse(401, { error: { message: 'bad key' } }));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(AuthError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('403 同样不重试', async () => {
    const fake = vi.fn(async () => jsonResponse(403, {}));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(AuthError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('400 只请求 1 次并抛 BadRequestError', async () => {
    const fake = vi.fn(async () => jsonResponse(400, { error: 'bad request' }));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(BadRequestError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('404 归为 BadRequestError 且不重试', async () => {
    const fake = vi.fn(async () => jsonResponse(404, {}));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(BadRequestError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('2xx 但不是 JSON → ResponseShapeError，且不重试', async () => {
    const fake = vi.fn(async () => textResponse(200, '<html>gateway</html>'));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(ResponseShapeError);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('用户 signal 已经 abort 时一次请求都不发', async () => {
    const fake = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fake);
    const ac = new AbortController();
    ac.abort();

    await expect(postJson('https://x/y', {}, {}, { ...fastOptions, signal: ac.signal })).rejects.toBeInstanceOf(
      UserAbortError,
    );
    expect(fake).not.toHaveBeenCalled();
  });
});

describe('postJson 错误信息', () => {
  it('包含状态码与响应体前 200 字符，且真的截断', async () => {
    const long = 'A'.repeat(500);
    vi.stubGlobal('fetch', vi.fn(async () => textResponse(400, long)));

    const error: unknown = await postJson('https://x/y', {}, {}, fastOptions).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BadRequestError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('400');
    expect(message).toContain('A'.repeat(200));
    expect(message).not.toContain('A'.repeat(201));
  });
});

describe('postJson 与 RateLimitError', () => {
  it('429 无 Retry-After 时回落退避，重试 3 次后抛 RateLimitError', async () => {
    const fake = vi.fn(async () => jsonResponse(429, { error: 'slow down' }));
    vi.stubGlobal('fetch', fake);

    await expect(postJson('https://x/y', {}, {}, fastOptions)).rejects.toBeInstanceOf(RateLimitError);
    expect(fake).toHaveBeenCalledTimes(4);
  });

  it('429 带 Retry-After 时按它等待，并按 maxRetryAfterMs 截断', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? jsonResponse(429, {}, { 'retry-after': '1' }) : jsonResponse(200, { ok: 1 });
      }),
    );
    const events: RetryLogEvent[] = [];

    const response = await postJson('https://x/y', {}, {}, {
      ...fastOptions,
      maxRetryAfterMs: 5,
      log: (event) => {
        events.push(event);
      },
    });

    expect(response.status).toBe(200);
    expect(events).toEqual([
      { attempt: 1, delayMs: 5, errorName: 'RateLimitError', status: 429, reason: 'retry-after' },
    ]);
  });
});

describe('postJson 重试日志', () => {
  it('每次决定重试都回调一次，字段足以还原终端日志', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls <= 2 ? jsonResponse(500, {}) : jsonResponse(200, { ok: 1 });
      }),
    );
    const events: RetryLogEvent[] = [];

    await postJson('https://x/y', {}, {}, {
      ...fastOptions,
      log: (event) => {
        events.push(event);
      },
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.attempt)).toEqual([1, 2]);
    expect(events.every((event) => event.errorName === 'ServerError')).toBe(true);
    expect(events.every((event) => event.status === 500)).toBe(true);
    expect(events.every((event) => event.reason === 'backoff')).toBe(true);
    expect(events.every((event) => event.delayMs >= 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L3：真实 socket —— 证明 abort 真的关掉了连接
// ---------------------------------------------------------------------------

describe('postJson 本地假服务器', () => {
  it('挂起不响应时按 timeoutMs 抛 TimeoutError，并真正中止请求', async () => {
    const server = await startFlakyServer([{ kind: 'hang', ms: 60_000 }]);
    try {
      const startedAt = Date.now();

      await expect(
        postJson(server.url, {}, {}, { ...fastOptions, timeoutMs: 150, maxRetries: 0 }),
      ).rejects.toBeInstanceOf(TimeoutError);

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(server.hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('用户 abort 优先于超时判定，且不重试', async () => {
    const server = await startFlakyServer([{ kind: 'hang', ms: 60_000 }]);
    try {
      const ac = new AbortController();
      setTimeout(() => {
        ac.abort();
      }, 50);

      await expect(
        postJson(server.url, {}, {}, { ...fastOptions, timeoutMs: 5_000, signal: ac.signal }),
      ).rejects.toBeInstanceOf(UserAbortError);

      // 只请求过 1 次：不存在「Ctrl-C 之后又默默重试 3 次」。
      expect(server.hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('重试等待期间 abort 立即退出，不再发第二次请求', async () => {
    const server = await startFlakyServer([{ kind: 'status', code: 500 }]);
    try {
      const ac = new AbortController();
      const startedAt = Date.now();
      setTimeout(() => {
        ac.abort();
      }, 100);

      await expect(
        postJson(server.url, {}, {}, { ...fastOptions, baseDelayMs: 5_000, maxDelayMs: 5_000, signal: ac.signal }),
      ).rejects.toBeInstanceOf(UserAbortError);

      // 退避是 5s，但取消必须在 ~100ms 内生效。
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(server.hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('连接被直接断掉 → NetworkError，并重试成功', async () => {
    const server = await startFlakyServer([{ kind: 'destroy' }, { kind: 'ok', body: { ok: 1 } }]);
    try {
      const response = await postJson(server.url, {}, {}, { ...fastOptions, baseDelayMs: 5 });

      expect(response.body).toEqual({ ok: 1 });
      expect(server.hits).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('真实 401 响应只产生 1 次请求', async () => {
    const server = await startFlakyServer([{ kind: 'status', code: 401 }]);
    try {
      await expect(postJson(server.url, {}, {}, fastOptions)).rejects.toBeInstanceOf(AuthError);

      expect(server.hits).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('真实 500 × 4 后抛 ServerError', async () => {
    const server = await startFlakyServer([{ kind: 'status', code: 500 }]);
    try {
      await expect(postJson(server.url, {}, {}, fastOptions)).rejects.toBeInstanceOf(ServerError);

      expect(server.hits).toBe(4);
    } finally {
      await server.close();
    }
  });
});
