# cli-chatbot

一个跑在终端里的多轮对话机器人。除了 `node` 内置模块，运行时**零依赖**（`dependencies` 是空对象），
用 TypeScript 写、`tsx` 直接跑、`vitest` 测。

它想证明的不是「能调通 API」，而是**一个 LLM CLI 该有的骨架**：分层清晰、错误分得清、
重试有边界、Ctrl-C 不会挂住终端。

```text
$ pnpm dev
cli-chatbot · model=gpt-4o-mini · base=https://api.openai.com/v1
历史上限 40 条 · 超时 30000 ms · 最大重试 3 次
输入 /help 查看命令，Ctrl-D 或 /exit 退出。

you> 记住数字 42
bot> 好，记住了。
you> 我刚让你记的数字加 8 是多少？
bot> 50。
```

## 快速开始

```bash
pnpm install
cp .env.example .env      # 填上 LLM_API_KEY，其余可用默认值
pnpm dev                  # 等同 pnpm start
```

只需要一个变量就能跑：`LLM_API_KEY`。端点、模型、system prompt、超时、重试次数都有默认值，
`LLM_BASE_URL` 指向任何 OpenAI 兼容服务即可（OpenAI / DeepSeek / Ollama 见 `.env.example`）。

## 命令

| 输入 | 行为 |
| --- | --- |
| 普通文本 | 发一回合，成功才写进历史 |
| `/exit`、`/quit`、Ctrl-D | 退出，退出码 `0` |
| `/reset` | 清空历史，system prompt 保留 |
| `/system <文本>` | 换 system prompt（不回显历史，也不改动已有历史） |
| `/history` | 打印条数 + 每条角色和前 60 字 |
| `/config` | 列出可改项（编号菜单），回车取消 |
| `/config set <键> <值>` | 一行直达；值写 `-` 恢复默认 |
| `/config reset` | 恢复启动时的配置（本次会话内） |
| `/config save` | 把改动写回 `.env`（原文件备份为 `.env.bak`） |
| `/help` | 命令列表 |
| 空行 | 忽略 |
| 退格 / 方向键 / ↑ / Ctrl-C | 交互模式的编辑键由 readline 处理；↑ 翻回上一句，Tab 补全已关掉 |
| Ctrl-C | 第一次取消当前回合后退出 `130`，再按一次立刻退出 |

正文走 stdout，错误走 stderr（`! 错误前缀: 详情`），所以 `pnpm dev > chat.log` 里不会混进报错。

### `/config` 能改什么

| 项 | 说明 |
| --- | --- |
| `model` | 换模型，下一回合生效 |
| `systemPrompt` | 换 system prompt，同时同步给会话层 |
| `maxTokens` | `-` 表示不发送该字段 |
| `temperature` | 0~2，`-` 表示不发送该字段 |

改完只活在本次会话里，想让下次启动也带上就 `/config save`：它会**只**把改动过的项写回 `.env`（先备份 `.env.bak`，带空格或 `#` 的值自动加引号）。
`apiKey`、`baseUrl`、`timeoutMs`、`maxRetries`、`maxHistoryMessages`、`logLevel` 故意不给改：
它们在进程启动时就被交给传输层了，运行时改只会让人以为改了。它们在表格里显示成一行只读汇总，
`apiKey` 连片段都不露（只显示“已设置 / 未设置”）。

## 分层

| 位置 | 职责 | 不许做 |
| --- | --- | --- |
| `src/config.ts:1` | 把 `process.env` 变成校验过的 `AppConfig` | 读文件、抛非 `ConfigError` |
| `src/config-store.ts:1` | 会话内配置的当前值：`get` / `set` / `reset` / `modifiedKeys` | 写 `.env`、碰终端 |
| `src/env-file.ts:1` | 把改动写回 `.env`（纯函数合并 + 备份） | 决定该写哪些键 |
| `src/http/errors.ts:1` | 错误分类（可重试 / 不可重试） | 造文案、打日志 |
| `src/http/retry.ts:1` | 纯函数 `decide(error, attemptsMade, opts)` | 真的 sleep |
| `src/http/transport.ts:1` | 唯一调 `fetch` 的地方：超时、重试循环、状态码映射 | 知道 LLM 协议的形状 |
| `src/llm/llm-client.ts:1` | 唯一知道 `choices[0].message.content` 的地方：拼请求、校验响应 | 重试、管历史、打印 |
| `src/session/chat-session.ts:1` | 唯一改 `messages` 的地方：回合事务、裁剪历史 | 碰网络、碰终端 |
| `src/cli/render.ts:1` | 纯函数出文案：前缀、错误文案、截断提示 | 判断错误该怎么处理 |
| `src/cli/repl.ts:1` | 读行、解析斜杠命令、菜单状态机、信号与退出码 | 组装请求、解析响应 |
| `src/index.ts:1` | 装配：config → transport → client → session → repl | 写字面量文案 |

两条硬规则贯穿全项目：**`fetch` 只出现在传输层**，**`messages` 只在会话层被改**。
会话的提交是事务式的——`await chat(...)` 成功之后才把 user/assistant 一起 push，
所以失败回合不会在历史里留下半截对话。

