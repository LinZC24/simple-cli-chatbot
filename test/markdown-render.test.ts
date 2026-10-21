/**
 * L1：markdown → 终端文本。
 *
 * 断言用「去色后的可见文本」为主（`stripAnsi`），因为对齐/缩进这类错位一眼能看出来，
 * 而颜色只挑几个稳定的码点验一下。纯文本模式（`color: false`）要能逐字 diff，
 * 所以它必须是完全确定的输出。
 */

import { describe, expect, it } from 'vitest';
import { SGR, stripAnsi } from '../src/markdown/ansi.js';
import {
  MIN_WIDTH,
  createMarkdownOptions,
  fenceOf,
  looksLikeTableRow,
  renderInline,
  renderLine,
  renderMarkdown,
  resolveWidth,
} from '../src/markdown/render.js';

const plain = createMarkdownOptions({ width: 60 });
const color = createMarkdownOptions({ width: 60, color: true });

function visible(source: string, options = plain): string {
  return stripAnsi(renderMarkdown(source, options));
}

describe('resolveWidth', () => {
  it('拿不到终端宽度时用默认 80', () => {
    expect(resolveWidth(undefined)).toBe(80);
  });

  it('拒绝非正数', () => {
    expect(resolveWidth(0)).toBe(80);
    expect(resolveWidth(-1)).toBe(80);
  });

  it('太窄时抬到下限', () => {
    expect(resolveWidth(10)).toBe(MIN_WIDTH);
  });

  it('正常宽度直接采用', () => {
    expect(resolveWidth(120)).toBe(120);
  });
});

describe('createMarkdownOptions', () => {
  it('默认不上色、不高亮', () => {
    expect(createMarkdownOptions()).toEqual({ width: 80, color: false, highlight: false });
  });

  it('上色时默认连高亮一起开', () => {
    expect(createMarkdownOptions({ color: true })).toEqual({ width: 80, color: true, highlight: true });
  });

  it('显式关掉高亮时听调用方的', () => {
    expect(createMarkdownOptions({ color: true, highlight: false }).highlight).toBe(false);
  });
});

describe('fenceOf / looksLikeTableRow', () => {
  it.each([
    ['```ts', { close: false, language: 'ts' }],
    ['~~~ py', { close: false, language: 'py' }],
    ['```', { close: false, language: '' }],
    ['   ``` js title', { close: false, language: 'js' }],
  ])('%s 是围栏边界', (line, expected) => {
    expect(fenceOf(line)).toEqual(expected);
  });

  it('普通文本不是围栏边界', () => {
    expect(fenceOf('text')).toBeUndefined();
  });

  it('两端带竖线的行算表格行', () => {
    expect(looksLikeTableRow('| a | b |')).toBe(true);
    expect(looksLikeTableRow('a | b |')).toBe(true);
  });

  it('中间的竖线不算表格', () => {
    expect(looksLikeTableRow('a | b')).toBe(false);
  });
});

describe('renderInline', () => {
  it('行内标记只保留内容', () => {
    expect(renderInline('**粗** *斜* `码` ~~删~~', plain)).toBe('粗 斜 码 删');
  });

  it('文字与地址不同时把地址补在括号里', () => {
    expect(renderInline('[链接](https://x.y)', plain)).toBe('链接 (https://x.y)');
  });

  it('文字就是地址时不再重复一遍', () => {
    expect(renderInline('[https://x.y](https://x.y)', plain)).toBe('https://x.y');
  });

  it('图片降级成描述 + 地址', () => {
    expect(renderInline('![截图](https://x.y/a.png)', plain)).toBe('[图片: 截图] https://x.y/a.png');
  });

  it('转义字符还原', () => {
    expect(renderInline('\\*不是斜体\\*', plain)).toBe('*不是斜体*');
  });
});

