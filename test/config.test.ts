import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE_URL,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_HISTORY_MESSAGES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TIMEOUT_MS,
  loadConfig,
} from '../src/config.js';
import { AgentError, ConfigError, FatalError } from '../src/http/errors.js';

/** 最小可用的环境变量快照：只有必填的 API key。 */
const minimalEnv = { LLM_API_KEY: 'sk-test-key' } as const;

describe('loadConfig 默认值', () => {
  it('只填 API key 时，其余字段全部落到默认值', () => {
    const config = loadConfig({ ...minimalEnv });

    expect(config.apiKey).toBe('sk-test-key');
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(config.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(config.maxHistoryMessages).toBe(DEFAULT_MAX_HISTORY_MESSAGES);
    expect(config.logLevel).toBe(DEFAULT_LOG_LEVEL);
  });

  it('未配置生成参数时不产生该字段（而不是 undefined 字段）', () => {
    const config = loadConfig({ ...minimalEnv });

    expect('maxTokens' in config).toBe(false);
    expect('temperature' in config).toBe(false);
  });

  it('返回的对象被冻结，下游无法改写配置', () => {
    const config = loadConfig({ ...minimalEnv });

    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      // 故意写入，验证 readonly 在运行时也成立（strict mode 抛 TypeError）
      Object.assign(config, { model: 'gpt-4o' });
    }).toThrow(TypeError);
  });

  it('忽略未知的环境变量', () => {
    const config = loadConfig({ ...minimalEnv, UNRELATED_VAR: 'whatever', HOME: '/tmp' });

    expect(config.model).toBe(DEFAULT_MODEL);
  });
});

describe('loadConfig 必填项', () => {
  it('缺少 LLM_API_KEY 时抛 ConfigError，消息指明变量名', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/LLM_API_KEY/);
  });

  it('空白或空字符串的 key 视为未设置', () => {
    expect(() => loadConfig({ LLM_API_KEY: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ LLM_API_KEY: '   ' })).toThrow(ConfigError);
  });

  it('ConfigError 是可分流的 FatalError，且不可重试', () => {
    try {
      loadConfig({});
      expect.unreachable('loadConfig 应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toBeInstanceOf(FatalError);
      expect(error).toBeInstanceOf(AgentError);
      expect((error as ConfigError).retryable).toBe(false);
      expect((error as ConfigError).variable).toBe('LLM_API_KEY');
    }
  });

  it('apiKey 两侧空白被去掉', () => {
    expect(loadConfig({ LLM_API_KEY: '  sk-padded  ' }).apiKey).toBe('sk-padded');
  });
});

describe('loadConfig baseUrl 归一化', () => {
  it('去掉一个尾部斜杠', () => {
    expect(loadConfig({ ...minimalEnv, LLM_BASE_URL: 'https://example.com/v1/' }).baseUrl).toBe('https://example.com/v1');
  });

  it('去掉多个尾部斜杠', () => {
    expect(loadConfig({ ...minimalEnv, LLM_BASE_URL: 'https://example.com/v1///' }).baseUrl).toBe(
      'https://example.com/v1',
    );
  });

  it('不自动补 /v1（宁可让用户写清）', () => {
    expect(loadConfig({ ...minimalEnv, LLM_BASE_URL: 'https://example.com' }).baseUrl).toBe('https://example.com');
  });

  it('空字符串回落到默认端点', () => {
    expect(loadConfig({ ...minimalEnv, LLM_BASE_URL: '' }).baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('不是合法 URL 时抛 ConfigError', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_BASE_URL: 'api.openai.com/v1' })).toThrow(ConfigError);
  });

  it('非 http/https 协议抛 ConfigError', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_BASE_URL: 'ftp://example.com/v1' })).toThrow(/http\/https/);
  });
});

