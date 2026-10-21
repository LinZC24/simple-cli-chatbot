import { describe, expect, it } from 'vitest';
import { createConfigStore } from '../src/config-store.js';
import { DEFAULT_MODEL, loadConfig, type AppConfig } from '../src/config.js';
import { ConfigError } from '../src/http/errors.js';

function makeConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ LLM_API_KEY: 'sk-test', ...env });
}

describe('createConfigStore', () => {
  it('get() 初始就是启动配置', () => {
    const config = makeConfig();
    expect(createConfigStore(config).get()).toBe(config);
  });

  it('initial 保留启动快照', () => {
    const config = makeConfig();
    const store = createConfigStore(config);
    store.set('model', 'gpt-4.1');
    expect(store.initial).toBe(config);
    expect(store.initial.model).toBe(DEFAULT_MODEL);
  });

  it('set() 返回新配置，且 get() 立刻是新值', () => {
    const store = createConfigStore(makeConfig());
    const next = store.set('model', 'gpt-4.1');
    expect(next.model).toBe('gpt-4.1');
    expect(store.get()).toBe(next);
  });

  it('set() 非法值抛 ConfigError，且状态保持原样', () => {
    const store = createConfigStore(makeConfig());
    const before = store.get();
    expect(() => store.set('maxTokens', 'abc')).toThrow(ConfigError);
    expect(store.get()).toBe(before);
    expect(store.modifiedKeys()).toEqual([]);
  });

  it('modifiedKeys() 按可改项顺序返回改动过的键', () => {
    const store = createConfigStore(makeConfig());
    store.set('temperature', '0.2');
    store.set('model', 'gpt-4.1');
    expect(store.modifiedKeys()).toEqual(['model', 'temperature']);
  });

  it('设成与启动时相同的值不算改动', () => {
    const store = createConfigStore(makeConfig());
    store.set('model', DEFAULT_MODEL);
    expect(store.modifiedKeys()).toEqual([]);
  });

  it('清掉可选字段算改动', () => {
    const store = createConfigStore(makeConfig({ LLM_MAX_TOKENS: '256' }));
    store.set('maxTokens', '-');
    expect(store.modifiedKeys()).toEqual(['maxTokens']);
    expect(store.get().maxTokens).toBeUndefined();
  });

  it('reset() 回到启动配置，改动清空', () => {
    const config = makeConfig();
    const store = createConfigStore(config);
    store.set('model', 'gpt-4.1');
    const back = store.reset();
    expect(back).toBe(config);
    expect(store.get()).toBe(config);
    expect(store.modifiedKeys()).toEqual([]);
  });

  it('多次 set 是增量累积的，不会互相覆盖', () => {
    const store = createConfigStore(makeConfig());
    store.set('model', 'gpt-4.1');
    store.set('maxTokens', '64');
    expect(store.get().model).toBe('gpt-4.1');
    expect(store.get().maxTokens).toBe(64);
  });
});
