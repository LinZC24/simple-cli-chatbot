/**
 * CLI 渲染层：只负责「怎么显示」，不含任何业务判断。
 *
 * 两条硬约束（docs/01-architecture.md §1.1、§6.2）：
 * - 这里**不判断 retryable**、不决定要不要重试、不碰历史 —— 只把已经发生的事渲染成文本；
 * - 所有错误输出走 **stderr**、以 `!` 开头，正文与错误可以分别重定向。
 *
 * 错误文案按 docs/03-interfaces.md §8 的映射表：
 * `! <中文前缀>: <error.message>`，第二行给一条可操作的提示。
 * `error.message` 自带状态码与响应体前 200 字符（见 `src/http/errors.ts`），
 * 所以 docs/01-architecture.md §6.3 要求的「必须含状态码、必须含响应体前 200 字符」
 * 由消息本身保证，渲染层不再重复拼接。
 */

import type { AppConfig, MutableConfigKey } from '../config.js';
import { DEFAULT_MODEL, MUTABLE_CONFIG_KEYS } from '../config.js';
import {
  AgentError,
  AuthError,
  BadRequestError,
  ConfigError,
  NetworkError,
  RateLimitError,
  ResponseShapeError,
  ServerError,
  TimeoutError,
  UserAbortError,
} from '../http/errors.js';
import type { ChatMessage, Usage } from '../llm/types.js';
import type { TurnResult } from '../session/chat-session.js';

/** 用户输入提示符（带一个空格）。 */
export const PROMPT = 'you> ';
/** 助手输出前缀（带一个空格）。 */
export const ASSISTANT_PREFIX = 'bot> ';
/** 错误行前缀。 */
export const ERROR_PREFIX = '! ';
/** 提示行前缀（比错误行缩进两级，避免和错误正文混在一起）。 */
export const HINT_PREFIX = '  → ';
/** Ctrl-C 取消回合时唯一的一行输出。 */
export const ABORT_NOTICE = '^C 已取消本次回合';
/** `/history` 里每条消息预览的字符数。 */
export const HISTORY_PREVIEW_LIMIT = 60;
/** 命中 `max_tokens` 时的提示。 */
export const TRUNCATED_HINT =
  '  (回答被截断：已达到 max_tokens 上限，可调大 LLM_MAX_TOKENS，或直接说「继续」)';

/** 渲染错误时可以补充的上下文（拿不到就省略，绝不猜测）。 */
export interface RenderErrorContext {
  /** 传输层实际重试过的轮数。 */
  readonly retries?: number;
  /** 单次尝试的超时上限，用于 `TimeoutError` 的提示。 */
  readonly timeoutMs?: number;
}

/** 渲染结果：文本 + 该走哪个流。 */
export interface RenderedError {
  readonly stream: 'stderr';
  readonly text: string;
}

/** `bot> ...` 一行（必要时追加截断提示）。 */
export function renderReply(result: TurnResult): string {
  const { assistant } = result;
  const body = assistant.content === '' ? '(模型返回了空内容)' : assistant.content;
  const lines = [`${ASSISTANT_PREFIX}${body}`];

  // `finish_reason === 'length'` 不是错误，只提示「话说完了但被截断」。
  if (assistant.finishReason === 'length') {
    lines.push(TRUNCATED_HINT);
  }

  return lines.join('\n');
}

/** 把任意异常渲染成一行（最多两行）stderr 文本。 */
export function renderError(error: unknown, context: RenderErrorContext = {}): RenderedError {
  // 取消不是错误：只留一行提示，不打印堆栈式噪音。
  if (error instanceof UserAbortError) {
    return { stream: 'stderr', text: ABORT_NOTICE };
  }

  if (!(error instanceof AgentError)) {
    const message = error instanceof Error ? error.message : String(error);
    return { stream: 'stderr', text: `${ERROR_PREFIX}未知错误: ${message}` };
  }

  const text = `${ERROR_PREFIX}${describePrefix(error)}: ${error.message}`;
  const hint = describeHint(error, context);
  return { stream: 'stderr', text: hint === undefined ? text : `${text}\n${HINT_PREFIX}${hint}` };
}

/** 中文前缀（03-interfaces.md §8 的映射表）。 */
function describePrefix(error: AgentError): string {
  if (error instanceof ConfigError) return '配置错误';
  if (error instanceof AuthError) return '鉴权失败';
  if (error instanceof BadRequestError) return '请求被拒绝';
  if (error instanceof RateLimitError) return '触发限流';
  if (error instanceof ServerError) return '服务端错误';
  if (error instanceof NetworkError) return '网络不可达';
  if (error instanceof TimeoutError) return '请求超时';
  if (error instanceof ResponseShapeError) return '响应格式异常';
  return '未知错误';
}

