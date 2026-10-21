/**
 * L3：真进程 + 真信号。
 *
 * 这一层只验证自动测试里唯一没法用桩证明的两件事：
 * 1. 请求在飞时 Ctrl-C（SIGINT）能让进程**自己**以 130 退出，而不是等满 60s 超时；
 * 2. 退出之后 shell 立刻拿回提示符（没有残留句柄把进程钉住）。
 *
 * 因此这里必须 spawn 真进程（`tsx src/index.ts`），并配一个真的会 hang 的 HTTP 服务器。
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXIT_CANCELLED = 130;
/** 留给 tsx 编译 + 启动的时间。 */
const BOOT_TIMEOUT_MS = 10_000;
/** SIGINT 之后进程应当在这段时间内退出（远小于 60s 超时）。 */
const EXIT_BUDGET_MS = 3_000;

interface HangingServer {
  readonly url: string;
  readonly hits: () => number;
  readonly whenHit: Promise<void>;
  readonly close: () => Promise<void>;
}

/** 永远不响应的服务器：保证请求一直在飞。 */
async function startHangingServer(): Promise<HangingServer> {
  let hits = 0;
  let markHit: () => void = () => {};
  const whenHit = new Promise<void>((resolve) => {
    markHit = resolve;
  });

  const server: Server = createServer(() => {
    hits += 1;
    markHit();
    // 故意不写响应：连接保持打开，直到客户端 abort。
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    whenHit,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface ChildRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

describe('CLI 进程级行为', () => {
  it(
    '请求在飞时 SIGINT：abort 当前回合并以 130 退出',
    { timeout: 20_000 },
    async () => {
      const server = await startHangingServer();
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          LLM_API_KEY: 'sk-test',
          LLM_BASE_URL: server.url,
          LLM_MODEL: 'test-model',
          LLM_MAX_RETRIES: '0',
          LLM_TIMEOUT_MS: '60000',
          LOG_LEVEL: 'error',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => stdout.push(chunk));
      child.stderr.on('data', (chunk: string) => stderr.push(chunk));

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });

      try {
        // 等横幅出现再输入：确保 readline 已经就绪。
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`启动超时，stdout=${stdout.join('')}`)), BOOT_TIMEOUT_MS);
          child.stdout.on('data', () => {
            if (stdout.join('').includes('you> ')) {
              clearTimeout(timer);
              resolve();
            }
          });
        });

        const startedAt = Date.now();
        child.stdin.write('你好\n');
        // 服务器收到请求 = 回合确实在飞。
        await server.whenHit;
        child.kill('SIGINT');

        const result: ChildRun = { ...(await exited), stdout: stdout.join(''), stderr: stderr.join(''), elapsedMs: Date.now() - startedAt };

        expect(result.signal).toBeNull();
        expect(result.code).toBe(EXIT_CANCELLED);
        expect(result.elapsedMs).toBeLessThan(EXIT_BUDGET_MS);
        expect(result.stderr).toContain('^C 已取消本次回合');
        // 只有一次请求：abort 之后没有偷偷重试。
        expect(server.hits()).toBe(1);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        await server.close();
      }
    },
  );

  it('配置缺失时立刻以 1 退出并打印所需变量', { timeout: 20_000 }, async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: PROJECT_ROOT,
      // 显式清空 key：只验证「没 key 就退出」，不受宿主环境影响。
      env: { ...process.env, LLM_API_KEY: '', LOG_LEVEL: 'error' },
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    const stderr: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', (exitCode) => resolve(exitCode));
    });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('! 配置错误: ');
    expect(stderr.join('')).toContain('LLM_API_KEY');
  });

  it('stdin 关闭（Ctrl-D 的效果）时以 0 退出', { timeout: 20_000 }, async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, LLM_API_KEY: 'sk-test', LLM_BASE_URL: 'http://127.0.0.1:1', LOG_LEVEL: 'error' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    child.stdin.end('/exit\n');

    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', (exitCode) => resolve(exitCode));
    });

    expect(code).toBe(0);
  });
});
