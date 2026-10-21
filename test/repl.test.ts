/**
 * L1 + L2：REPL 的命令解析、退出流程与整轮交互。
 *
 * 三层分开测：
 * - `parseInput` 纯函数：斜杠命令语义；
 * - `createShutdownHandler` 依赖全注入：两段式退出、settle 上限、退出码；
 * - `runRepl` 用 `PassThrough` 假 stdin/out：真实跑循环，但一次网络请求都不发。
 *
 * 真正的 Ctrl-C 信号只能靠子进程验证，那条放在文件末尾的 L3。
 */

import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_CANCELLED,
  EXIT_OK,
  EXIT_TERMINATED,
  createShutdownHandler,
  parseInput,
  runRepl,
  type ShutdownDeps,
} from '../src/cli/repl.js';
import { loadConfig } from '../src/config.js';
import { AuthError, UserAbortError } from '../src/http/errors.js';
import type { AssistantMessage, ChatMessage } from '../src/llm/types.js';
import { createChatSession, type ChatSession } from '../src/session/chat-session.js';
import type { LlmClient } from '../src/llm/llm-client.js';

const config = loadConfig({ LLM_API_KEY: 'sk-test' });

const REPLY: AssistantMessage = { role: 'assistant', content: '收到', finishReason: 'stop' };

/** 让出若干轮事件循环：settle 等待链要经过 race + then 好几跳。 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 记录写入内容的可写流。 */
function collector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: unknown, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

interface Harness {
  readonly session: ChatSession;
  readonly requests: ChatMessage[][];
}

function makeSession(handler?: (messages: readonly ChatMessage[]) => Promise<AssistantMessage>): Harness {
  const requests: ChatMessage[][] = [];
  const llm: LlmClient = {
    async chat(messages) {
      requests.push([...messages]);
      if (handler !== undefined) {
        return handler(messages);
      }
      return REPLY;
    },
  };
  return {
    session: createChatSession({ llm, systemPrompt: '你是助手', maxHistoryMessages: 40 }),
    requests,
  };
}

interface ReplRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 把若干行输入喂给 `runRepl`，收齐输出与退出码。 */
async function run(lines: readonly string[], options: { session?: ChatSession; exit?: (code: number) => void } = {}): Promise<ReplRun> {
  const session = options.session ?? makeSession().session;
  const input = new PassThrough();
  const out = collector();
  const err = collector();

  const done = runRepl({
    session,
    config,
    input,
    output: out.stream,
    errorOutput: err.stream,
    log: () => {},
    ...(options.exit === undefined ? {} : { exit: options.exit }),
  });

  input.end(lines.map((line) => `${line}\n`).join(''));

  return { code: await done, stdout: out.text(), stderr: err.text() };
}

describe('parseInput', () => {
  it.each([
    ['/exit', 'exit'],
    ['/quit', 'exit'],
    ['  /exit  ', 'exit'],
    ['/EXIT', 'exit'],
    ['/reset', 'reset'],
    ['/history', 'history'],
    ['/help', 'help'],
  ] as const)('%s → %s', (line, kind) => {
    expect(parseInput(line).kind).toBe(kind);
  });

  it('空行与纯空白都是 empty', () => {
    expect(parseInput('').kind).toBe('empty');
    expect(parseInput('   \t ').kind).toBe('empty');
  });

  it('普通文本是 message，并且去掉首尾空白', () => {
    expect(parseInput('  你好  ')).toEqual({ kind: 'message', text: '你好' });
  });

  it('/system 保留参数原文', () => {
    expect(parseInput('/system  你是翻译  ')).toEqual({ kind: 'system', text: '你是翻译' });
    expect(parseInput('/system')).toEqual({ kind: 'system', text: '' });
  });

  it('未知斜杠命令带出命令名', () => {
    expect(parseInput('/foo bar')).toEqual({ kind: 'unknown', name: '/foo' });
  });

  it('单个 / 也算未知命令', () => {
    expect(parseInput('/')).toEqual({ kind: 'unknown', name: '/' });
  });

  it('不以 / 开头的文本里出现斜杠也当对话内容', () => {
    expect(parseInput('1/2 是多少')).toEqual({ kind: 'message', text: '1/2 是多少' });
  });
});