/** 第二行的可操作提示；没有明确建议时宁可不写。 */
function describeHint(error: AgentError, context: RenderErrorContext): string | undefined {
  const retries = context.retries ?? 0;

  if (error instanceof ConfigError) {
    return '检查 .env：LLM_API_KEY 必填，其余变量可留空用默认值（见 .env.example）';
  }
  if (error instanceof AuthError) {
    return '检查 LLM_API_KEY 是否有效，以及它是否与 LLM_BASE_URL 指向的供应商匹配';
  }
  if (error instanceof BadRequestError) {
    return '检查 LLM_MODEL 是否存在，以及 LLM_MAX_TOKENS / LLM_TEMPERATURE 是否超范围';
  }
  if (error instanceof RateLimitError) {
    return `已按 Retry-After 等待并重试 ${retries} 次仍失败，稍后再试或降低请求频率`;
  }
  if (error instanceof ServerError) {
    return `已重试 ${retries} 次，服务端仍然失败，稍后再试`;
  }
  if (error instanceof NetworkError) {
    return '检查网络 / 代理 / LLM_BASE_URL 是否可达';
  }
  if (error instanceof TimeoutError) {
    const timeout = context.timeoutMs === undefined ? '' : ` ${context.timeoutMs} ms`;
    return `单次尝试超过${timeout}，已重试 ${retries} 次`;
  }
  if (error instanceof ResponseShapeError) {
    return '上游返回的 JSON 不符合 OpenAI 兼容协议，先确认 LLM_BASE_URL 与 LLM_MODEL 是否配套';
  }
  return undefined;
}

/** 启动横幅：一眼看到「在跟谁说话」。 */
export function renderBanner(config: AppConfig): string {
  return [
    `cli-chatbot · model=${config.model} · base=${config.baseUrl}`,
    `历史上限 ${config.maxHistoryMessages} 条 · 超时 ${config.timeoutMs} ms · 最大重试 ${config.maxRetries} 次`,
    '输入 /help 查看命令，Ctrl-D 或 /exit 退出。',
  ].join('\n');
}

/** `/help` 的命令列表。 */
export function renderHelp(): string {
  return [
    '命令：',
    '  /exit, /quit     退出',
    '  /reset           清空历史（保留 system prompt）',
    '  /system <文本>   替换 system prompt（下一轮生效，历史不动）',
    '  /history         查看当前历史（条数 + 角色 + 前 60 字符）',
    '  /config          查看并修改 model / systemPrompt / maxTokens / temperature',
    '  /config set <键> <值>  直接改一项（值写 - 则恢复默认）',
    '  /config reset    恢复启动时的配置（本次会话内）',
    '  /config save     把改动写回 .env（自动备份 .env.bak）',
    '  /help            显示这份帮助',
    '其他输入都当作对话内容；空行忽略；Ctrl-C 取消当前回合。',
  ].join('\n');
}

/** `/history`：条数 + 每条的角色与前 60 字符。 */
export function renderHistory(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) {
    return '历史为空（0 条，不含 system）。';
  }

  const lines = [`历史 ${messages.length} 条（不含 system）：`];
  for (const [index, message] of messages.entries()) {
    lines.push(`  ${index + 1}. ${message.role}: ${preview(message.content)}`);
  }
  return lines.join('\n');
}

/** `/reset` 的回执。 */
export function renderResetDone(): string {
  return '历史已清空，system prompt 保留。';
}

/** `/system` 的回执：确认改成了什么，并提醒生效时机。 */
export function renderSystemUpdated(prompt: string): string {
  return `system prompt 已更新（下一轮请求生效，历史未改动）：${preview(prompt, 80)}`;
}

/** `/system` 之后什么都不给时的用法提示。 */
export function renderSystemUsage(): string {
  return `用法：/system <文本>。当前 system prompt：${preview('（用 /history 看历史，system 不在其中）', 80)}`;
}

/** 未知斜杠命令的提示。 */
export function renderUnknownCommand(name: string): string {
  return `未知命令：${name}。输入 /help 查看可用命令。`;
}

/** debug 级别的 usage 行。 */
export function renderUsage(usage: Usage): string {
  return `[usage] prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens}`;
}

/** config 表格里值的截断宽度：比 `/history` 宽一点，够看清 model 与 prompt 开头。 */
export const CONFIG_VALUE_LIMIT = 40;
/** `/config` 菜单的等待输入提示（不带换行，紧跟用户输入）。 */
export const CONFIG_MENU_PROMPT = '输入编号修改，回车取消：';

