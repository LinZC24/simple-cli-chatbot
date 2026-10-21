/**
 * L1：渲染层是纯函数，全部断言到字符串内容。
 *
 * 断言口径来自 docs/03-interfaces.md §8（扩展名前缀 + stderr + `!` 开头）
 * 与 docs/04-roadmap.md 的验收项（错误文案必须含状态码与响应体前 200 字符）。
 */

import { describe, expect, it } from 'vitest';
import {
  ABORT_NOTICE,
  ASSISTANT_PREFIX,
  ERROR_PREFIX,
  HISTORY_PREVIEW_LIMIT,
  NO_REASONING_HINT,
  THINK_INDENT,
  THINK_PREFIX,
  TRUNCATED_HINT,
  createReplyStream,
  renderBanner,
  renderError,
  renderHelp,
  renderHistory,
  renderReply,
  renderResetDone,
  renderSystemUpdated,
  renderSystemUsage,
  renderUnknownCommand,
  renderUsage,
  preview,
} from '../src/cli/render.js';
import { loadConfig } from '../src/config.js';
import {
  AuthError,
  BadRequestError,
  ConfigError,
  NetworkError,
  RateLimitError,
  ResponseShapeError,
  ServerError,
  TimeoutError,
  UserAbortError,
} from '../src/http/errors.js';
import type { AssistantMessage } from '../src/llm/types.js';
import type { TurnResult } from '../src/session/chat-session.js';

const assistant: AssistantMessage = { role: 'assistant', content: '好的', finishReason: 'stop' };

const turn = (over: Partial<AssistantMessage> = {}): TurnResult => ({
  assistant: { ...assistant, ...over },
  turnIndex: 1,
  messageCount: 2,
});

const config = loadConfig({ LLM_API_KEY: 'sk-test' });

describe('renderReply', () => {
  it('助手回复带 bot> 前缀', () => {
    expect(renderReply(turn())).toBe(`${ASSISTANT_PREFIX}好的`);
  });

  it('finish_reason === length 时追加截断提示，但不是错误', () => {
    const text = renderReply(turn({ finishReason: 'length' }));

    expect(text.startsWith(`${ASSISTANT_PREFIX}好的`)).toBe(true);
    expect(text).toContain('截断');
    expect(text).toContain('LLM_MAX_TOKENS');
  });

  it('其他 finish_reason 不追加提示', () => {
    expect(renderReply(turn({ finishReason: 'stop' }))).not.toContain('截断');
    expect(renderReply(turn({ finishReason: 'unknown' }))).not.toContain('截断');
  });

  it('空 content 是合法的，渲染成占位文案而不是空行', () => {
    expect(renderReply(turn({ content: '' }))).toContain('空内容');
  });

  it('多行内容原样保留（不压平换行）', () => {
    expect(renderReply(turn({ content: '第一行\n第二行' }))).toBe(`${ASSISTANT_PREFIX}第一行\n第二行`);
  });
});

describe('renderError：前缀映射', () => {
  const cases: readonly [string, unknown][] = [
    ['配置错误', new ConfigError('LLM_API_KEY 未设置')],
    ['鉴权失败', new AuthError({ status: 401, statusText: 'Unauthorized', host: 'api.openai.com', body: '{"error":"bad key"}' })],
    ['请求被拒绝', new BadRequestError({ status: 400, statusText: 'Bad Request', host: 'api.openai.com' })],
    ['触发限流', new RateLimitError({ status: 429, statusText: 'Too Many Requests', retryAfterMs: 2_000 })],
    ['服务端错误', new ServerError({ status: 500, statusText: 'Internal Server Error' })],
    ['网络不可达', new NetworkError({ host: 'api.openai.com' })],
    ['请求超时', new TimeoutError({ timeoutMs: 30_000 })],
    ['响应格式异常', new ResponseShapeError('missing choices', { body: '{"x":1}' })],
  ];

  for (const [prefix, error] of cases) {
    it(`${prefix} 走 stderr、以 ! 开头`, () => {
      const rendered = renderError(error);

      expect(rendered.stream).toBe('stderr');
      expect(rendered.text.startsWith(`${ERROR_PREFIX}${prefix}: `)).toBe(true);
    });
  }

  it('错误正文仍带状态码（验收项：必须含状态码）', () => {
    const rendered = renderError(new AuthError({ status: 401, statusText: 'Unauthorized' }));

    expect(rendered.text).toContain('401');
  });

  it('响应体截断到 200 字符以内（验收项：必须含响应体前 200 字符）', () => {
    const rendered = renderError(new ServerError({ status: 500, body: 'A'.repeat(500) }));

    expect(rendered.text).toContain('A'.repeat(200));
    expect(rendered.text).not.toContain('A'.repeat(201));
  });

  it('响应格式异常带上响应体片段', () => {
    const rendered = renderError(new ResponseShapeError('missing choices', { body: '{"choices":[]}' }));

    expect(rendered.text).toContain('{"choices":[]}');
  });

  it('UserAbortError 只打印一行取消提示，不打印 ! 前缀', () => {
    const rendered = renderError(new UserAbortError());

    expect(rendered.stream).toBe('stderr');
    expect(rendered.text).toBe(ABORT_NOTICE);
    expect(rendered.text).not.toContain(ERROR_PREFIX);
  });

  it('非 AgentError 归一化成「未知错误」而不是崩溃', () => {
    expect(renderError(new Error('boom')).text).toBe(`${ERROR_PREFIX}未知错误: boom`);
    expect(renderError('字符串也会被兜住').text).toContain('字符串也会被兜住');
  });
});