describe('createShutdownHandler', () => {
  interface Fixture {
    readonly deps: ShutdownDeps;
    readonly exit: ReturnType<typeof vi.fn>;
    readonly closeInput: ReturnType<typeof vi.fn>;
    readonly controller: AbortController;
    setPending(pending: Promise<unknown> | undefined): void;
  }

  function fixture(over: Partial<ShutdownDeps> = {}): Fixture {
    const exit = vi.fn();
    const closeInput = vi.fn();
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;

    return {
      deps: {
        closeInput,
        inFlight: () => controller,
        pendingTurn: () => pending,
        exit,
        settleTimeoutMs: 5,
        ...over,
      },
      exit,
      closeInput,
      controller,
      setPending: (next) => {
        pending = next;
      },
    };
  }

  it('第一下 SIGINT：abort 在飞回合 + 关输入，然后以 130 退出', async () => {
    const f = fixture();
    f.setPending(Promise.resolve());
    const handler = createShutdownHandler(f.deps);

    handler.handle('SIGINT');

    expect(f.controller.signal.aborted).toBe(true);
    expect(f.controller.signal.reason).toBeInstanceOf(UserAbortError);
    expect(f.closeInput).toHaveBeenCalledTimes(1);
    expect(handler.exiting).toBe(true);
    expect(handler.exitCode).toBe(EXIT_CANCELLED);

    // 先 abort 再等 settle：回合立刻结束的场合不该有额外延迟。
    await tick();
    expect(f.exit).toHaveBeenCalledWith(EXIT_CANCELLED);
  });

  it('SIGTERM 用 143', async () => {
    const f = fixture();
    f.setPending(Promise.resolve());
    const handler = createShutdownHandler(f.deps);

    handler.handle('SIGTERM');
    await tick();

    expect(f.exit).toHaveBeenCalledWith(EXIT_TERMINATED);
    expect(handler.exitCode).toBe(EXIT_TERMINATED);
  });

  it('settle 期间再按一次：立即退出，不再等待', () => {
    const f = fixture();
    // 永不 settle 的回合：第一次只登记等待，第二次必须马上走。
    f.setPending(new Promise(() => {}));
    const handler = createShutdownHandler(f.deps);

    handler.handle('SIGINT');
    expect(f.exit).not.toHaveBeenCalled();

    handler.handle('SIGINT');
    expect(f.exit).toHaveBeenCalledWith(EXIT_CANCELLED);
  });

  it('回合迟迟不 settle 时，等待被 settleTimeoutMs 截断', async () => {
    const f = fixture();
    f.setPending(new Promise(() => {}));
    const handler = createShutdownHandler(f.deps);

    handler.handle('SIGINT');
    expect(f.exit).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.exit).toHaveBeenCalledWith(EXIT_CANCELLED);
  });

  it('没有在飞回合也能正常退出（只是没有可 abort 的东西）', async () => {
    const f = fixture({ inFlight: () => undefined });
    const handler = createShutdownHandler(f.deps);

    handler.handle('SIGINT');
    await tick();

    expect(f.closeInput).toHaveBeenCalledTimes(1);
    expect(f.exit).toHaveBeenCalledWith(EXIT_CANCELLED);
  });

  it('回合的 rejection 不会变成未处理拒绝（否则进程会崩）', async () => {
    const f = fixture();
    f.setPending(Promise.reject(new Error('aborted')));
    const handler = createShutdownHandler(f.deps);

    handler.handle('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(f.exit).toHaveBeenCalledWith(EXIT_CANCELLED);
  });
});

