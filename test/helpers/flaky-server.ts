/**
 * 本地假服务器（L3 集成测试专用）。
 *
 * 为什么需要它：`vi.stubGlobal('fetch')` 能验证「重试了几次、错误怎么分类」，
 * 但永远无法证明「`AbortController` 真的把 socket 关了」。
 * 超时 / 用户取消这两个验收项必须有真实 socket 才能算证据。
 *
 * 每个请求按顺序取一个 step，用完后重复最后一个 —— 这样
 * `[500, ok]` 可以写成 `[{status:500}, {ok}]`，也能写成 `[hang]` 一直挂住。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type FlakyStep =
  /** 200 + JSON body。 */
  | { readonly kind: 'ok'; readonly body: unknown }
  /** 指定状态码；`body` 默认 `{"error":"x"}`。 */
  | { readonly kind: 'status'; readonly code: number; readonly headers?: Readonly<Record<string, string>>; readonly body?: string }
  /** 故意不响应，`ms` 之后才 end —— 用来触发超时。 */
  | { readonly kind: 'hang'; readonly ms: number }
  /** 直接断连 —— 触发 NetworkError。 */
  | { readonly kind: 'destroy' };

export interface FlakyServer {
  readonly url: string;
  /** 已收到的请求数；断言「401 只请求 1 次」就靠它。 */
  readonly hits: number;
  /** 清 timer、关连接、停监听；不调用会让 vitest 报 open handle。 */
  close(): Promise<void>;
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers?: Readonly<Record<string, string>>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export async function startFlakyServer(steps: readonly FlakyStep[]): Promise<FlakyServer> {
  const first = steps[0];
  if (first === undefined) {
    throw new Error('startFlakyServer 至少需要一个 step');
  }

  let hits = 0;
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // 消费请求体，避免 socket 因背压不结束。
    req.resume();

    const step = steps[Math.min(hits, steps.length - 1)] ?? first;
    hits += 1;

    switch (step.kind) {
      case 'ok':
        writeJson(res, 200, step.body);
        break;
      case 'status':
        res.writeHead(step.code, { 'content-type': 'application/json', ...step.headers });
        res.end(step.body ?? '{"error":"x"}');
        break;
      case 'hang': {
        const timer = setTimeout(() => {
          timers.delete(timer);
          res.end('late');
        }, step.ms);
        timers.add(timer);
        // 不让假服务器的定时器拖住测试进程。
        timer.unref();
        break;
      }
      case 'destroy':
        res.destroy();
        req.socket.destroy();
        break;
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    get hits(): number {
      return hits;
    },
    close: async (): Promise<void> => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
