/**
 * L1：ANSI 与显示宽度的小工具。
 *
 * 这一层被表格对齐、分隔线、截断到处复用，错一点点整张表就歪，
 * 所以单独测：宽度算错在视觉上很难发现，只能靠断言钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  RESET,
  SGR,
  charWidth,
  createPainter,
  displayWidth,
  padToWidth,
  sliceByWidth,
  stripAnsi,
  truncateToWidth,
} from '../src/markdown/ansi.js';

describe('charWidth', () => {
  it.each([
    ['a', 1],
    ['中', 2],
    ['１', 2],
    ['😀', 2],
    ['\u0301', 0],
    ['\u200b', 0],
  ])('%s 占 %i 列', (char, width) => {
    expect(charWidth(char)).toBe(width);
  });
});

describe('displayWidth', () => {
  it('中文按两列算', () => {
    expect(displayWidth('中文ab')).toBe(6);
  });

  it('忽略 ANSI 序列', () => {
    expect(displayWidth(`\u001b[1m中文\u001b[0m`)).toBe(4);
  });

  it('空串是 0', () => {
    expect(displayWidth('')).toBe(0);
  });
});

describe('stripAnsi', () => {
  it('摘掉颜色序列，留下正文', () => {
    expect(stripAnsi(`\u001b[31m红\u001b[0m`)).toBe('红');
  });

  it('连续多个序列也摘干净', () => {
    expect(stripAnsi(`\u001b[1;35m\u001b[4mx\u001b[0m`)).toBe('x');
  });
});

describe('createPainter', () => {
  it('不上色时原样返回', () => {
    expect(createPainter(false)('a', SGR.bold)).toBe('a');
  });

  it('上色时包一层 SGR 与复位', () => {
    expect(createPainter(true)('a', SGR.bold)).toBe(`\u001b[1ma${RESET}`);
  });

  it('多个样式用分号连起来', () => {
    expect(createPainter(true)('a', SGR.bold, SGR.blue)).toBe(`\u001b[1;34ma${RESET}`);
  });

  it('空串不产出孤立的转义序列', () => {
    expect(createPainter(true)('', SGR.bold)).toBe('');
  });

  it('嵌套时内层复位会重新打开外层，避免外层掉色', () => {
    const paint = createPainter(true);
    const inner = paint('x', SGR.cyan);
    expect(paint(inner, SGR.bold)).toBe(`\u001b[1m\u001b[36mx${RESET}\u001b[1m${RESET}`);
  });
});

describe('truncateToWidth', () => {
  it('放得下就原样返回', () => {
    expect(truncateToWidth('abc', 5)).toBe('abc');
  });

  it('超出时留一列给省略号', () => {
    expect(truncateToWidth('abcdef', 4)).toBe('abc…');
  });

  it('中文按两列算', () => {
    expect(truncateToWidth('中文中文', 5)).toBe('中文…');
  });

  it('宽度为 0 时返回空串', () => {
    expect(truncateToWidth('abc', 0)).toBe('');
  });

  it('被截断的有色文本补一个复位', () => {
    const painted = `\u001b[1mabcdef${RESET}`;
    expect(truncateToWidth(painted, 4)).toBe(`abc…${RESET}`);
  });
});

describe('padToWidth', () => {
  it('右侧补空格到指定宽度', () => {
    expect(padToWidth('ab', 4)).toBe('ab  ');
  });

  it('已经够宽就不再补', () => {
    expect(padToWidth('abcd', 2)).toBe('abcd');
  });

  it('按显示宽度补，不按字符数', () => {
    expect(padToWidth('中文', 6)).toBe('中文  ');
  });
});

describe('sliceByWidth', () => {
  it('按宽度切段', () => {
    expect(sliceByWidth('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });

  it('不会把一个中文字切成两半', () => {
    expect(sliceByWidth('中文a', 2)).toEqual(['中', '文', 'a']);
  });

  it('空串返回空数组', () => {
    expect(sliceByWidth('', 3)).toEqual([]);
  });
});
