/**
 * 配置持有者：把「启动时的配置」和「会话内改过的配置」分开保存。
 *
 * 为什么需要它：`AppConfig` 是 `Object.freeze` 的，协议层、会话层都在创建时就把
 * 配置捕获掉了。如果 `/config` 直接改对象，改的只是自己手里那一份；要让它生效，
 * 只能是「换一个新对象，并让用的人每次现取」。这个 store 就是那个「现取」的入口：
 *
 * - `get()` 永远返回当前有效配置，协议层每次请求前调一次，于是改 `model` 下一回合就生效；
 * - `set()` 复用 `patchConfig` 的校验，非法输入直接抛 `ConfigError`，不会留下半更新的状态；
 * - `initial` 保留启动时的快照，`reset()` 回到它，`modifiedKeys()` 用来在界面上标 `*`。
 *
 * 注意这里**不做持久化**：写回 `.env` 是 CLI 层显式 `/config save` 的事（见 `src/env-file.ts`）。
 */

import { MUTABLE_CONFIG_KEYS, patchConfig, type AppConfig, type MutableConfigKey } from './config.js';

export interface ConfigStore {
  /** 当前生效的配置（不可变对象，每次改动都会换成新的）。 */
  get(): AppConfig;
  /** 启动时的配置，`reset()` 的目标。 */
  readonly initial: AppConfig;
  /**
   * 用一行文本改一项，返回改动后的配置。
   *
   * @throws {ConfigError} 值非法；抛出时 store 保持原样（不会出现「改了一半」）
   */
  set(key: MutableConfigKey, raw: string): AppConfig;
  /** 恢复到启动时的配置。 */
  reset(): AppConfig;
  /** 与启动时不同的项，按 `MUTABLE_CONFIG_KEYS` 的顺序。 */
  modifiedKeys(): readonly MutableConfigKey[];
}

function valueOf(config: AppConfig, key: MutableConfigKey): string | number | undefined {
  switch (key) {
    case 'model':
      return config.model;
    case 'systemPrompt':
      return config.systemPrompt;
    case 'maxTokens':
      return config.maxTokens;
    case 'temperature':
      return config.temperature;
  }
}

export function createConfigStore(initial: AppConfig): ConfigStore {
  let current = initial;

  return {
    get: () => current,
    initial,
    set(key, raw) {
      // 先算完再赋值：`patchConfig` 抛错时 `current` 不会被改到。
      current = patchConfig(current, key, raw);
      return current;
    },
    reset() {
      current = initial;
      return current;
    },
    modifiedKeys() {
      return MUTABLE_CONFIG_KEYS.filter((key) => valueOf(initial, key) !== valueOf(current, key));
    },
  };
}