/** 密钥只回答「有没有」，不露任何片段 —— 终端回滚与录像都不该记住它。 */
export function describeApiKey(apiKey: string): string {
  return apiKey === '' ? '未设置' : '已设置';
}

/** 把一个可改项当前的值渲染成一行文本；未设置的可选字段显式写出来。 */
export function describeConfigValue(config: AppConfig, key: MutableConfigKey): string {
  switch (key) {
    case 'model':
      return config.model;
    case 'systemPrompt':
      return preview(config.systemPrompt, CONFIG_VALUE_LIMIT);
    case 'maxTokens':
      return config.maxTokens === undefined ? '(未设置)' : String(config.maxTokens);
    case 'temperature':
      return config.temperature === undefined ? '(未设置)' : String(config.temperature);
  }
}

/** 一行「是否默认值」的提示，用在取值提示里。 */
function describeDefaultHint(key: MutableConfigKey): string {
  switch (key) {
    case 'model':
      return `默认 ${DEFAULT_MODEL}`;
    case 'systemPrompt':
      return '默认内置提示语';
    case 'maxTokens':
      return '未设置则不发送';
    case 'temperature':
      return '未设置则不发送';
  }
}

/**
 * `/config` 的主表格：只把四项可改项编号，其余集中成一行只读说明。
 *
 * 只读项不编号是有意的：菜单里每一项都能按下去，就不该出现「这个改了没用」。
 */
export function renderConfigTable(config: AppConfig, modified: readonly MutableConfigKey[]): string {
  const rows = MUTABLE_CONFIG_KEYS.map((key, index) => {
    const mark = modified.includes(key) ? '*' : ' ';
    return `${mark} ${String(index + 1)}) ${key.padEnd(13)} ${describeConfigValue(config, key)}`;
  });

  const readonlyParts = [
    `apiKey=${describeApiKey(config.apiKey)}`,
    `baseUrl=${config.baseUrl}`,
    `timeoutMs=${config.timeoutMs}`,
    `maxRetries=${config.maxRetries}`,
    `maxHistoryMessages=${config.maxHistoryMessages}`,
    `logLevel=${config.logLevel}`,
  ];

  return [
    '当前配置（* = 本次会话内已修改）：',
    ...rows,
    `  只读（改 .env 后重启）：${readonlyParts.join('  ')}`,
  ].join('\n');
}

/** 选完编号后提示输入新值。 */
export function renderConfigValuePrompt(key: MutableConfigKey, config: AppConfig): string {
  return `${key}（当前 ${describeConfigValue(config, key)}；${describeDefaultHint(key)}；输入 - 恢复默认）：`;
}

/** 改动成功的回执，带上新值，方便立刻确认自己改对了。 */
export function renderConfigUpdated(key: MutableConfigKey, config: AppConfig): string {
  return `✓ ${key} → ${describeConfigValue(config, key)}（下一回合生效）`;
}

/** 编号不在范围内。 */
export function renderConfigUnknownChoice(raw: string): string {
  return `无效编号：${raw}。输入 1~${MUTABLE_CONFIG_KEYS.length}，或直接回车取消。`;
}

/** 菜单里直接回车。 */
export function renderConfigCancelled(): string {
  return '已取消修改。';
}

/** `/config set` 的键名不认识。 */
export function renderConfigUnknownKey(name: string): string {
  return `未知配置项：${name}。可改：${MUTABLE_CONFIG_KEYS.join(' / ')}；其余项请改 .env 后重启。`;
}

/** `/config set` 少参数。 */
export function renderConfigSetUsage(): string {
  return `用法：/config set <${MUTABLE_CONFIG_KEYS.join(' | ')}> <值>（值写 - 恢复默认）`;
}

/** `/config reset` 的回执。 */
export function renderConfigResetDone(): string {
  return '已恢复启动时的配置。';
}

/** `/config save` 成功：列出写了哪几个变量。 */
export function renderConfigSaved(changed: readonly string[]): string {
  if (changed.length === 0) {
    return '✓ .env 已是目标值，无需改动。';
  }
  return `✓ 已写入 .env：${changed.join('、')}（原文件备份为 .env.bak）`;
}

/** `/config save` 失败：只给原因与下一步，不抛异常。 */
export function renderConfigSaveFailed(message: string): string {
  return `${ERROR_PREFIX}保存失败: ${message}`;
}

/** 单行预览：压掉换行，超长截断。 */
export function preview(text: string, limit = HISTORY_PREVIEW_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) {
    return flat;
  }
  return `${flat.slice(0, limit)}…`;
}
