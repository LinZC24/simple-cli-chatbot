# cli-chatbot

一个跑在终端里的多轮对话机器人。运行时依赖只有两个——`marked`（markdown 解析）与
`highlight.js`（代码高亮），两者的传递依赖都是 0；其余全用 `node` 内置模块。
用 TypeScript 写、`tsx` 直接跑、`vitest` 测。

它想证明的不是「能调通 API」，而是**一个 LLM CLI 该有的骨架**：分层清晰、错误分得清、
重试有边界、Ctrl-C 不会挂住终端。

```text
$ pnpm dev
cli-chatbot · model=gpt-4o-mini · base=https://api.openai.com/v1
历史上限 40 条 · 超时 30000 ms · 最大重试 3 次
输入 /help 查看命令，Ctrl-D 或 /exit 退出。

you> 9.11 和 9.9 哪个大？
think> 先比整数部分，都是 9……
       再看小数位：11 vs 9，所以 0.11 > 0.9
bot> 9.9 更大。
you> 我刚让你记的数字加 8 是多少？
bot> 50。
```

思维链是流式的：`think>` 那几行随模型吐字逐行出现（终端里是暗色），正文紧跟着 `bot>` 逐字出来。
不想要就 `/think off`，退回整包请求、一次给出回答。

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
| `/think on`、`/think off` | 开关思维链实时显示（默认开）；不带参数打印当前状态 |
| `/md on`、`/md off` | 开关 markdown 渲染（终端里默认开、管道里默认关）；不带参数打印当前状态 |
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

## 思维链

请求带 `stream: true`，把 SSE 的 `delta` 分成两类上报：`reasoning_content`（思维链）
与 `content`（回答）。渲染层据此写两种行：

```text
think> 先比整数部分，都是 9……
       再看小数位：11 vs 9，所以 0.11 > 0.9
bot> 9.9 更大。
```

- 思维链行是暗色的（`\u001b[2m`），**只在真终端里上色**——重定向到文件时 ANSI 序列只会是噪音。
- 续行按 `think> `（7 列）缩进，换行之后仍然看得出哪几行是思考。
- 模型从思考切到回答时自动换行加 `bot> `，正文逐字流出来，不用等整段生成完。
- `/think off` 之后不再传 `onDelta`，客户端自动退回整包 JSON 请求，回答一次给出。
- 模型不返回思维链时（普通模型、或服务端不带 `reasoning_content`），终端里只提示一次，
  免得每回合都刷一行；管道/重定向下不提示。
- 支持两种字段名：DeepSeek 的 `reasoning_content`、以及部分服务的 `reasoning`。

思维链**不进历史**：`AssistantMessage.reasoning` 只给渲染层看，写进 `messages` 的永远只有 `content`。
理由很实际——推理过程对下一轮没有价值，却会成倍放大 token 账单与上下文长度。

## markdown 渲染

模型吐的正文默认按 markdown 渲染（真终端里才开，管道/重定向默认关，`/md on|off` 可改）：

```text
bot> 结论
     • 行内标记等整行
     • 表格等整张
     ┌─ ts
     │ const a = 1;
     └─
     ┌──────┬────┐
     │ 名称 │ 值 │
     ├──────┼────┤
     │ 甲   │  1 │
     └──────┴────┘
```

- 解析交给 `marked`（`Lexer.lex`），渲染自己写：标题/粗体/斜体/删除线/行内代码/列表/引用/分隔线/
  链接/代码块 + 语法高亮/表格（方框 + 左右居中对齐，CJK 按两列算宽度）。
- **流式是逐行渲染的**：一行攒齐才上色，所以不会看到半截 `**粗`；代码块体内逐行就吐（否则就不「流」了）；
  表格必须等整张表结束（列宽是所有行算出来的）；`finish()` 兜住残行、残表、没闭合的代码块。
- 思维链（`think>`）**不渲染**：那是模型的草稿，里面常有半截标记，原样流式更好读。
- 宽度取终端列数，太窄时抬到 20 列；纯文本模式不画方框、只缩进（`> chat.log` 之后还能 diff）。

## 分层