describe('runRepl：对话与命令', () => {
  it('普通文本走一回合，输出 bot> 前缀，历史按轮增长', async () => {
    const harness = makeSession();
    const result = await run(['第一句', '第二句', '/exit'], { session: harness.session });

    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout.match(/bot> 收到/g)).toHaveLength(2);
    expect(harness.session.snapshot()).toHaveLength(4);
    expect(harness.requests).toHaveLength(2);
    // 第二次请求能同时看到第一轮的 user/assistant（上下文连贯）。
    expect(harness.requests[1]?.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('每轮对话前打 you> 提示符，非 TTY 时回显输入（记录里能看出问了什么）', async () => {
    const result = await run(['你好', '/exit']);

    expect(result.stdout).toContain('you> 你好');
    expect(result.stdout).toContain('bot> 收到');
    expect(result.stdout.match(/you> /g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('空行忽略，不触发回合', async () => {
    const harness = makeSession();
    const result = await run(['', '   ', '\t', '/exit'], { session: harness.session });

    expect(harness.requests).toHaveLength(0);
    expect(result.stdout.match(/bot> /g)).toBeNull();
  });

  it('/reset 清空历史但保留 system prompt', async () => {
    const harness = makeSession();
    const result = await run(['第一句', '/reset', '第二句', '/exit'], { session: harness.session });

    expect(result.stdout).toContain('历史已清空');
    expect(harness.session.getSystemPrompt()).toBe('你是助手');
    // reset 之后的请求只剩 system + 这一句 user。
    expect(harness.requests[1]).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '第二句' },
    ]);
    expect(harness.session.snapshot()).toHaveLength(2);
  });

  it('/system 改提示词、不动历史，下一轮生效', async () => {
    const harness = makeSession();
    const result = await run(['第一句', '/system 你是翻译', '第二句', '/history', '/exit'], {
      session: harness.session,
    });

    expect(result.stdout).toContain('system prompt 已更新');
    expect(harness.session.getSystemPrompt()).toBe('你是翻译');
    expect(harness.requests[1]?.[0]).toEqual({ role: 'system', content: '你是翻译' });
    // 历史里不含 system：只有两轮 user/assistant。
    expect(harness.session.snapshot()).toHaveLength(4);
    expect(result.stdout).toContain('历史 4 条');
  });

  it('/system 不带参数时给用法提示，不改提示词', async () => {
    const harness = makeSession();
    const result = await run(['/system', '/exit'], { session: harness.session });

    expect(result.stdout).toContain('用法');
    expect(harness.session.getSystemPrompt()).toBe('你是助手');
  });

  it('/history 在空历史时说明为空', async () => {
    const result = await run(['/history', '/exit']);

    expect(result.stdout).toContain('历史为空');
  });

  it('/help 列出命令', async () => {
    const result = await run(['/help', '/exit']);

    expect(result.stdout).toContain('/reset');
    expect(result.stdout).toContain('/system');
  });

  it('未知命令给出提示但不退出', async () => {
    const result = await run(['/foo', '你好', '/exit']);

    expect(result.stdout).toContain('未知命令：/foo');
    expect(result.stdout).toContain('bot> 收到');
    expect(result.code).toBe(EXIT_OK);
  });

  it('Ctrl-D（输入结束）等同退出，退出码 0', async () => {
    const result = await run(['你好']);

    expect(result.code).toBe(EXIT_OK);
  });

  it('启动横幅默认打印，可关掉', async () => {
    const withBanner = await run(['/exit']);
    expect(withBanner.stdout).toContain('cli-chatbot · model=');

    const input = new PassThrough();
    const out = collector();
    const err = collector();
    const done = runRepl({
      session: makeSession().session,
      config,
      input,
      output: out.stream,
      errorOutput: err.stream,
      banner: false,
    });
    input.end('/exit\n');
    await done;

    expect(out.text()).not.toContain('cli-chatbot · model=');
  });

  it('debug 级别下打印 usage 行', async () => {
    const debugConfig = loadConfig({ LLM_API_KEY: 'sk-test', LOG_LEVEL: 'debug' });
    const session = makeSession(async () => ({
      role: 'assistant',
      content: '好',
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    })).session;

    const input = new PassThrough();
    const out = collector();
    const err = collector();
    const logs: string[] = [];
    const done = runRepl({
      session,
      config: debugConfig,
      input,
      output: out.stream,
      errorOutput: err.stream,
      log: (message) => logs.push(message),
    });
    input.end('你好\n/exit\n');
    await done;

    expect(logs).toContain('[usage] prompt=3 completion=1 total=4');
  });

  it('info 级别下不打印 usage 行', async () => {
    const session = makeSession(async () => ({
      role: 'assistant',
      content: '好',
      finishReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    })).session;

    const input = new PassThrough();
    const out = collector();
    const err = collector();
    const logs: string[] = [];
    const done = runRepl({
      session,
      config,
      input,
      output: out.stream,
      errorOutput: err.stream,
      log: (message) => logs.push(message),
    });
    input.end('你好\n/exit\n');
    await done;

    expect(logs).toEqual([]);
  });
});

describe('runRepl：错误渲染', () => {
  it('回合失败只渲染到 stderr，循环继续', async () => {
    let calls = 0;
    const session = makeSession(async () => {
      calls += 1;
      if (calls === 1) {
        throw new AuthError({ status: 401, statusText: 'Unauthorized', host: 'api.openai.com', body: '{"error":"bad"}' });
      }
      return REPLY;
    }).session;

    const result = await run(['第一句', '第二句', '/exit'], { session });

    expect(result.stderr).toContain('! 鉴权失败: ');
    expect(result.stderr).toContain('401');
    expect(result.stdout).toContain('bot> 收到');
    // 失败的回合没有污染历史：只剩第二次的一轮。
    expect(session.snapshot()).toHaveLength(2);
  });

  it('UserAbortError 打印取消提示并以 130 收尾', async () => {
    const session = makeSession(async () => {
      throw new UserAbortError();
    }).session;

    const result = await run(['第一句', '第二句', '/exit'], { session });

    expect(result.stderr).toContain('^C 已取消本次回合');
    expect(result.code).toBe(EXIT_CANCELLED);
    // 取消之后不再问下一句。
    expect(result.stdout.match(/bot> /g)).toBeNull();
  });

  it('非 AgentError 也不会让 REPL 崩', async () => {
    const session = makeSession(async () => {
      throw new Error('boom');
    }).session;

    const result = await run(['第一句', '/exit'], { session });

    expect(result.stderr).toContain('未知错误: boom');
    expect(result.code).toBe(EXIT_OK);
  });
});

describe('runRepl：信号监听的生命周期', () => {
  it('退出后摘掉 SIGINT / SIGTERM 监听（否则进程不退出）', async () => {
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    await run(['/exit']);

    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });
});
