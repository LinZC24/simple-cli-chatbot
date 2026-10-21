/**
 * L1：流式 markdown 渲染器。
 *
 * 这里最值得钉住的不是「好看」，而是**什么时候能吐字**：
 * - 行内标记要等这一行结束才上色（否则会看到半截 `**粗`）；
 * - 代码块体内逐行就吐（不然「流式」就没了）；
 * - 表格必须等整张表结束（列宽靠所有行算出来）；
 * - `finish()` 不能丢残行、残表、没闭合的代码块。
 */

import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/markdown/ansi.js';
import { createMarkdownOptions } from '../src/markdown/render.js';
import { createMarkdownStream } from '../src/markdown/stream.js';

const plain = createMarkdownOptions({ width: 60 });
const color = createMarkdownOptions({ width: 60, color: true });

/** 按给定的增量序列（模拟 SSE 切块）跑完一个流，返回全部输出。 */
function feed(chunks: readonly string[], options = plain): string {
  const stream = createMarkdownStream(options);
  let out = '';
  for (const chunk of chunks) {
    out += stream.push(chunk);
  }
  return `${out}${stream.finish()}`;
}

describe('按行缓冲', () => {
  it('没见到换行就什么都不吐', () => {
    const stream = createMarkdownStream(plain);
    expect(stream.push('hello')).toBe('');
    expect(stream.push(' world')).toBe('');
    expect(stream.push('\n')).toBe('hello world\n');
  });

  it('一行一个增量时逐个吐', () => {
    expect(feed(['a\n', 'b\n'])).toBe('a\nb\n');
  });

  it('空行也吐一个换行（段落之间要空开）', () => {
    expect(feed(['a\n', '\n', 'b\n'])).toBe('a\n\nb\n');
  });

  it('行内标记跨增量也能正确上色', () => {
    expect(feed(['这是 **粗', '体** 文字\n'])).toBe('这是 粗体 文字\n');
  });

  it('CRLF 不留下 \\r', () => {
    expect(feed(['a\r\n', 'b\r\n'])).toBe('a\nb\n');
  });
});

describe('围栏代码块', () => {
  it('纯文本模式：语言单独一行，体内逐行输出', () => {
    const out = feed(['```ts\n', 'const a = 1;\n', '```\n']);
    expect(out).toBe('  [ts]\n  const a = 1;\n');
  });

  it('上色模式：开围栏立刻画顶边，体内逐行吐，闭合画底边', () => {
    const stream = createMarkdownStream(color);
    expect(stripAnsi(stream.push('```ts\n'))).toBe('┌─ ts\n');
    expect(stripAnsi(stream.push('const a = 1;\n'))).toBe('│ const a = 1;\n');
    expect(stripAnsi(stream.push('```\n'))).toBe('└─\n');
    expect(stream.finish()).toBe('');
  });

  it('代码里的 markdown 标记不被当格式解析', () => {
    expect(feed(['```\n', '**不是粗体**\n', '```\n'])).toBe('  **不是粗体**\n');
  });

  it('代码里的 ``` 出现在行中不结束代码块', () => {
    expect(feed(['```\n', 'a ``` b\n', '```\n'])).toBe('  a ``` b\n');
  });

  it('没闭合的代码块在收尾时补底边', () => {
    const out = feed(['```ts\n', 'x\n'], color);
    expect(stripAnsi(out)).toBe('┌─ ts\n│ x\n└─\n');
  });
});

describe('表格', () => {
  const chunks = ['| a | b |\n', '| - | - |\n', '| 1 | 2 |\n'];

  it('整张表攒齐之后才吐（列宽要算所有行）', () => {
    const stream = createMarkdownStream(plain);
    expect(stream.push(chunks[0] ?? '')).toBe('');
    expect(stream.push(chunks[1] ?? '')).toBe('');
    expect(stream.push(chunks[2] ?? '')).toBe('');
    expect(stripAnsi(stream.push('收尾文字\n'))).toBe(
      ['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘', '收尾文字', ''].join('\n'),
    );
  });

  it('表格正好在流末尾结束时由 finish 吐出', () => {
    const out = feed(chunks);
    expect(stripAnsi(out)).toBe(
      ['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘', ''].join('\n'),
    );
  });
});

describe('收尾', () => {
  it('残行在 finish 时渲染（不丢内容）', () => {
    expect(feed(['没有换行的结尾'])).toBe('没有换行的结尾\n');
  });

  it('残行里的行内标记也会解析', () => {
    expect(feed(['结尾 **粗**'])).toBe('结尾 粗\n');
  });

  it('代码块里的残行按代码行输出', () => {
    expect(stripAnsi(feed(['```\nx = 1'], color))).toBe('┌─\n│ x = 1\n└─\n');
  });

  it('finish 之后状态复位，可以安全地再 push', () => {
    const stream = createMarkdownStream(plain);
    stream.push('```ts\n');
    stream.push('x\n');
    stream.finish();
    expect(stream.push('收尾\n')).toBe('收尾\n');
  });

  it('重复 finish 不会重复吐内容', () => {
    const stream = createMarkdownStream(plain);
    stream.push('a\n');
    stream.finish();
    expect(stream.finish()).toBe('');
  });
});
