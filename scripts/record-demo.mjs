#!/usr/bin/env node
/**
 * 生成 `demo.cast`。
 *
 * 为什么不是直接 `asciinema rec`：这台机器没装 asciinema，而 demo 要展示的三件事
 * （429 重试、三轮上下文、Ctrl-C 退出码）都需要可控的假服务器，不能靠真 key。
 * 所以这里**真的把 CLI 跑起来**（`tsx src/index.ts`），按真实时间戳收 stdout/stderr，
 * 再写成 asciinema v2 格式 —— 内容是程序自己产的，只有「谁按了什么键」是脚本安排的。
 *
 * 用法：`node scripts/record-demo.mjs`（会覆盖 demo.cast），回放用 `asciinema play demo.cast`。
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CAST_PATH = fileURLToPath(new URL('../demo.cast', import.meta.url));
const COLUMNS = 100;
const ROWS = 34;

// ---------------------------------------------------------------------------
// 录制器：一个单调递增的时间轴，所有输出按「第几秒说了什么」入账。
// ---------------------------------------------------------------------------

const events = [];
let clock = 0;

/** 在时间轴上追加一段输出（`at` 是会话内的绝对秒数，不早于上一刻）。 */
function write(text, at = clock) {
  clock = Math.max(clock, at);
  events.push([Number(clock.toFixed(3)), 'o', text]);
}

/** 空转一段时间，让回放有呼吸感。 */
function advance(seconds) {
  clock += seconds;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 按固定宽度切块：模拟模型逐字吐字（按字符切，中文也不会碎）。 */
function pieces(text, width) {
  const out = [];
  for (let i = 0; i < text.length; i += width) {
    out.push(text.slice(i, i + width));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 假服务器：第一次 429（带 Retry-After），之后按 messages 的条数回答，
// 这样录像里能直接看出「上下文在增长」。
// ---------------------------------------------------------------------------

function startFakeOpenAi() {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      calls += 1;

      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end('{"error":{"message":"Rate limit reached for gpt-4o-mini"}}');
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"invalid JSON"}}');
        return;
      }

      const messages = parsed.messages;
      const userTurns = messages.filter((message) => message.role === 'user');
      const last = userTurns.at(-1);
      const reasoning = `先数一下上下文：共 ${messages.length} 条消息，其中用户发言 ${userTurns.length} 次。`;
      const reply = `第 ${userTurns.length} 轮：我看到了 ${messages.length} 条消息（含 system），你刚说的是「${last.content}」。`;

      // 回 SSE：录出来的画面才有「思维链逐字、正文逐字」的可看性。
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const send = (delta) => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      };

      void (async () => {
        for (const piece of pieces(reasoning, 6)) {
          send({ reasoning_content: piece });
          await sleep(40);
        }
        for (const piece of pieces(reply, 5)) {
          send({ content: piece });
          await sleep(30);
        }
        send({});
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      })();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        hitCount: () => calls,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 永远不响应的服务器：用来演示「请求在飞时 Ctrl-C」。 */
function startHangingServer() {
  let hits = 0;
  const server = createServer(() => {
    hits += 1;
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        hitCount: () => hits,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 跑一次 CLI，把 stdout/stderr 按真实时间搬到时间轴上。
// ---------------------------------------------------------------------------

function startCli(baseUrl) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      LLM_API_KEY: 'sk-demo-not-a-real-key',
      LLM_BASE_URL: baseUrl,
      LLM_MODEL: 'gpt-4o-mini',
      LOG_LEVEL: 'info',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let seen = '';
  const listeners = [];

  const pipe = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      seen += chunk;
      write(chunk, (Date.now() - startedAt) / 1000 + sessionStartedAt);
      for (const listener of listeners) {
        listener();
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  const exited = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  return {
    child,
    exited,
    startedAt,
    /** 等输出里出现第 n 次 `bot> `。 */
    async waitForBot(n) {
      await waitUntil(() => countOccurrences(seen, 'bot> ') >= n);
    },
    async waitForText(text) {
      await waitUntil(() => seen.includes(text));
    },
    /** 等服务器那边确实收到了请求。 */
    onOutput(listener) {
      listeners.push(listener);
    },
  };
}

let sessionStartedAt = 0;

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function waitUntil(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待超时');
    }
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// 第一幕：三轮对话 + 一次 429 重试
// ---------------------------------------------------------------------------

async function recordConversation() {
  const server = await startFakeOpenAi();

  advance(0.2);
  write(`$ LLM_BASE_URL=${server.url} LLM_API_KEY=sk-demo tsx src/index.ts\n`, clock);
  advance(0.2);

  sessionStartedAt = clock;
  const cli = startCli(server.url);

  await cli.waitForText('you> ');

  const turns = ['记住数字 42，之后不要忘记', '我刚才让你记的数字，加 8 是多少？', '用一句话总结我们刚才聊了什么'];
  for (const [index, line] of turns.entries()) {
    // 用真等待而不是只推时间轴：否则脚本的「计划时间」会跑到程序前面，
    // 后面所有真实输出的时间戳都会被 clamp 到同一个点上。
    await sleep(900);
    cli.child.stdin.write(`${line}\n`);
    await cli.waitForBot(index + 1);
  }

  await sleep(900);
  cli.child.stdin.write('/exit\n');
  const code = await cli.exited;

  await sleep(400);
  write(`\n[进程退出，退出码 ${code}]\n`, clock);
  await server.close();
}

// ---------------------------------------------------------------------------
// 第二幕：请求在飞时 Ctrl-C（SIGINT → abort → 130）
// ---------------------------------------------------------------------------

async function recordSigint() {
  const server = await startHangingServer();

  advance(1.4);
  write(`$ LLM_BASE_URL=${server.url} tsx src/index.ts\n`, clock);
  advance(0.2);

  sessionStartedAt = clock;
  const cli = startCli(server.url);

  await cli.waitForText('you> ');
  await sleep(900);
  cli.child.stdin.write('这一句会卡住，因为服务器不响应\n');

  await waitUntil(() => server.hitCount() > 0);
  await sleep(1_200);

  // 终端里按下 Ctrl-C：先回显 ^C，再让真进程收到 SIGINT。
  write('^C\n', sessionStartedAt + (Date.now() - cli.startedAt) / 1000);
  const startedAt = Date.now();
  cli.child.kill('SIGINT');
  const code = await cli.exited;

  await sleep(300);
  write(`\n[进程退出，退出码 ${code}，耗时 ${Date.now() - startedAt}ms]\n`, sessionStartedAt + (Date.now() - cli.startedAt) / 1000);
  await server.close();
}

// ---------------------------------------------------------------------------

const RECORDED_AT = 1_760_000_000; // 固定时间戳，避免每次生成都改文件

write(`demo.cast 正在生成…\n`, 0);
advance(0.2);

await recordConversation();
await recordSigint();

write('\n[演示结束]\n', clock);

const header = {
  version: 2,
  width: COLUMNS,
  height: ROWS,
  timestamp: RECORDED_AT,
  env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
  // 自己额外记一笔来源，方便别人判断这段录像是怎么来的。
  command: 'node scripts/record-demo.mjs',
};

const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))];
writeFileSync(CAST_PATH, `${lines.join('\n')}\n`, 'utf8');

console.log(`已写入 ${CAST_PATH}（${events.length} 个事件，${clock.toFixed(1)}s）`);
