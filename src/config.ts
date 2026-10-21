/**
 * 配置加载。
 *
 * 设计要点（见 docs/03-interfaces.md §7）：
 * - `loadConfig` 是**纯函数**：env 由参数注入，不读 `process.env`，单测无需污染进程环境；
 * - 数字/枚举非法一律抛 `ConfigError`，消息里写清「哪个变量、期望什么、收到什么」；
 * - `baseUrl` 只做尾部斜杠归一化，**不**自动补 `/v1`（各家端点差异太大，宁可让用户写清楚）。
 */

import { ConfigError } from './http/errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';
export const DEFAULT_SYSTEM_PROMPT = '你是一个简洁、准确的助手。用中文回答，除非用户明确要求其他语言。';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_MAX_HISTORY_MESSAGES = 40;
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** 缺失即无法启动的变量。 */
export const REQUIRED_ENV_VARS = ['LLM_API_KEY'] as const;

/** 有默认值、可选填写的变量。 */
export const OPTIONAL_ENV_VARS = [
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_SYSTEM_PROMPT',
  'LLM_MAX_TOKENS',
  'LLM_TEMPERATURE',
  'LLM_TIMEOUT_MS',
  'LLM_MAX_RETRIES',
  'LOG_LEVEL',
] as const;

export interface AppConfig {
  readonly apiKey: string;
  /** 已去掉尾部 `/`，例如 `https://api.openai.com/v1`。 */
  readonly baseUrl: string;
  readonly model: string;
  readonly systemPrompt: string;
  /** 未配置时不发送该字段，交由服务端默认值决定。 */
  readonly maxTokens?: number;
  /** 未配置时不发送该字段。 */
  readonly temperature?: number;
  /** 单次尝试超时（毫秒）。 */
  readonly timeoutMs: number;
  /** 最多重试次数；总尝试次数 = 1 + maxRetries。 */
  readonly maxRetries: number;
  /** 送进请求的历史消息上限，防止无限增长。 */
  readonly maxHistoryMessages: number;
  readonly logLevel: LogLevel;
}

/**
 * 会话内**可以**改的配置项。
 *
 * 只放「改了立刻有意义」的生成参数：`apiKey`/`baseUrl` 属于连接身份，
 * `timeoutMs`/`maxRetries` 属于传输策略，都要求重启才生效更安全 —— 免得
 * 用户在一次卡顿里把超时调到 1ms 然后以为客户端坏了。
 */
export const MUTABLE_CONFIG_KEYS = ['model', 'systemPrompt', 'maxTokens', 'temperature'] as const;

export type MutableConfigKey = (typeof MUTABLE_CONFIG_KEYS)[number];

/** 可改项对应的环境变量名：`/config save` 只写这些，绝不写 `LLM_API_KEY`。 */
export const MUTABLE_CONFIG_ENV_VARS: Readonly<Record<MutableConfigKey, string>> = {
  model: 'LLM_MODEL',
  systemPrompt: 'LLM_SYSTEM_PROMPT',
  maxTokens: 'LLM_MAX_TOKENS',
  temperature: 'LLM_TEMPERATURE',
};

/** 运行时收窄 `string`：菜单编号与 `/config set` 的键名都从这里过一遍。 */
export function isMutableConfigKey(value: string): value is MutableConfigKey {
  switch (value) {
    case 'model':
    case 'systemPrompt':
    case 'maxTokens':
    case 'temperature':
      return true;
    default:
      return false;
  }
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const INTEGER_PATTERN = /^-?\d+$/;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/

/**
 * 读取原始值并归一化：未设置、空白、空字符串一律视为「未配置」。
 *
 * `--env-file` 对 `LLM_MAX_RETRIES=` 这种写法会产生空字符串，
 * 如果把它当 0 处理，就会出现「配置写错了反而悄悄变成 0 次重试」。
 */
function readRaw(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readString(env: Env, key: string, fallback: string): string {
  return readRaw(env, key) ?? fallback;
}

interface IntegerBounds {
  readonly min: number;
  readonly max?: number;
}

/**
 * 整数校验：`env` 与 `/config set` 共用一套规则与一套文案。
 *
 * `label` 是给用户看的名字（环境变量名或配置键名），`variable` 只用于错误元数据。
 */
function parseIntegerValue(raw: string, label: string, bounds: IntegerBounds, variable?: string): number {
  const options = variable === undefined ? {} : { variable };
  if (!INTEGER_PATTERN.test(raw)) {
    throw new ConfigError(`${label} 必须是整数，收到 "${raw}"`, options);
  }
  const value = Number(raw);
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < bounds.min || value > max) {
    throw new ConfigError(`${label} 必须在 ${bounds.min}~${max} 之间，收到 "${raw}"`, options);
  }
  return value;
}

function parseDecimalValue(raw: string, label: string, bounds: IntegerBounds, variable?: string): number {
  const options = variable === undefined ? {} : { variable };
  if (!DECIMAL_PATTERN.test(raw)) {
    throw new ConfigError(`${label} 必须是数字，收到 "${raw}"`, options);
  }
  const value = Number(raw);
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value) || value < bounds.min || value > max) {
    throw new ConfigError(`${label} 必须在 ${bounds.min}~${max} 之间，收到 "${raw}"`, options);
  }
  return value;
}

function readInteger(env: Env, key: string, fallback: number, bounds: IntegerBounds): number {
  const raw = readRaw(env, key);
  return raw === undefined ? fallback : parseIntegerValue(raw, key, bounds, key);
}

