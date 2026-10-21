import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/http/errors.js';
import {
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  isMutableConfigKey,
  loadConfig,
  patchConfig,
  type AppConfig,
} from '../src/config.js';

function makeConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ LLM_API_KEY: 'sk-test', ...env });
}

describe('isMutableConfigKey', () => {
  it.each(['model', 'systemPrompt', 'maxTokens', 'temperature'])('%s 是可改项', (key) => {
    expect(isMutableConfigKey(key)).toBe(true);
  });

  it.each(['apiKey', 'baseUrl', 'logLevel', 'timeoutMs', ''])('%s 不是可改项', (key) => {
    expect(isMutableConfigKey(key)).toBe(false);
  });
});

describe('patchConfig · model / systemPrompt', () => {
  it('改 model', () => {
    const next = patchConfig(makeConfig(), 'model', 'gpt-4.1');
    expect(next.model).toBe('gpt-4.1');
  });

  it('值两端空白被裁掉', () => {
    expect(patchConfig(makeConfig(), 'model', '  gpt-4.1  ').model).toBe('gpt-4.1');
  });

  it('输入 - 恢复默认 model', () => {
    const config = patchConfig(makeConfig(), 'model', 'gpt-4.1');
    expect(patchConfig(config, 'model', '-').model).toBe(DEFAULT_MODEL);
  });

  it('输入空串也恢复默认（菜单里直接回车是取消，走不到这里）', () => {
    const config = patchConfig(makeConfig(), 'model', 'gpt-4.1');
    expect(patchConfig(config, 'model', '   ').model).toBe(DEFAULT_MODEL);
  });

  it('systemPrompt 保留内部空格，不按空白切成两段', () => {
    const text = '你是一名译者，只输出译文';
    expect(patchConfig(makeConfig(), 'systemPrompt', text).systemPrompt).toBe(text);
  });

  it('systemPrompt 输入 - 恢复内置提示语', () => {
    const config = patchConfig(makeConfig(), 'systemPrompt', '自定义');
    expect(patchConfig(config, 'systemPrompt', '-').systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe('patchConfig · maxTokens / temperature', () => {
  it('设置 maxTokens', () => {
    expect(patchConfig(makeConfig(), 'maxTokens', '256').maxTokens).toBe(256);
  });

  it.each(['abc', '0', '-1', '1.5', '1e3'])('maxTokens 拒绝 %s', (raw) => {
    expect(() => patchConfig(makeConfig(), 'maxTokens', raw)).toThrow(ConfigError);
  });

  it('maxTokens 的 - 表示不发送该字段（不是 0）', () => {
    const next = patchConfig(makeConfig({ LLM_MAX_TOKENS: '256' }), 'maxTokens', '-');
    expect(next.maxTokens).toBeUndefined();
    expect('maxTokens' in next).toBe(false);
  });

  it('设置 temperature', () => {
    expect(patchConfig(makeConfig(), 'temperature', '0.7').temperature).toBe(0.7);
  });

  it.each(['0', '2'])('temperature 边界值 %s 合法', (raw) => {
    expect(patchConfig(makeConfig(), 'temperature', raw).temperature).toBe(Number(raw));
  });

  it.each(['2.1', '-0.1', 'abc', ''])('temperature 拒绝 %s', (raw) => {
    // 空串是「恢复默认」，不算非法：这里只验证越界与非法文本。
    if (raw === '') {
      expect(patchConfig(makeConfig(), 'temperature', raw).temperature).toBeUndefined();
      return;
    }
    expect(() => patchConfig(makeConfig(), 'temperature', raw)).toThrow(ConfigError);
  });

  it('改 maxTokens 不会丢掉已有的 temperature', () => {
    const config = makeConfig({ LLM_TEMPERATURE: '0.7' });
    const next = patchConfig(config, 'maxTokens', '128');
    expect(next.temperature).toBe(0.7);
  });

  it('改 temperature 不会丢掉已有的 maxTokens', () => {
    const config = makeConfig({ LLM_MAX_TOKENS: '128' });
    const next = patchConfig(config, 'temperature', '0.2');
    expect(next.maxTokens).toBe(128);
  });
});

describe('patchConfig · 不可变性与副作用', () => {
  it('返回新对象，原配置不动', () => {
    const config = makeConfig();
    const next = patchConfig(config, 'model', 'gpt-4.1');
    expect(next).not.toBe(config);
    expect(config.model).toBe(DEFAULT_MODEL);
  });

  it('返回值也是 frozen 的（避免下游偷偷改）', () => {
    const next = patchConfig(makeConfig(), 'model', 'gpt-4.1');
    expect(Object.isFrozen(next)).toBe(true);
  });

  it('只改一项，其它字段原样保留', () => {
    const config = makeConfig({ LLM_BASE_URL: 'https://example.com/v1', LLM_MAX_RETRIES: '5' });
    const next = patchConfig(config, 'model', 'gpt-4.1');
    expect(next.apiKey).toBe(config.apiKey);
    expect(next.baseUrl).toBe('https://example.com/v1');
    expect(next.timeoutMs).toBe(config.timeoutMs);
    expect(next.maxRetries).toBe(5);
    expect(next.maxHistoryMessages).toBe(config.maxHistoryMessages);
    expect(next.logLevel).toBe(config.logLevel);
  });

  it('非法值抛出的是 ConfigError，消息里带得上键名', () => {
    try {
      patchConfig(makeConfig(), 'maxTokens', 'abc');
      expect.unreachable('应当抛错');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConfigError);
      expect((cause as ConfigError).message).toContain('maxTokens');
    }
  });
});
