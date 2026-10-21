/**
 * CLI 层：读 stdin、解释斜杠命令、驱动一个回合、处理 Ctrl-C / Ctrl-D。
 *
 * 职责边界（docs/01-architecture.md §1.1）：
 * - **不拼 HTTP、不改历史**：一个回合就是 `session.turn(text)`；
 * - **不判断错误类型**：交给 `render.ts` 的映射表，这里只在 `UserAbortError` 上提前收尾；
 * - 全项目**唯一**的 `catch` 就在这一层（§6.2），其余层让异常裸奔。
 *
 * 退出路径（§5 优雅退出）只有三条，都必须把 readline 关掉：
 * | 触发 | 行为 |
 * | --- | --- |
 * | `/exit`、`/quit`、Ctrl-D | 退出码 0 |
 * | Ctrl-C 第 1 次 | abort 在飞回合 → `rl.close()` → 等回合 settle（上限 1s）→ 130 |
 * | settle 期间再按 Ctrl-C | 立即 130 |
 * | SIGTERM | 同 Ctrl-C，退出码 143 |
 *
 * 用 `terminal: false` 的接口是有意的：读行交给 TTY 自己的行规程，Ctrl-C 于是变成
 * 真正的 `SIGINT` 信号（而不是 readline 的按键事件），进程信号处理只需要写一份。
 */

import { createInterface } from 'node:readline/promises';
import type { AppConfig } from '../config.js';
import { UserAbortError } from '../http/errors.js';
import type { ChatSession } from '../session/chat-session.js';
import {
  PROMPT,
  renderBanner,
  renderError,
  renderHistory,
  renderHelp,
  renderReply,
  renderResetDone,
  renderSystemUpdated,
  renderSystemUsage,
  renderUnknownCommand,
  renderUsage,
} from './render.js';

/** 正常退出（`/exit`、`/quit`、Ctrl-D）。 */
export const EXIT_OK = 0;
/** 启动失败（配置错误）。 */
export const EXIT_FAILURE = 1;
/** Ctrl-C：128 + SIGINT(2)。验收项写死了 130。 */
export const EXIT_CANCELLED = 130;
/** SIGTERM：128 + SIGTERM(15)。 */
export const EXIT_TERMINATED = 143;
/** 第一次 Ctrl-C 之后等待回合 settle 的上限。 */
export const SETTLE_TIMEOUT_MS = 1_000;

/** 一行输入被解释成的结果。 */
export type ParsedInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'system'; readonly text: string }
  | { readonly kind: 'history' }
  | { readonly kind: 'help' }
  | { readonly kind: 'unknown'; readonly name: string }
  | { readonly kind: 'message'; readonly text: string };

/**
 * 把一行原始输入解释成命令或对话内容。
 *
 * 纯函数，`repl` 的所有命令语义都靠它单测；空行（含纯空白）忽略，
 * 不以 `/` 开头的一律是对话内容。
 */
export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed === '') {
    return { kind: 'empty' };
  }
  if (!trimmed.startsWith('/')) {
    return { kind: 'message', text: trimmed };
  }

  const separator = trimmed.search(/\s/);
  const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const rest = separator === -1 ? '' : trimmed.slice(separator).trim();

  switch (name) {
    case '/exit':
    case '/quit':
      return { kind: 'exit' };
    case '/reset':
      return { kind: 'reset' };
    case '/system':
      return { kind: 'system', text: rest };
    case '/history':
      return { kind: 'history' };
    case '/help':
      return { kind: 'help' };
    default:
      return { kind: 'unknown', name };
  }
}

/** 信号处理器依赖：全部注入，便于不碰真进程地单测。 */
export interface ShutdownDeps {
  /** 关掉 readline（否则 stdin 句柄存活，进程退不掉）。 */
  readonly closeInput: () => void;
  /** 当前在飞回合的控制器；没有在飞回合时返回 `undefined`。 */
  readonly inFlight: () => AbortController | undefined;
  /** 当前回合的 promise，用来等它 settle；没有则返回 `undefined`。 */
  readonly pendingTurn: () => Promise<unknown> | undefined;
  readonly exit: (code: number) => void;
  readonly settleTimeoutMs?: number;
}

export interface ShutdownHandler {
  /** 收到 SIGINT / SIGTERM 时调用。 */
  handle(signal: 'SIGINT' | 'SIGTERM'): void;
  /** 是否已经进入退出流程。 */
  readonly exiting: boolean;
  /** 本次退出应使用的退出码。 */
  readonly exitCode: number;
}

/**
 * 两段式退出：第一下 abort + 关输入 + 有限等待，第二下立刻走。
 *
 * 关键点是**先 abort 再等**：不 abort 的话「等待 settle」只是等满 1s 再退出，
 * 用户会看到 Ctrl-C 之后 shell 卡住一秒 —— 那正是「Ctrl-C 了但提示符不回来」。
 */
export function createShutdownHandler(deps: ShutdownDeps): ShutdownHandler {
  const settleTimeoutMs = deps.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
  let exiting = false;
  let exitCode = EXIT_OK;

  const handle = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const code = signal === 'SIGINT' ? EXIT_CANCELLED : EXIT_TERMINATED;

    // settle 期间又按了一次：不再等待，立刻退出。
    if (exiting) {
      deps.exit(code);
      return;
    }

    exiting = true;
    exitCode = code;

    deps.inFlight()?.abort(new UserAbortError('request cancelled by Ctrl-C'));
    deps.closeInput();

    const pending = deps.pendingTurn();
    const settled = pending === undefined ? Promise.resolve() : Promise.race([pending.catch(() => undefined), delay(settleTimeoutMs)]);

    void settled.then(() => {
      deps.exit(code);
    });
  };

  return {
    handle,
    get exiting() {
      return exiting;
    },
    get exitCode() {
      return exitCode;
    },
  };
}