function readOptionalInteger(env: Env, key: string, bounds: IntegerBounds): number | undefined {
  const raw = readRaw(env, key);
  return raw === undefined ? undefined : parseIntegerValue(raw, key, bounds, key);
}

function readOptionalDecimal(env: Env, key: string, bounds: IntegerBounds): number | undefined {
  const raw = readRaw(env, key);
  return raw === undefined ? undefined : parseDecimalValue(raw, key, bounds, key);
}

function readBaseUrl(env: Env): string {
  const raw = readRaw(env, 'LLM_BASE_URL');
  const normalized = (raw ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (normalized === '') {
    throw new ConfigError('LLM_BASE_URL 归一化后为空，期望形如 https://api.openai.com/v1', {
      variable: 'LLM_BASE_URL',
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ConfigError(`LLM_BASE_URL 不是合法 URL，收到 "${normalized}"，期望形如 https://api.openai.com/v1`, {
      variable: 'LLM_BASE_URL',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`LLM_BASE_URL 只支持 http/https，收到 "${normalized}"`, { variable: 'LLM_BASE_URL' });
  }
  return normalized;
}

function readLogLevel(env: Env): LogLevel {
  const raw = readRaw(env, 'LOG_LEVEL');
  if (raw === undefined) {
    return DEFAULT_LOG_LEVEL;
  }
  const level = LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new ConfigError(`LOG_LEVEL 必须是 ${LOG_LEVELS.join(' | ')} 之一，收到 "${raw}"`, { variable: 'LOG_LEVEL' });
  }
  return level;
}

function readApiKey(env: Env): string {
  const apiKey = readRaw(env, 'LLM_API_KEY');
  if (apiKey === undefined) {
    throw new ConfigError(
      `LLM_API_KEY 未设置。必填环境变量：${REQUIRED_ENV_VARS.join(', ')}；` +
        '可选：' +
        OPTIONAL_ENV_VARS.join(', ') +
        '。可执行 cp .env.example .env 后填入 key',
      { variable: 'LLM_API_KEY' },
    );
  }
  return apiKey;
}

/**
 * 从环境变量构造配置。
 *
 * @param env 环境变量快照（生产用 `process.env`，测试直接传对象）
 * @throws {ConfigError} 缺少必填项，或任何一项非法
 */
export function loadConfig(env: Env): AppConfig {
  const maxTokens = readOptionalInteger(env, 'LLM_MAX_TOKENS', { min: 1 });
  const temperature = readOptionalDecimal(env, 'LLM_TEMPERATURE', { min: 0, max: 2 });

  return Object.freeze({
    apiKey: readApiKey(env),
    baseUrl: readBaseUrl(env),
    model: readString(env, 'LLM_MODEL', DEFAULT_MODEL),
    systemPrompt: readString(env, 'LLM_SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    timeoutMs: readInteger(env, 'LLM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, { min: 1 }),
    maxRetries: readInteger(env, 'LLM_MAX_RETRIES', DEFAULT_MAX_RETRIES, { min: 0, max: 10 }),
    maxHistoryMessages: DEFAULT_MAX_HISTORY_MESSAGES,
    logLevel: readLogLevel(env),
  });
}

/** `AppConfig` 去掉两个「可能不存在」的字段，方便重建对象时不丢值也不带 `undefined`。 */
type ConfigBase = Omit<AppConfig, 'maxTokens' | 'temperature'>;

function baseOf(config: AppConfig): ConfigBase {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    systemPrompt: config.systemPrompt,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxHistoryMessages: config.maxHistoryMessages,
    logLevel: config.logLevel,
  };
}

/**
 * 拼回不可变配置。
 *
 * 可选字段用条件展开而不是赋 `undefined`：`exactOptionalPropertyTypes` 下
 * 「字段不存在」和「字段是 undefined」是两回事，而请求体的口径是前者。
 */
function withOptionals(base: ConfigBase, optionals: { maxTokens?: number; temperature?: number }): AppConfig {
  return Object.freeze({
    ...base,
    ...(optionals.maxTokens === undefined ? {} : { maxTokens: optionals.maxTokens }),
    ...(optionals.temperature === undefined ? {} : { temperature: optionals.temperature }),
  });
}

/** 空串与 `-` 都是「清除/恢复默认」的记法，菜单里提示为 `- 恢复默认`。 */
function isClearToken(value: string): boolean {
  return value === '' || value === '-';
}

/**
 * 用一行文本改一项配置，返回**新的**不可变对象（原对象不动）。
 *
 * 纯函数：解析、校验、失败抛 `ConfigError` 全在这里，REPL 只管把文本喂进来。
 *
 * @param raw 用户输入；空串或 `-` 表示清除该字段 / 恢复默认值
 * @throws {ConfigError} 值非法（空 model、`maxTokens` 非正整数、`temperature` 越界等）
 */
export function patchConfig(config: AppConfig, key: MutableConfigKey, raw: string): AppConfig {
  const value = raw.trim();
  const cleared = isClearToken(value);
  const base = baseOf(config);

  switch (key) {
    case 'model':
      return withOptionals({ ...base, model: cleared ? DEFAULT_MODEL : value }, config);
    case 'systemPrompt':
      return withOptionals({ ...base, systemPrompt: cleared ? DEFAULT_SYSTEM_PROMPT : value }, config);
    case 'maxTokens':
      return withOptionals(base, {
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        ...(cleared ? {} : { maxTokens: parseIntegerValue(value, key, { min: 1 }) }),
      });
    case 'temperature':
      return withOptionals(base, {
        ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
        ...(cleared ? {} : { temperature: parseDecimalValue(value, key, { min: 0, max: 2 }) }),
      });
  }
}
