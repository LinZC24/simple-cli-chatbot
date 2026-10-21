import { describe, expect, it } from 'vitest';

import {
  AgentError,
  AuthError,
  BODY_SNIPPET_MAX,
  BadRequestError,
  ConfigError,
  FatalError,
  NetworkError,
  RateLimitError,
  ResponseShapeError,
  RetryableError,
  ServerError,
  TimeoutError,
  UserAbortError,
  describeCause,
  isAgentError,
  toBodySnippet,
} from '../src/http/errors.js';

const httpOptions = {
  status: 401,
  statusText: 'Unauthorized',
  body: '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}',
  host: 'api.openai.com',
} as const;

describe('instanceof 分流', () => {
  it('AuthError 落在 FatalError 分支', () => {
    const error = new AuthError(httpOptions);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toBeInstanceOf(FatalError);
    expect(error).toBeInstanceOf(AgentError);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RetryableError);
  });

  it('ServerError 落在 RetryableError 分支', () => {
    const error = new ServerError({ status: 503, statusText: 'Service Unavailable', host: 'api.openai.com' });

    expect(error).toBeInstanceOf(RetryableError);
    expect(error).toBeInstanceOf(AgentError);
    expect(error).not.toBeInstanceOf(FatalError);
  });

  it('UserAbortError 既不是 FatalError 也不是 RetryableError', () => {
    const error = new UserAbortError();

    expect(error).toBeInstanceOf(AgentError);
    expect(error).not.toBeInstanceOf(FatalError);
    expect(error).not.toBeInstanceOf(RetryableError);
  });

  it('name 等于具体类名，便于日志直接读', () => {
    expect(new AuthError(httpOptions).name).toBe('AuthError');
    expect(new BadRequestError({ status: 400 }).name).toBe('BadRequestError');
    expect(new ConfigError('bad').name).toBe('ConfigError');
    expect(new TimeoutError({ timeoutMs: 1000 }).name).toBe('TimeoutError');
  });
});

describe('retryable 标志', () => {
  it('不可重试：配置 / 鉴权 / 请求 / 响应格式 / 用户取消', () => {
    expect(new ConfigError('bad').retryable).toBe(false);
    expect(new AuthError(httpOptions).retryable).toBe(false);
    expect(new BadRequestError({ status: 422 }).retryable).toBe(false);
    expect(new ResponseShapeError('missing choices').retryable).toBe(false);
    expect(new UserAbortError().retryable).toBe(false);
  });

  it('可重试：限流 / 服务端 / 网络 / 超时', () => {
    expect(new RateLimitError({ status: 429 }).retryable).toBe(true);
    expect(new ServerError({ status: 500 }).retryable).toBe(true);
    expect(new NetworkError().retryable).toBe(true);
    expect(new TimeoutError({ timeoutMs: 30_000 }).retryable).toBe(true);
  });
});

describe('HTTP 错误信息格式', () => {
  it('包含状态码、状态文案、host 与响应体片段', () => {
    const message = new AuthError(httpOptions).message;

    expect(message).toContain('401 Unauthorized');
    expect(message).toContain('api.openai.com');
    expect(message).toContain('Incorrect API key provided');
    expect(message).toContain('invalid api key');
  });

  it('403 提示的是「没权限」而不是「key 拼错了」', () => {
    const message = new AuthError({ status: 403, statusText: 'Forbidden', host: 'api.openai.com' }).message;

    expect(message).toContain('403 Forbidden');
    expect(message).toContain('no permission');
    expect(message).not.toContain('invalid api key');
  });

  it('响应体截断到前 200 字符（不把整页 HTML 喷到终端）', () => {
    const longBody = 'a'.repeat(BODY_SNIPPET_MAX + 100);
    const error = new AuthError({ status: 401, statusText: 'Unauthorized', body: longBody, host: 'api.openai.com' });

    expect(error.http.bodySnippet).toHaveLength(BODY_SNIPPET_MAX);
    expect(error.message).toContain('a'.repeat(BODY_SNIPPET_MAX));
    expect(error.message).not.toContain('a'.repeat(BODY_SNIPPET_MAX + 1));
  });

  it('没有响应体时不留多余的冒号尾巴', () => {
    const error = new ServerError({ status: 500, statusText: 'Internal Server Error', host: 'api.openai.com' });

    expect(error.message).toBe('500 Internal Server Error — server error. api.openai.com:');
    expect(error.http.bodySnippet).toBe('');
  });

  it('HTTP/2 没有 reason phrase 时只用状态码', () => {
    const error = new BadRequestError({ status: 400, body: '{"error":"bad"}' });

    expect(error.message.startsWith('400 — request rejected by server.')).toBe(true);
    expect(error.http.statusText).toBe('');
  });

  it('暴露可断言的 http 字段', () => {
    const error = new RateLimitError({ status: 429, statusText: 'Too Many Requests', body: 'slow down', host: 'api.deepseek.com' });

    expect(error.http).toEqual({
      status: 429,
      statusText: 'Too Many Requests',
      bodySnippet: 'slow down',
      host: 'api.deepseek.com',
    });
  });
});