describe('renderError：第二行提示', () => {
  it('鉴权失败提示检查 key 与端点是否匹配', () => {
    const text = renderError(new AuthError({ status: 401 })).text;

    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('LLM_API_KEY');
    expect(text).toContain('LLM_BASE_URL');
  });

  it('请求被拒绝提示检查模型名', () => {
    expect(renderError(new BadRequestError({ status: 404 })).text).toContain('LLM_MODEL');
  });

  it('限流/服务端错误/超时会带上重试轮数', () => {
    expect(renderError(new RateLimitError({ status: 429 }), { retries: 3 }).text).toContain('重试 3 次');
    expect(renderError(new ServerError({ status: 503 }), { retries: 2 }).text).toContain('重试 2 次');
    expect(renderError(new TimeoutError({ timeoutMs: 30_000 }), { retries: 3, timeoutMs: 30_000 }).text).toContain(
      '30000 ms',
    );
  });

  it('没给上下文时不编造数字', () => {
    const text = renderError(new ServerError({ status: 500 })).text;

    expect(text).toContain('重试 0 次');
  });

  it('网络错误提示检查代理与 baseUrl', () => {
    const text = renderError(new NetworkError()).text;

    expect(text).toContain('代理');
    expect(text).toContain('LLM_BASE_URL');
  });
});

describe('renderHistory', () => {
  it('空历史给出明确说明', () => {
    expect(renderHistory([])).toContain('历史为空');
  });

  it('打印条数 + 角色 + 前 60 字符', () => {
    const text = renderHistory([
      { role: 'user', content: 'u'.repeat(80) },
      { role: 'assistant', content: '短回答' },
    ]);
    const lines = text.split('\n');

    expect(text).toContain('历史 2 条');
    expect(lines[1]).toContain('user: ');
    expect(lines[1]).toContain(`${'u'.repeat(HISTORY_PREVIEW_LIMIT)}…`);
    expect(lines[1]).not.toContain('u'.repeat(HISTORY_PREVIEW_LIMIT + 1));
    expect(lines[2]).toContain('assistant: 短回答');
  });

  it('预览压平换行，避免多行内容把列表打散', () => {
    expect(renderHistory([{ role: 'assistant', content: '第一行\n第二行' }])).toContain('第一行 第二行');
  });
});

describe('其他回执', () => {
  it('banner 带模型、端点与三个上限', () => {
    const text = renderBanner(config);

    expect(text).toContain(`model=${config.model}`);
    expect(text).toContain(`base=${config.baseUrl}`);
    expect(text).toContain(`${config.maxHistoryMessages}`);
    expect(text).toContain('/help');
  });

  it('help 列出全部命令', () => {
    const text = renderHelp();

    for (const command of ['/exit', '/quit', '/reset', '/system', '/history', '/help']) {
      expect(text).toContain(command);
    }
  });

  it('reset 回执说明 system 仍在', () => {
    expect(renderResetDone()).toContain('system prompt 保留');
  });

  it('system 更新回执带上新文本并说明生效时机', () => {
    const text = renderSystemUpdated('你是一个翻译');

    expect(text).toContain('你是一个翻译');
    expect(text).toContain('下一轮');
  });

  it('system 无参数时给用法提示', () => {
    expect(renderSystemUsage()).toContain('用法');
  });

  it('未知命令提示 /help', () => {
    expect(renderUnknownCommand('/foo')).toBe('未知命令：/foo。输入 /help 查看可用命令。');
  });

  it('usage 行三个数字都在', () => {
    expect(renderUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })).toBe(
      '[usage] prompt=10 completion=5 total=15',
    );
  });
});