## 错误分类

| 错误 | 用户看到的 | 重试 |
| --- | --- | --- |
| `ConfigError` | `! 配置错误: ...` | 否 |
| `AuthError`（401/403） | `! 鉴权失败: 401 Unauthorized — ...` | **否**，请求只发一次 |
| `BadRequestError`（4xx 其他） | `! 请求被拒绝: ...` | 否 |
| `RateLimitError`（429） | `! 触发限流: ...` | 是，优先按 `Retry-After` |
| `ServerError`（5xx） | `! 服务端错误: ...` | 是，指数退避 + jitter |
| `NetworkError` | `! 网络不可达: ...` | 是 |
| `TimeoutError` | `! 请求超时: ...` | 是 |
| `ResponseShapeError` | `! 响应格式异常: ...` | 否（再问一次也是这个形状） |
| `UserAbortError` | `^C 已取消本次回合` | 否 |

`finish_reason === 'length'` 不是错误，只在回复末尾追加一句截断提示。

## 验证

```bash
pnpm typecheck                        # exit 0
pnpm test                             # 12 个文件 340 条
pnpm test:watch
grep -rn ': any\b' src/               # 无输出
grep -rn ' as [A-Z]' src/             # 只有 src/http/transport.ts:210 的 JSON.parse 边界
```

测试分三层：L1 纯函数（`retry` / `render` / `session` 的裁剪逻辑）、L2 `vi.stubGlobal('fetch')`
打桩（状态码映射、重试次数、超时）、L3 真 socket（`node:http` 在 `listen(0)` 随机端口起假服务器，
覆盖 hang→超时、连接被掐断、真 SIGINT 进程退出码）。`scripts/record-demo.mjs` 也是 L3 的一种。

## 验收对照

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 三轮上下文连贯 | ✅ | `demo.cast` 里 system 之外的条数 2 → 4 → 6；`test/session.test.ts` |
| 500 能重试恢复 | ✅ | `test/transport.test.ts`（500×2 后 200，`hits === 3`） |
| 401 立刻报错不重试 | ✅ | `test/transport.test.ts`（`hits === 1`，抛 `AuthError`） |
| 超时可打断 | ✅ | `test/transport.test.ts`（hang 服务器 → `TimeoutError`）；在飞时 Ctrl-C 见 `test/cli-process.test.ts` |
| Ctrl-C 退出码 130，无残留句柄 | ✅ | `test/cli-process.test.ts`（< 3s 退出）；`src/index.ts:1` 只设 `process.exitCode`，让残留句柄能暴露 |
| 429 + `Retry-After: 1` 等满 1s | ✅ | `demo.cast` 第 1.6s 的重试日志；`test/retry.test.ts` |
| `tsc --noEmit` 零报错零 `any` | ✅ | `pnpm typecheck` + 上面两条 grep |
| README + demo | ✅ | 本文件 + `demo.cast` |

## demo.cast

```bash
asciinema play demo.cast      # 需要 asciinema，本机没装也没关系——它是纯文本 JSONL
node scripts/record-demo.mjs  # 重新生成（会覆盖）
```

录像里有两幕：第一幕三轮对话，第一轮先吃一个 `429`（`Retry-After: 1`）再成功；
第二幕服务器不响应，请求在飞时按 Ctrl-C，退出码 `130`、耗时约 300ms。

因为这台机器没有 `asciinema`，`scripts/record-demo.mjs` 是**真的把 CLI 跑起来**、
按真实时间戳收 stdout/stderr，再写成 asciinema v2 格式——内容是程序自己产的，
脚本只安排「谁在什么时候按了什么键」。`asciinema play demo.cast` 能直接回放。

## 踩过的坑

1. **`rl.question()` 在 stdin 结束后永不 settle。** 用它做循环，Ctrl-D 之后 `await` 会一直挂着，
   `node` 以退出码 `13`（unsettled top-level await）结束。改成 `for await (const line of rl)` 之后，
   流结束就是循环结束，提示符自己 `output.write('you> ')` 打印。

2. **退格到底由谁擦，取决于 `terminal`——这是真机上「退格删不掉字」的根因。** `terminal: false` 把擦除
   交给内核的行规程（cooked 模式），只有在 cooked 的 pty 里才灵；可 stdin 是 cooked 还是 raw 由**父进程**决定，
   在 raw 的 pty 里（终端复用器、IDE 任务、`script` 之类）`\x7f` 会原样送进程序，退格变成「删不掉」，
   控制字符还会跟着正文一起发给模型。现在两边都是 TTY 就 `terminal: true`，由 readline 自己解析按键
   （退格 / 方向键 / Ctrl-C 都变成它的事件），不再依赖终端模式。代价是 Ctrl-C 不再是进程信号，`process.on`
   和 `rl.on('SIGINT')` 两处都要接；管道与测试里仍然关掉 terminal，并自己回显一遍输入。