| 位置 | 职责 | 不许做 |
| --- | --- | --- |
| `src/config.ts:1` | 把 `process.env` 变成校验过的 `AppConfig` | 读文件、抛非 `ConfigError` |
| `src/config-store.ts:1` | 会话内配置的当前值：`get` / `set` / `reset` / `modifiedKeys` | 写 `.env`、碰终端 |
| `src/env-file.ts:1` | 把改动写回 `.env`（纯函数合并 + 备份） | 决定该写哪些键 |
| `src/http/errors.ts:1` | 错误分类（可重试 / 不可重试） | 造文案、打日志 |
| `src/http/retry.ts:1` | 纯函数 `decide(error, attemptsMade, opts)` | 真的 sleep |
| `src/http/transport.ts:1` | 唯一调 `fetch` 的地方：整包 `postJson`、流式 `postSse`、超时（流式是空闲超时）、重试循环 | 知道 LLM 协议的形状 |
| `src/llm/sse.ts:1` | 纯函数式 SSE 解析：`data:` 成帧、`[DONE]` 哨兵、跨块拼接 | 碰网络、判断协议字段 |
| `src/markdown/ansi.ts:1` | ANSI 上色与显示宽度（CJK/emoji 算两列）、按宽度截断与补齐 | 知道 markdown 语法 |
| `src/markdown/highlight.ts:1` | `highlight.js` 的 HTML → ANSI（span 栈 + 实体解码） | 排版、缩进 |
| `src/markdown/render.ts:1` | markdown → 终端文本：块级、行内、表格、代码块方框 | 读写流、碰终端 |
| `src/markdown/stream.ts:1` | 按行缓冲的流式渲染：围栏状态机、表格攒块 | 决定某个 token 怎么排版 |
| `src/llm/llm-client.ts:1` | 唯一知道 `choices[0].message.content` 的地方：拼请求、校验响应、聚合流 | 重试、管历史、打印 |
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
pnpm test                             # 18 个文件 537 条
pnpm test:watch
grep -rn ': any\b' src/               # 无输出
grep -rn ' as [A-Z]' src/             # 只有 src/http/transport.ts:222 的 JSON.parse 边界
```

测试分三层：L1 纯函数（`retry` / `render` / `sse` / `session` 的裁剪逻辑）、L2 `vi.stubGlobal('fetch')`
打桩（状态码映射、重试次数、超时、流式逐块产出与中途断流）、L3 真 socket（`node:http` 在 `listen(0)` 随机端口起假服务器，
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

录像里有两幕：第一幕三轮对话，第一轮先吃一个 `429`（`Retry-After: 1`）再成功，
每轮的 `think>` 与 `bot>` 都是服务端逐块吐出来的（假服务器走 SSE）；第二幕服务器不响应，
请求在飞时按 Ctrl-C，退出码 `130`、耗时约 300ms。

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

12. **流式一旦开始就不能重试，断流只能报错。** 重试的语义是「这次请求白做了，再来一次」，
    可已经打到屏幕上的字收不回来——重放会把同样的内容再输出一遍。所以 `postSse` 的重试只覆盖到
    「拿到响应头」为止（429 / 5xx / 连不上照旧重试），正文一旦开始，中途断流就抛 `NetworkError`。
    同理，`timeoutMs` 在流式下变成**空闲超时**（两块数据之间允许的最长间隔），而不是整个响应体的总时长，
    否则一次长回答必然被自己的超时掐掉。

13. **`stream: true` 之后要假设对面可能不听话。** 三种现实情况都得兜住：① 服务端（或中间的代理）
    无视 `stream: true` 直接回整包 JSON —— 按 `content-type` 认出来，包成一帧 SSE 喂给同一个解析器，
    上层不必为「到底有没有流」分叉；`content-type` 缺失时仍按 SSE 处理（请求里已经明确要了流）。
    ② 收尾靠 `data: [DONE]` 哨兵，不能指望服务端一定关连接。③ 思维链字段名不统一
    （`reasoning_content` / `reasoning`），`null` 当没给、非字符串则报形状错误——静默忽略只会让
    「回答被吞了」变成查不出来的 bug。

14. **`marked` 的 `Token` 是联合类型，但 `switch (token.type)` 收不窄。**
    因为 `Token = MarkedToken | Tokens.Generic`，而 `Generic` 带 `[index: string]: any` 索引签名，
    `case 'heading'` 分支里的 `token.depth` 依然是 `unknown` 级别。项目没注册任何扩展，
    `Generic` 永远不会出现，所以先过一道白名单 `isMarkedToken()` 把类型收窄——比在 22 处塞
    `as Tokens.Heading` 诚实得多，而且只需要 1 个判断。

15. **`highlight.js` 的子路径没有类型声明。** `highlight.js/lib/languages/typescript` 之类的导入
    在 `strict` 下直接 TS7016（只有主包和 `lib/common` 有 types 条件）。所以用
    `import hljs from 'highlight.js/lib/common'`：37 种常用语言一次带上，代价是体积而不是可维护性。
    它吐的是 HTML（`<span class="hljs-keyword">`），还得过一道 30 行的扫描器：维护一个 **span 栈**
    （`hljs-string` 里套 `hljs-subst`，内层关闭必须把外层重新打开，否则后面几个字符就掉色）
    并解码 `&quot;` `&#x27;` 这类实体——颜色错了只是难看，标签或实体漏到屏幕上就是事故。

16. **任务列表的 `[x]` 已经被 `marked` 摘走了。** `list_item.task/text` 里只剩正文（`done`），
    勾选状态在 `item.checked`，而 `item.tokens` 里多了一个 `checkbox` token（它的 `raw` 就是 `[x]`）。
    最初按「正文开头是 `[x] `」去识别，结果正文里本没有它，于是复选框丢了、还凭空多出一行 `[x]`。

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
    types.ts              消息 / 请求 / 响应 / 增量类型
    sse.ts                SSE 解析（纯函数）
    llm-client.ts         拼请求、校验响应、聚合流
  markdown/
    ansi.ts               ANSI + 显示宽度（CJK 两列）
    highlight.ts          highlight.js 的 HTML → ANSI
    render.ts             markdown → 终端文本
    stream.ts             按行缓冲的流式渲染
  session/
    chat-session.ts       历史、事务提交、裁剪
  cli/
    render.ts             文案
    repl.ts               readline、斜杠命令、信号
test/                     L1 + L2 + L3，537 条
scripts/record-demo.mjs   生成 demo.cast
```

引入 `marked` 与 `highlight.js` 这两个依赖的代价，是 `dependencies` 不再为空 —— 换来的是
「不自己写 markdown 解析器」：`marked` 的传递依赖是 0，`highlight.js` 也是 0，两者加起来仍然
没有「依赖树」。真正的零依赖替代品（`markdansi` 等）要么 `engines` 要求 node>=22，要么周下载量两位数，
要么 GPL —— 自己写解析器的风险比多两个包大得多。

严格模式全开着（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
`verbatimModuleSyntax`），也没有 `any` 可以退回去 —— 所有边界都得写成显式的类型守卫。