describe('preview', () => {
  it('短文本原样返回', () => {
    expect(preview('你好')).toBe('你好');
  });

  it('超长文本截断并加省略号', () => {
    expect(preview('a'.repeat(70), 10)).toBe(`${'a'.repeat(10)}…`);
  });

  it('压掉多余空白', () => {
    expect(preview('  多   空格\n换行  ')).toBe('多 空格 换行');
  });
});

// ---------------------------------------------------------------------------
// 流式渲染：`think>` 逐字、切行、收尾
// ---------------------------------------------------------------------------

describe('createReplyStream', () => {
  it('第一块思维链带 think> 前缀，续块直接接在后面', () => {
    const stream = createReplyStream({ color: false });

    expect(stream.push({ kind: 'reasoning', text: '先算 ' })).toBe(`${THINK_PREFIX}先算 `);
    expect(stream.push({ kind: 'reasoning', text: '两步' })).toBe('两步');
  });

  it('思维链到正文：先换行，再上 bot> 前缀', () => {
    const stream = createReplyStream({ color: false });
    stream.push({ kind: 'reasoning', text: '想好了' });

    expect(stream.push({ kind: 'content', text: '答案是 2' })).toBe(`\n${ASSISTANT_PREFIX}答案是 2`);
    expect(stream.push({ kind: 'content', text: '。' })).toBe('。');
  });

  it('没有思维链时正文照常从 bot> 开始（不多一个空行）', () => {
    const stream = createReplyStream({ color: false });

    expect(stream.push({ kind: 'content', text: '直接回答' })).toBe(`${ASSISTANT_PREFIX}直接回答`);
  });

  it('上色只在 color 为真时加 dim/reset，且不影响可读内容', () => {
    const plain = createReplyStream({ color: false });
    const colored = createReplyStream({ color: true });

    const plainText = plain.push({ kind: 'reasoning', text: '想法' });
    const coloredText = colored.push({ kind: 'reasoning', text: '想法' });

    expect(plainText).toBe(`${THINK_PREFIX}想法`);
    expect(coloredText).toContain('\u001b[2m');
    expect(coloredText).toContain('\u001b[0m');
    expect(coloredText).toContain(`${THINK_PREFIX}想法`);
  });

  it('思维链内部自带换行时，续行也补上缩进', () => {
    const stream = createReplyStream({ color: false });

    expect(stream.push({ kind: 'reasoning', text: '第一段\n第二段' })).toBe(
      `${THINK_PREFIX}第一段\n${THINK_INDENT}第二段`,
    );
  });

  it('续行按前缀宽度对齐（think> 共 7 列）', () => {
    expect(THINK_INDENT).toHaveLength(THINK_PREFIX.length);
    expect(THINK_PREFIX).toBe('think> ');
  });

  it('sawReasoning 记录本回合到底有没有思维链', () => {
    const without = createReplyStream({ color: false });
    without.push({ kind: 'content', text: 'x' });
    expect(without.sawReasoning).toBe(false);

    const withReasoning = createReplyStream({ color: false });
    withReasoning.push({ kind: 'reasoning', text: 'x' });
    expect(withReasoning.sawReasoning).toBe(true);
  });

  it('收尾只补一个换行（正文已经逐字写过了）', () => {
    const stream = createReplyStream({ color: false });
    stream.push({ kind: 'content', text: '好的' });

    expect(stream.finish(turn({ content: '好的' }))).toBe('\n');
  });

  it('只有思维链就被截断：补 bot> 空内容占位与截断提示', () => {
    const stream = createReplyStream({ color: false });
    stream.push({ kind: 'reasoning', text: '想了很久……' });

    const text = stream.finish(turn({ content: '', finishReason: 'length' }));

    expect(text).toBe(`\n${ASSISTANT_PREFIX}(模型返回了空内容)\n${TRUNCATED_HINT}\n`);
  });

  it('一个增量都没收到：把最终内容整行打出来', () => {
    const stream = createReplyStream({ color: false });

    expect(stream.finish(turn({ content: '迟到的回答' }))).toBe(`${ASSISTANT_PREFIX}迟到的回答\n`);
  });

  it('正文之后又来思维链（换模型的中间帧）：重开一个 think> 块', () => {
    const stream = createReplyStream({ color: false });
    stream.push({ kind: 'content', text: '一半' });

    expect(stream.push({ kind: 'reasoning', text: '再想想' })).toBe(`\n${THINK_PREFIX}再想想`);
  });

  it('NO_REASONING_HINT 讲清楚怎么关，且只提示一次由调用方控制', () => {
    expect(NO_REASONING_HINT).toContain('/think off');
  });
});