3. **`Date.parse()` 比想象中宽容得多。** `Retry-After: 1.5` 或 `-1` 会被 V8 解析成一个具体日期，
   算出「已经过去了」再 `max(0, ...)` 得到 `0`，于是非法的 `Retry-After` 被当成「立刻重试」，
   反而更凶地打服务端。现在先用 `/^\+?\d+$/`（delta-seconds）和 `/\d{1,2}:\d{2}/`（HTTP-date 一定含 `HH:MM`）
   两道正则筛，通过了才 `Date.parse`。

4. **`exactOptionalPropertyTypes` 下「可选字段」不能赋 `undefined`。** `{ temperature: config.temperature }`
   在 `temperature` 未配置时直接编译失败（`undefined` 不是 `number`）。正确写法是
   `...(v === undefined ? {} : { temperature: v })`——顺带保证了「用户没配就不发这个字段」，
   而不是发一个 `null` 让服务端猜。

5. **`noUncheckedIndexedAccess` 让 `choices[0]` 变成 `T | undefined`。** 想拿 `content` 就得先证明存在。
   把响应类型声明成 `readonly [Choice, ...unknown[]]` 能把「至少一条」编码进类型，但那是**别人**的 JSON，
   运行时还是得老老实实 `Array.isArray(choices) && choices.length > 0`。

6. **SIGINT 之后必须「先 abort 再等」，顺序反了终端会卡满 1 秒。** 先 `rl.close()` 再取消，
   用户看到的是「按了 Ctrl-C 但没反应」。现在是一次 abort → 关行 → `Promise.race([回合 settle, 1s 定时器])` → exit(130)。
   退避等待的 `sleep` 也必须接 `AbortSignal`，否则 Ctrl-C 之后还要等完 8 秒退避才肯退出。

7. **`pnpm test` 通过不等于没有残留句柄。** `src/index.ts:1` 刻意不调 `process.exit(0)`，只设 `process.exitCode`：
   如果哪里漏了 `clearTimeout` 或没 `rl.close()`，进程会挂住不退——这是让 L3 测试替用户发现它的办法。

8. **写录像脚本时「只推时间轴、不真等待」会把时间戳压扁。** 脚本先 `advance(1.2)` 再读程序输出时，
   程序其实还在等那 1 秒的重试，真实输出的时间戳全被 `Math.max(clock, at)` 夹到同一刻，
   `Retry-After: 1` 在录像里变成 140ms。改成真 `sleep` + 「会话开始时刻 + 真实经过时间」算绝对时间才如实。

9. **`Object.freeze` 的配置改不动，所以「改配置」必须靠换对象 + 现取。** `createLlmClient` 一开始把
   `config` 捕获进闭包、连 `url` 都算好了，`/config` 改完一点反应都没有。改成传「读取器」
   `config: () => AppConfig`（每次请求现取一次），存储层 `src/config-store.ts:1` 负责换成新对象，
   改 `model` / `maxTokens` 才对下一回合生效。同一个坑还有第二半：`systemPrompt` 存在会话层自己手里，
   改配置时必须顺手 `setSystemPrompt`，否则又是不生效。

10. **能改的东西少一点，比“什么都能改”更好用。** `apiKey` 不给改（只露「已设置 / 未设置」），
    `baseUrl` / `timeoutMs` / `maxRetries` 也不给改：它们在启动时已经交给传输层了。
    花在“运行时改传输入参”上的代码量会远大于它的价值，而用户只需要重启。

11. **开了 `terminal: true`，提示符就不能用 `output.write()` 画。** readline 需要知道提示符的长度，
    才能在退格 / 方向键之后把整行重绘到正确位置；自己 `write()` 出去的那一行它根本不知道，
    编辑时就会出现「提示符被擦掉」「光标错位」。必须 `rl.setPrompt(text); rl.prompt()`，
    取值提示（`/config` 里等新值那一行）同样如此。顺带白拿两个交互细节：`historySize` 让 ↑ 能翻回上一句，
    `completer` 返回空数组把 Tab 补全关掉——聊天框里蹦出一串 JS 标识符候选纯属碍事。

## 目录

```text
src/
  index.ts                装配 + 退出码
  config.ts               env → AppConfig（纯函数）
  config-store.ts         会话内配置当前值（/config 的真相）
  env-file.ts             改动写回 .env（合并 + 备份）
  http/
    errors.ts             错误体系：可重试 / 不可重试
    retry.ts              重试决策（纯函数）
    transport.ts          唯一调 fetch 的地方
  llm/
    types.ts              消息 / 请求 / 响应类型
    llm-client.ts         拼请求、校验响应
  session/
    chat-session.ts       历史、事务提交、裁剪
  cli/
    render.ts             文案
    repl.ts               readline、斜杠命令、信号
test/                     L1 + L2 + L3，340 条
scripts/record-demo.mjs   生成 demo.cast
```

零依赖的一个副作用是：`tsconfig.json` 里的 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
`verbatimModuleSyntax` 全开着，也没有 `any` 可以退回去——所有边界都得写成显式的类型守卫。
