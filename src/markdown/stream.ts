/**
 * 流式 markdown 渲染：**按行**缓冲。
 *
 * 为什么不逐块即时渲染：SSE 送来的 delta 可能停在 `**粗` 或 `` `cod `` 中间，立刻上色会
 * 让未闭合的标记闪一下再变样。按行缓冲的取舍是「一行内的格式等这一行结束再上色」，
 * 代价只有极短的延迟，换来的是不会看到半截标记。
 *
 * 有三类东西一行决定不了，必须攒齐：
 * - 围栏代码块：要一直攒到闭合围栏（但**块内逐行照常输出**，否则代码就不「流」了）。
 * - 表格：列宽是所有行算出来的，只能等整张表结束。
 * - 行尾没有换行的最后半行：`finish()` 时兜底渲染。
 *
 * 与 `renderMarkdown` 的关系：块级元素（代码块、表格）重合时交给它渲染，保证同一段
 * markdown 无论走流式还是整包，看起来一样。
 */
import { SGR, createPainter } from './ansi.js';
import { INDENT, fenceOf, looksLikeTableRow, renderLine, renderMarkdown } from './render.js';
import type { MarkdownOptions } from './render.js';
import { highlightCode } from './highlight.js';

export interface MarkdownStream {
  /** 收到一段增量 → 现在就该写出去的文本（可能是空串）。 */
  push(chunk: string): string;
  /** 收尾：冲掉半行、表格残块、未闭合的代码块。 */
  finish(): string;
}

type Fence = { readonly kind: 'plain' } | { readonly kind: 'fence'; readonly language: string };

export function createMarkdownStream(options: MarkdownOptions): MarkdownStream {
  const paint = createPainter(options.color);
  /** 还没看到换行的残行。 */
  let pending = '';
  let fence: Fence = { kind: 'plain' };
  /** 表格行缓冲（含表头与分隔行）。 */
  let tableRows: string[] = [];

  const openFence = (language: string): string => {
    fence = { kind: 'fence', language };
    if (!options.color) {
      // 纯文本模式与 `renderCode` 对齐：不画方框，语言只留一行标记。
      return language === '' ? '' : `${INDENT}[${language}]\n`;
    }
    const label = language === '' ? '' : ` ${paint(language, SGR.dim)}`;
    return `${paint('┌─', SGR.dim)}${label}\n`;
  };

  const closeFence = (): string => {
    fence = { kind: 'plain' };
    return options.color ? `${paint('└─', SGR.dim)}\n` : '';
  };

  const fenceLine = (line: string, language: string): string => {
    if (!options.color) {
      return `${INDENT}${line}\n`;
    }
    const highlighted = options.highlight ? highlightCode(line, language) : undefined;
    return `${paint('│ ', SGR.dim)}${highlighted ?? paint(line, SGR.dim)}\n`;
  };

  const flushTable = (): string => {
    if (tableRows.length === 0) {
      return '';
    }
    const rows = tableRows;
    tableRows = [];
    const rendered = renderMarkdown(rows.join('\n'), options);
    return rendered === '' ? '' : `${rendered}\n`;
  };

  /**
   * 吃掉一整行，返回该写出去的文本。
   *
   * 只有「一行 + 已知状态」决定输出，所以这个函数是纯的 —— 状态由闭包持有。
   */
  const consume = (line: string): string => {
    const boundary = fenceOf(line);

    if (fence.kind === 'fence') {
      return boundary === undefined ? fenceLine(line, fence.language) : closeFence();
    }

    if (boundary !== undefined) {
      return `${flushTable()}${openFence(boundary.language)}`;
    }

    if (looksLikeTableRow(line)) {
      tableRows.push(line);
      return '';
    }

    return `${flushTable()}${renderLine(line, options)}\n`;
  };

  return {
    push(chunk) {
      if (chunk === '') {
        return '';
      }
      pending += chunk;

      let out = '';
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        out += consume(line);
        index = pending.indexOf('\n');
      }
      return out;
    },

    finish() {
      let out = flushTable();

      if (pending !== '') {
        const line = pending.replace(/\r$/, '');
        pending = '';
        out += fence.kind === 'fence' ? fenceLine(line, fence.language) : `${renderLine(line, options)}\n`;
      }

      if (fence.kind === 'fence') {
        out += closeFence();
      }
      return out;
    },
  };
}
