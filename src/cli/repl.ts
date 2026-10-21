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
import type { AppConfig, MutableConfigKey } from '../config.js';
import { MUTABLE_CONFIG_ENV_VARS, MUTABLE_CONFIG_KEYS, isMutableConfigKey } from '../config.js';
import type { ConfigStore } from '../config-store.js';
import type { EnvFileResult } from '../env-file.js';
import { updateEnvFile } from '../env-file.js';
import { ConfigError, UserAbortError } from '../http/errors.js';
import type { ChatSession } from '../session/chat-session.js';
import {
  CONFIG_MENU_PROMPT,
  PROMPT,
  renderBanner,
  renderConfigCancelled,
  renderConfigResetDone,
  renderConfigSaveFailed,
  renderConfigSaved,
  renderConfigSetUsage,
  renderConfigTable,
  renderConfigUnknownChoice,
  renderConfigUnknownKey,
  renderConfigUpdated,
  renderConfigValuePrompt,
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
  | { readonly kind: 'config'; readonly sub: 'show' }
  | { readonly kind: 'config'; readonly sub: 'set'; readonly key: string; readonly value: string }
  | { readonly kind: 'config'; readonly sub: 'reset' }
  | { readonly kind: 'config'; readonly sub: 'save' }
  | { readonly kind: 'config'; readonly sub: 'unknown'; readonly name: string }
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
    case '/config':
      return parseConfigCommand(rest);
    default:
      return { kind: 'unknown', name };
  }
}

/**
 * `/config` 的子命令。
 *
 * `set` 的值取「键之后的全部剩余文本」：`/config set systemPrompt 你是译者` 里
 * 提示语自己带空格，不能按空白切第二刀。
 */