/** `repl` 的全部外部依赖；除 `session`/`config` 外都可注入，测试不碰真 TTY。 */
export interface ReplDeps {
  readonly session: ChatSession;
  readonly config: AppConfig;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly errorOutput?: NodeJS.WritableStream;
  /** 已经按 `logLevel` 过滤过的日志出口（`[retry] ...` 之类）。 */
  readonly log?: (message: string) => void;
  /** 退出动作，默认 `process.exit`；测试注入成 spy。 */
  readonly exit?: (code: number) => void;
  /** 是否打印启动横幅，默认 `true`。 */
  readonly banner?: boolean;
}

/**
 * 跑一轮 REPL，返回退出码（调用方决定是否 `process.exit`）。
 *
 * 返回而不是直接退出，是为了让 `index.ts` 只有一处出口，
 * 也让测试能在同一个进程里断言退出码。
 */
export async function runRepl(deps: ReplDeps): Promise<number> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const errorOutput = deps.errorOutput ?? process.stderr;
  const log = deps.log ?? ((): void => {});
  const exit = deps.exit ?? ((code: number): void => process.exit(code));

  const rl = createInterface({ input, output, terminal: false, crlfDelay: Infinity });

  // 真 TTY 会自己把输入回显出来（行规程在干活）；管道/测试里没有人回显，
  // 由我们补一行，否则记录里只剩 `you> bot> ...` 粘在一起，读不出问了什么。
  const echoInput = !('isTTY' in input && input.isTTY === true);

  let inFlight: AbortController | undefined;
  let pendingTurn: Promise<unknown> | undefined;

  const shutdown = createShutdownHandler({
    closeInput: () => rl.close(),
    inFlight: () => inFlight,
    pendingTurn: () => pendingTurn,
    exit,
  });

  const onSigint = (): void => shutdown.handle('SIGINT');
  const onSigterm = (): void => shutdown.handle('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  if (deps.banner ?? true) {
    output.write(`${renderBanner(deps.config)}\n`);
  }

  let exitCode = EXIT_OK;

  try {
    output.write(PROMPT);

    // 用异步迭代而不是 `while (await rl.question())`：
    // 输入结束时 `question()` 的 promise 永不 settle（Node 实测），迭代会正常结束。
    for await (const line of rl) {
      const parsed = parseInput(line);

      if (parsed.kind === 'empty') {
        output.write(PROMPT);
        continue;
      }
      if (echoInput) {
        output.write(`${line.trim()}\n`);
      }

      switch (parsed.kind) {
        case 'exit':
          exitCode = EXIT_OK;
          break;
        case 'reset':
          deps.session.reset();
          output.write(`${renderResetDone()}\n${PROMPT}`);
          continue;
        case 'system':
          if (parsed.text === '') {
            output.write(`${renderSystemUsage()}\n${PROMPT}`);
            continue;
          }
          deps.session.setSystemPrompt(parsed.text);
          output.write(`${renderSystemUpdated(parsed.text)}\n${PROMPT}`);
          continue;
        case 'history':
          output.write(`${renderHistory(deps.session.snapshot())}\n${PROMPT}`);
          continue;
        case 'help':
          output.write(`${renderHelp()}\n${PROMPT}`);
          continue;
        case 'unknown':
          output.write(`${renderUnknownCommand(parsed.name)}\n${PROMPT}`);
          continue;
        case 'message':
          exitCode = await runTurn(parsed.text, {
            session: deps.session,
            output,
            errorOutput,
            log,
            config: deps.config,
            setInFlight: (controller, turn) => {
              inFlight = controller;
              pendingTurn = turn;
            },
          });
          if (exitCode !== EXIT_OK) {
            break;
          }
          output.write(PROMPT);
          continue;
      }

      break;
    }
  } finally {
    // 无论怎么结束，信号监听和 readline 都必须摘掉，否则进程不退出。
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    rl.close();
  }

  return shutdown.exiting ? shutdown.exitCode : exitCode;
}

interface TurnContext {
  readonly session: ChatSession;
  readonly output: NodeJS.WritableStream;
  readonly errorOutput: NodeJS.WritableStream;
  readonly log: (message: string) => void;
  readonly config: AppConfig;
  readonly setInFlight: (controller: AbortController | undefined, turn: Promise<unknown> | undefined) => void;
}

/**
 * 跑一个回合：成功后打印 `bot> ...`，失败只渲染不重试。
 *
 * 返回非 0 表示「该收尾了」（用户取消了本回合）。
 */
async function runTurn(text: string, context: TurnContext): Promise<number> {
  const controller = new AbortController();
  const turn = context.session.turn(text, { signal: controller.signal });
  context.setInFlight(controller, turn);

  try {
    const result = await turn;
    context.output.write(`${renderReply(result)}\n`);

    if (context.config.logLevel === 'debug' && result.assistant.usage !== undefined) {
      context.log(renderUsage(result.assistant.usage));
    }
    return EXIT_OK;
  } catch (cause) {
    context.errorOutput.write(`${renderError(cause, { retries: context.config.maxRetries, timeoutMs: context.config.timeoutMs }).text}\n`);
    // 用户自己取消的回合不继续问下一句，直接走去退出流程。
    return cause instanceof UserAbortError ? EXIT_CANCELLED : EXIT_OK;
  } finally {
    context.setInFlight(undefined, undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 这个定时器只是「别等太久」，不该把进程钉住。
    timer.unref?.();
  });
}