describe('renderMarkdown 块级', () => {
  it('标题只留文字，行内标记照样解析', () => {
    expect(visible('# 标题 **粗**')).toBe('标题 粗');
  });

  it('setext 标题也认', () => {
    expect(visible('标题\n===')).toBe('标题');
  });

  it('段落按行拼起来', () => {
    expect(visible('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('无序列表用圆点，嵌套多缩进两格', () => {
    expect(visible('- a\n- b\n  - b1')).toBe('• a\n• b\n  • b1');
  });

  it('有序列表保留序号', () => {
    expect(visible('1. one\n2. two')).toBe('1. one\n2. two');
  });

  it('有序列表尊重起始序号', () => {
    expect(visible('3. three\n4. four')).toBe('3. three\n4. four');
  });

  it('任务列表显示勾选框', () => {
    expect(visible('- [x] done\n- [ ] todo')).toBe('• ☑ done\n• ☐ todo');
  });

  it('引用加竖线前缀', () => {
    expect(visible('> 引用\n> 第二行')).toBe('│ 引用\n│ 第二行');
  });

  it('分隔线铺满可用宽度', () => {
    expect(visible('---')).toBe('─'.repeat(60));
  });

  it('HTML 原样保留', () => {
    expect(visible('<br>')).toBe('<br>');
  });
});

describe('renderMarkdown 代码块', () => {
  it('纯文本模式只缩进，语言单独一行', () => {
    expect(visible('```ts\nconst a = 1;\n```')).toBe('  [ts]\n  const a = 1;');
  });

  it('没有语言就不写标题行', () => {
    expect(visible('```\nx\n```')).toBe('  x');
  });

  it('上色时画方框并标出语言', () => {
    const out = stripAnsi(renderMarkdown('```ts\nconst a = 1;\n```', color));
    expect(out).toBe('┌─ ts\n│ const a = 1;\n└─');
  });

  it('上色时对认识的语法做高亮', () => {
    const out = renderMarkdown('```ts\nconst a = 1;\n```', color);
    expect(out).toContain(`\u001b[${SGR.magenta}m`);
  });

  it('不认识的语言退回单色，不抛异常', () => {
    const out = renderMarkdown('```brainfuck\n++++\n```', color);
    expect(stripAnsi(out)).toBe('┌─ brainfuck\n│ ++++\n└─');
  });
});

describe('renderMarkdown 表格', () => {
  const table = ['| 名称 | 值 |', '| --- | --: |', '| 甲 | 1 |', '| b | 22 |'].join('\n');

  it('画方框，数字右对齐按字符宽度算', () => {
    expect(visible(table)).toBe(
      [
        '┌──────┬────┐',
        '│ 名称 │ 值 │',
        '├──────┼────┤',
        '│ 甲   │  1 │',
        '│ b    │ 22 │',
        '└──────┴────┘',
      ].join('\n'),
    );
  });

  it('上色时竖线与横线是独立样式', () => {
    const out = renderMarkdown(table, color);
    expect(out).toContain(`\u001b[${SGR.dim}m`);
    expect(stripAnsi(out)).toBe(visible(table));
  });

  it('超宽表格会压缩最宽的一列', () => {
    const wide = ['| 一 | 二 |', '| - | - |', '| 长得多的内容 | x |'].join('\n');
    const lines = visible(wide, createMarkdownOptions({ width: 26 })).split('\n');
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(26);
    }
  });
});

describe('renderLine（流式逐行）', () => {
  it.each([
    ['## 二级', '二级'],
    ['- 项目', '• 项目'],
    ['- [x] done', '• ☑ done'],
    ['- [ ] todo', '• ☐ todo'],
    ['3. three', '3. three'],
    ['> q', '│ q'],
    ['hello **b**', 'hello b'],
    ['  缩进文本', '  缩进文本'],
  ])('%s → %s', (line, expected) => {
    expect(stripAnsi(renderLine(line, plain))).toBe(expected);
  });

  it('分隔线也按宽度铺满', () => {
    expect(stripAnsi(renderLine('---', plain))).toBe('─'.repeat(60));
  });

  it('空行渲染成空串（由调用方补换行）', () => {
    expect(renderLine('   ', plain)).toBe('');
  });

  it('上色模式的标题带强调色', () => {
    expect(renderLine('# 标题', color)).toContain(`\u001b[1;${SGR.magenta}m`);
  });
});