function parseConfigCommand(rest: string): ParsedInput {
  if (rest === '') {
    return { kind: 'config', sub: 'show' };
  }

  const separator = rest.search(/\s/);
  const sub = (separator === -1 ? rest : rest.slice(0, separator)).toLowerCase();
  const tail = separator === -1 ? '' : rest.slice(separator).trim();

  switch (sub) {
    case 'set': {
      const keyEnd = tail.search(/\s/);
      return {
        kind: 'config',
        sub: 'set',
        key: keyEnd === -1 ? tail : tail.slice(0, keyEnd),
        value: keyEnd === -1 ? '' : tail.slice(keyEnd).trim(),
      };
    }
    case 'reset':
      return { kind: 'config', sub: 'reset' };
    case 'save':
      return { kind: 'config', sub: 'save' };
    default:
      return { kind: 'config', sub: 'unknown', name: sub };
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

/** `repl` 的全部外部依赖；除 `session`/`store` 外都可注入，测试不碰真 TTY。 */
export interface ReplDeps {
  readonly session: ChatSession;
  /** 会话内配置的唯一真相；`config` 每回合现取，改动下一句就生效。 */
  readonly store: ConfigStore;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly errorOutput?: NodeJS.WritableStream;
  /** 已经按 `logLevel` 过滤过的日志出口（`[retry] ...` 之类）。 */
  readonly log?: (message: string) => void;
  /** 退出动作，默认 `process.exit`；测试注入成 spy。 */
  readonly exit?: (code: number) => void;
  /** 是否打印启动横幅，默认 `true`。 */
  readonly banner?: boolean;
  /** `/config save` 的目标文件，默认 `.env`。 */
  readonly envFile?: string;
  /** 写盘的注入点，默认走 `updateEnvFile(envFile, updates)`；测试换成假实现。 */
  readonly saveEnv?: (updates: Readonly<Record<string, string | undefined>>) => Promise<EnvFileResult>;
}

/** 菜单的等待状态：等用户选编号，或等用户给某一项输入新值。 */
type MenuState =
  | { readonly kind: 'choice' }
  | { readonly kind: 'value'; readonly key: MutableConfigKey };

/** 把当前配置里某一项序列化成 `.env` 的取值（`undefined` 表示删掉那行）。 */
function envValueOf(config: AppConfig, key: MutableConfigKey): string | undefined {
  switch (key) {
    case 'model':
      return config.model;
    case 'systemPrompt':
      return config.systemPrompt;
    case 'maxTokens':
      return config.maxTokens === undefined ? undefined : String(config.maxTokens);
    case 'temperature':
      return config.temperature === undefined ? undefined : String(config.temperature);
  }
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
  const store = deps.store;
  const saveEnv =
    deps.saveEnv ??
    ((updates: Readonly<Record<string, string | undefined>>): Promise<EnvFileResult> =>
      updateEnvFile(deps.envFile ?? '.env', updates));

  /**
   * 两边都是终端时才让 readline 接管行编辑。
   *
   * 这里的关键不是「好看」，而是**退格到底由谁擦**：`terminal: false` 把擦除交给内核的
   * 行规程（cooked 模式），可 stdin 是不是 cooked 由父进程决定 —— 在 raw 的 pty 里
   * （终端复用器、IDE 任务、`script` 之类）`\x7f` 会原样送进来，表现就是「退格删不掉字」，
   * 而且这些控制字符还会跟着正文一起发给模型。`terminal: true` 由 readline 自己解析按键，
   * 退格、方向键、Ctrl-C 都变成它的事件，不依赖终端模式。
   */
  const interactive = isTty(input) && isTty(output);

  const rl = createInterface({
    input,
    output,
    terminal: interactive,
    crlfDelay: Infinity,
    // ↑ 翻历史只在交互模式有意义；管道里没有按键，也不用攒。
    historySize: interactive ? 100 : 0,
    // 关掉 Tab 补全：聊天输入框里跳出一串 JS 标识符候选只会碍事。
    completer: (line: string): [string[], string] => [[], line],
  });

  // 没人回显的环境（管道、测试）由我们补一行，否则记录里只剩 `you> bot> ...` 粘在一起。
  const echoInput = !isTty(input);

  let inFlight: AbortController | undefined;
  let pendingTurn: Promise<unknown> | undefined;
  /** `/config` 的两步交互状态：菜单等待中，或某一项等新值。 */
  let menu: MenuState | undefined;

  /**
   * 画提示符。
   *
   * 交互模式必须走 `rl.setPrompt()` + `rl.prompt()`：readline 需要知道提示符多长，
   * 才能在退格/方向键之后把整行重绘到正确位置。自己 `write()` 出去的话，
   * 它不知道那一行的存在，编辑时就会把提示符一起擦掉或错位。
   */
  const writePrompt = (text: string = PROMPT): void => {
    if (interactive) {
      rl.setPrompt(text);
      rl.prompt();
      return;
    }
    output.write(text);
  };

  /**
   * 改一项配置，并把 systemPrompt 同步给会话。
   *
   * 会话层的 systemPrompt 是它自己的状态（`setSystemPrompt`），不是每回合从配置读的，
   * 所以两处必须一起推 —— 否则 `/config set systemPrompt ...` 会「改完没反应」。
   */
  const applyConfig = (key: MutableConfigKey, raw: string): void => {
    try {
      store.set(key, raw);
    } catch (cause) {
      if (!(cause instanceof ConfigError)) {
        throw cause;
      }
      // 校验失败走 stderr，与其它错误一致：正文流只放对话内容。
      errorOutput.write(`${renderError(cause, {}).text}\n`);
      return;
    }

    const config = store.get();
    if (key === 'systemPrompt') {
      deps.session.setSystemPrompt(config.systemPrompt);
    }
    output.write(`${renderConfigUpdated(key, config)}\n`);
  };

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
  // 交互模式下 Ctrl-C 是 raw 按键，不会再变成信号：readline 的 'SIGINT' 事件是唯一入口。
  rl.on('SIGINT', onSigint);

  if (deps.banner ?? true) {
    output.write(`${renderBanner(store.initial)}\n`);
  }

  let exitCode = EXIT_OK;

  try {
    writePrompt();

    // 用异步迭代而不是 `while (await rl.question())`：
    // 输入结束时 `question()` 的 promise 永不 settle（Node 实测），迭代会正常结束。
    for await (const line of rl) {
      const parsed = parseInput(line);

      // 先看菜单状态：它比斜杠命令优先，否则用户输个 `2` 会被当成对话内容发出去。
      if (menu !== undefined) {
        if (parsed.kind === 'empty') {
          menu = undefined;
          output.write(`${renderConfigCancelled()}\n`);
          writePrompt();
          continue;
        }
        const answer = line.trim();
        if (echoInput) {
          output.write(`${answer}\n`);
        }
        if (menu.kind === 'choice') {
          const outcome = readMenuChoice(answer, store);
          if (outcome.kind === 'error') {
            output.write(`${outcome.message}\n`);
            writePrompt(CONFIG_MENU_PROMPT);
            continue;
          }
          menu = { kind: 'value', key: outcome.key };
          writePrompt(outcome.prompt);
          continue;
        }
        const key = menu.key;
        menu = undefined;
        applyConfig(key, answer);
        writePrompt();
        continue;
      }

      if (parsed.kind === 'empty') {
        writePrompt();
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
          output.write(`${renderResetDone()}\n`);
          writePrompt();
          continue;
        case 'system':
          if (parsed.text === '') {
            output.write(`${renderSystemUsage()}\n`);
            writePrompt();
            continue;
          }
          deps.session.setSystemPrompt(parsed.text);
          output.write(`${renderSystemUpdated(parsed.text)}\n`);
          writePrompt();
          continue;
        case 'history':
          output.write(`${renderHistory(deps.session.snapshot())}\n`);
          writePrompt();
          continue;
        case 'help':
          output.write(`${renderHelp()}\n`);
          writePrompt();
          continue;
        case 'config': {
          if (parsed.sub === 'show') {
            output.write(`${renderConfigTable(store.get(), store.modifiedKeys())}\n`);
            menu = { kind: 'choice' };
            writePrompt(CONFIG_MENU_PROMPT);
            continue;
          }
          if (parsed.sub === 'set') {
            if (parsed.value === '') {
              output.write(`${renderConfigSetUsage()}\n`);
              writePrompt();
              continue;
            }
            if (!isMutableConfigKey(parsed.key)) {
              output.write(`${renderConfigUnknownKey(parsed.key)}\n`);
              writePrompt();
              continue;
            }
            applyConfig(parsed.key, parsed.value);
            writePrompt();
            continue;
          }
          if (parsed.sub === 'reset') {
            store.reset();
            deps.session.setSystemPrompt(store.get().systemPrompt);
            output.write(`${renderConfigResetDone()}\n`);
            writePrompt();
            continue;
          }
          if (parsed.sub === 'save') {
            const result = await saveConfig(store, saveEnv);
            if (result !== undefined && !result.ok) {
              errorOutput.write(`${renderConfigSaveFailed(result.message)}\n`);
              writePrompt();
              continue;
            }
            output.write(`${renderConfigSaved(result === undefined ? [] : result.changed)}\n`);
            writePrompt();
            continue;
          }
          output.write(`${renderUnknownCommand(`/config ${parsed.name}`)}\n`);
          writePrompt();
          continue;
        }
        case 'unknown':
          output.write(`${renderUnknownCommand(parsed.name)}\n`);
          writePrompt();
          continue;
        case 'message':
          exitCode = await runTurn(parsed.text, {
            session: deps.session,
            output,
            errorOutput,
            log,
            config: store.get(),
            setInFlight: (controller, turn) => {
              inFlight = controller;
              pendingTurn = turn;
            },
          });
          if (exitCode !== EXIT_OK) {
            break;
          }
          writePrompt();
          continue;
      }

      break;
    }
  } finally {
    // 无论怎么结束，信号监听和 readline 都必须摘掉，否则进程不退出。
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    rl.off('SIGINT', onSigint);
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

/** 菜单里读一行编号的结果：要么报错重来，要么进入「等这一项的新值」。 */
type MenuOutcome =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'value'; readonly key: MutableConfigKey; readonly prompt: string };

/**
 * 菜单里读一行编号。
 *
 * 输错了不退出菜单（再给一次机会），这是菜单式交互的基本礼貌；
 * 直接回车已经在调用方处理成「取消」。返回值不直接写输出，是为了让调用方
 * 决定用 `writePrompt()` 还是普通 `write()` —— 交互模式下提示符必须由 readline 画。
 */
function readMenuChoice(answer: string, store: ConfigStore): MenuOutcome {
  const index = Number(answer);
  const key = Number.isInteger(index) ? MUTABLE_CONFIG_KEYS[index - 1] : undefined;

  if (key === undefined) {
    return { kind: 'error', message: renderConfigUnknownChoice(answer) };
  }

  return { kind: 'value', key, prompt: renderConfigValuePrompt(key, store.get()) };
}

/**
 * 判断一个流是不是终端。
 *
 * `node:stream` 的类型里没有 `isTTY`（它属于 `tty.ReadStream`），但运行时只有
 * 真终端才带这个属性，所以用 `in` 收窄比 `as` 干净。
 */
function isTty(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return 'isTTY' in stream && stream.isTTY === true;
}

/**
 * `/config save`：只写「本次会话改过」的项。
 *
 * 返回 `undefined` 表示没有改动需要写盘（不碰文件，也不产生 `.bak`）。
 * 故意不支持单个项的保存：手写 `.env` 的价值就是「一次想清楚再落盘」。
 */
async function saveConfig(
  store: ConfigStore,
  saveEnv: (updates: Readonly<Record<string, string | undefined>>) => Promise<EnvFileResult>,
): Promise<EnvFileResult | undefined> {
  const keys = store.modifiedKeys();
  if (keys.length === 0) {
    return undefined;
  }

  const config = store.get();
  const updates: Record<string, string | undefined> = {};
  for (const key of keys) {
    updates[MUTABLE_CONFIG_ENV_VARS[key]] = envValueOf(config, key);
  }
  return saveEnv(updates);
}
