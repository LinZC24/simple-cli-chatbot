/**
 * 装配入口：config → transport → llmClient → session → repl。
 *
 * 这一层刻意只做**连接**，不写业务：
 * - `loadConfig` 是唯一的读环境变量处，配置错误在这里就被拦下（退出码 1）；
 * - `postJson` 是唯一碰 fetch 的函数，作为依赖注入给协议层；
 * - 退出码由 `runRepl` 返回，本文件只负责落实（0 走自然退出，不做 `process.exit`，
 *   这样任何残留句柄都会暴露成「进程不退出」而不是被强行掐掉）。
 */

import { runRepl, EXIT_FAILURE } from './cli/repl.js';
import { renderError } from './cli/render.js';
import { loadConfig, type AppConfig, type LogLevel } from './config.js';
import { postJson } from './http/transport.js';
import { createLlmClient } from './llm/llm-client.js';
import { createChatSession } from './session/chat-session.js';

/** `LOG_LEVEL` 的数值序：只有达到阈值才输出。 */
const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type Log = (level: LogLevel, message: string) => void;

/**
 * 极简日志器：日志一律走 stderr。
 *
 * stdout 留给 `bot>` 正文，这样 `pnpm dev > out.txt` 拿到的就是干净的对话记录。
 */
function createLog(threshold: LogLevel): Log {
  const limit = LOG_LEVEL_WEIGHT[threshold];
  return (level, message) => {
    if (LOG_LEVEL_WEIGHT[level] >= limit) {
      process.stderr.write(`${message}\n`);
    }
  };
}

async function main(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (cause) {
    // 配置错误是唯一「还没进 REPL 就该退出」的错误：退出码 1。
    process.stderr.write(`${renderError(cause).text}\n`);
    return EXIT_FAILURE;
  }

  const log = createLog(config.logLevel);

  const llm = createLlmClient({
    config,
    transport: postJson,
    // 重试日志属于 info：默认级别下就能在终端看到重试了几次。
    log: (message) => log('info', message),
  });

  const session = createChatSession({
    llm,
    systemPrompt: config.systemPrompt,
    maxHistoryMessages: config.maxHistoryMessages,
  });

  // `usage` 只在 debug 下打印，属于诊断信息。
  return runRepl({ session, config, log: (message) => log('debug', message) });
}

const exitCode = await main();
process.exitCode = exitCode;