describe('各类特有字段', () => {
  it('RateLimitError 透传 retryAfterMs（未提供时为 undefined）', () => {
    expect(new RateLimitError({ status: 429, retryAfterMs: 2500 }).retryAfterMs).toBe(2500);
    expect(new RateLimitError({ status: 429 }).retryAfterMs).toBeUndefined();
  });

  it('TimeoutError 记录 timeoutMs 并写进消息', () => {
    const error = new TimeoutError({ timeoutMs: 30_000, host: 'api.openai.com' });

    expect(error.timeoutMs).toBe(30_000);
    expect(error.message).toContain('30000ms');
    expect(error.message).toContain('api.openai.com');
  });

  it('ResponseShapeError 记录 bodySnippet 并写进消息', () => {
    const error = new ResponseShapeError('choices is not an array', { body: '{"choices":null}' });

    expect(error.bodySnippet).toBe('{"choices":null}');
    expect(error.message).toContain('choices is not an array');
    expect(error.message).toContain('{"choices":null}');
  });

  it('ConfigError 记录出问题的变量名', () => {
    expect(new ConfigError('bad number', { variable: 'LLM_TIMEOUT_MS' }).variable).toBe('LLM_TIMEOUT_MS');
  });
});

describe('cause 链', () => {
  it('原始错误可通过 cause 取回（供日志展开）', () => {
    const original = new TypeError('fetch failed');
    const error = new NetworkError({ cause: original, host: 'api.openai.com' });

    expect(error.cause).toBe(original);
    expect(error.message).toContain('TypeError: fetch failed');
    expect(error.message).toContain('api.openai.com');
  });

  it('不传 cause 时 cause 属性不存在（而不是 undefined）', () => {
    const error = new ServerError({ status: 500 });

    expect('cause' in error).toBe(false);
  });

  it('describeCause 兼容 Error / 字符串 / 其它值', () => {
    expect(describeCause(new RangeError('boom'))).toBe('RangeError: boom');
    expect(describeCause('plain text')).toBe('plain text');
    expect(describeCause(42)).toBe('42');
    expect(describeCause(new Error(''))).toBe('Error');
  });
});

describe('meta 诊断信息', () => {
  it('透传并冻结', () => {
    const error = new ServerError({ status: 502, meta: { attempt: 2, url: 'https://api.openai.com/v1/chat/completions' } });

    expect(error.meta.attempt).toBe(2);
    expect(Object.isFrozen(error.meta)).toBe(true);
  });

  it('未提供时为空对象', () => {
    expect(new UserAbortError().meta).toEqual({});
  });
});

describe('isAgentError 守卫', () => {
  it('所有自定义错误都返回 true', () => {
    const errors = [
      new ConfigError('bad'),
      new AuthError(httpOptions),
      new BadRequestError({ status: 400 }),
      new ResponseShapeError('bad shape'),
      new RateLimitError({ status: 429 }),
      new ServerError({ status: 500 }),
      new NetworkError(),
      new TimeoutError({ timeoutMs: 1000 }),
      new UserAbortError(),
    ];

    for (const error of errors) {
      expect(isAgentError(error)).toBe(true);
    }
  });

  it('原生错误与非错误值返回 false', () => {
    expect(isAgentError(new Error('native'))).toBe(false);
    expect(isAgentError('AuthError')).toBe(false);
    expect(isAgentError(null)).toBe(false);
    expect(isAgentError(undefined)).toBe(false);
    expect(isAgentError({ retryable: false })).toBe(false);
  });

  it('catch 到的 unknown 能在收窄后直接读 retryable', () => {
    const caught: unknown = new ServerError({ status: 500 });
    if (!isAgentError(caught)) {
      expect.unreachable('应当识别为 AgentError');
    }
    expect(caught.retryable).toBe(true);
  });
});

describe('toBodySnippet', () => {
  it('去掉首尾空白并截断到 200 字符', () => {
    expect(toBodySnippet('  {"a":1}  ')).toBe('{"a":1}');
    expect(toBodySnippet('b'.repeat(500))).toHaveLength(BODY_SNIPPET_MAX);
  });

  it('短响应体原样返回', () => {
    expect(toBodySnippet('ok')).toBe('ok');
    expect(toBodySnippet('')).toBe('');
  });
});