describe('loadConfig 数字型变量', () => {
  it('合法整数被解析为 number', () => {
    const config = loadConfig({
      ...minimalEnv,
      LLM_MAX_TOKENS: '512',
      LLM_TIMEOUT_MS: '1000',
      LLM_MAX_RETRIES: '5',
      LLM_TEMPERATURE: '1.25',
    });

    expect(config.maxTokens).toBe(512);
    expect(config.timeoutMs).toBe(1000);
    expect(config.maxRetries).toBe(5);
    expect(config.temperature).toBe(1.25);
  });

  it('非数字字符串抛 ConfigError，并写明变量名与收到的值', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_TIMEOUT_MS: 'abc' })).toThrow(/LLM_TIMEOUT_MS.*abc/);
  });

  it('小数被视为非法整数（不做静默取整）', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_TIMEOUT_MS: '30000.5' })).toThrow(ConfigError);
  });

  it('科学计数法与十六进制不被接受', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_TIMEOUT_MS: '1e3' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimalEnv, LLM_TIMEOUT_MS: '0x10' })).toThrow(ConfigError);
  });

  it('负数与零超时抛 ConfigError', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_TIMEOUT_MS: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimalEnv, LLM_TIMEOUT_MS: '0' })).toThrow(ConfigError);
  });

  it('maxRetries 允许 0（不重试是合法配置）', () => {
    expect(loadConfig({ ...minimalEnv, LLM_MAX_RETRIES: '0' }).maxRetries).toBe(0);
  });

  it('maxRetries 为负或过大时抛 ConfigError', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_MAX_RETRIES: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimalEnv, LLM_MAX_RETRIES: '11' })).toThrow(ConfigError);
  });

  it('maxTokens 必须为正整数', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_MAX_TOKENS: '0' })).toThrow(ConfigError);
  });

  it('temperature 允许 0 与 2 两个边界', () => {
    expect(loadConfig({ ...minimalEnv, LLM_TEMPERATURE: '0' }).temperature).toBe(0);
    expect(loadConfig({ ...minimalEnv, LLM_TEMPERATURE: '2' }).temperature).toBe(2);
  });

  it('temperature 超出 0~2 或非数字时抛 ConfigError', () => {
    expect(() => loadConfig({ ...minimalEnv, LLM_TEMPERATURE: '2.1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimalEnv, LLM_TEMPERATURE: '-0.1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimalEnv, LLM_TEMPERATURE: 'warm' })).toThrow(ConfigError);
  });

  it('空字符串按「未配置」处理，不静默变成 0', () => {
    const config = loadConfig({ ...minimalEnv, LLM_MAX_RETRIES: '', LLM_MAX_TOKENS: '  ' });

    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect('maxTokens' in config).toBe(false);
  });
});

describe('loadConfig LOG_LEVEL', () => {
  it('四个合法级别原样透传', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(loadConfig({ ...minimalEnv, LOG_LEVEL: level }).logLevel).toBe(level);
    }
  });

  it('非法级别抛 ConfigError 并列出可选值', () => {
    expect(() => loadConfig({ ...minimalEnv, LOG_LEVEL: 'verbose' })).toThrow(/debug \| info \| warn \| error/);
  });

  it('大小写敏感（不猜测用户意图）', () => {
    expect(() => loadConfig({ ...minimalEnv, LOG_LEVEL: 'INFO' })).toThrow(ConfigError);
  });
});

describe('loadConfig 纯函数性质', () => {
  it('不读取 process.env，只认传入的 env', () => {
    const previous = process.env.LLM_MODEL;
    process.env.LLM_MODEL = 'from-process-env';
    try {
      expect(loadConfig({ ...minimalEnv }).model).toBe(DEFAULT_MODEL);
      expect(loadConfig({ ...minimalEnv, LLM_MODEL: 'from-argument' }).model).toBe('from-argument');
    } finally {
      if (previous === undefined) {
        delete process.env.LLM_MODEL;
      } else {
        process.env.LLM_MODEL = previous;
      }
    }
  });

  it('不修改传入的 env 对象', () => {
    const env = Object.freeze({ ...minimalEnv, LLM_BASE_URL: 'https://example.com/v1/' });

    expect(() => loadConfig(env)).not.toThrow();
    expect(env.LLM_BASE_URL).toBe('https://example.com/v1/');
  });

  it('同一份 env 两次调用结果一致', () => {
    const env = { ...minimalEnv, LOG_LEVEL: 'debug' as const, LLM_MAX_TOKENS: '256' };

    expect(loadConfig(env)).toEqual(loadConfig(env));
  });
});
