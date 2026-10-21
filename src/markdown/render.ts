/**
 * markdown → ANSI 渲染器。
 *
 * 分工：**解析**交给 `marked`（`Lexer.lex` / `Lexer.lexInline` 只吐 token，不碰 HTML），
 * **渲染**在这里自己做 —— 因为终端没有 DOM，`marked` 自带的 renderer 输出的是 HTML。
 *
 * 两个入口：
 * - `renderMarkdown(source)`：拿到完整文本时用（非流式回合、表格/代码块这类必须攒齐的块）。
 * - `renderMarkdownLine(line)`：流式时逐行用，状态机在 `stream.ts` 里。
 *
 * `color === false` 时渲染成**纯文本**（不加任何 SGR、不画方框），这样重定向到文件、
 * 或者在 CI 日志里看，都是可读、可 diff 的。
 */
import { Lexer } from 'marked';
import type { MarkedToken, Token, Tokens } from 'marked';

import { SGR, createPainter, displayWidth, padToWidth, truncateToWidth } from './ansi.js';
import type { Painter } from './ansi.js';
import { highlightCode } from './highlight.js';

/** 终端宽度未知时的兜底列数。 */
export const DEFAULT_WIDTH = 80;
/** 再窄也要留这么多列，否则表格会碎成锯齿。 */
export const MIN_WIDTH = 20;
/** 代码块与续行的缩进单位。 */
export const INDENT = '  ';
/** 分隔线/表格用的横线字符。 */
const RULE = '─';

export interface MarkdownOptions {
  /** 可用的显示列数（表格、分隔线按它算）。 */
  readonly width: number;
  /** 是否输出 ANSI 颜色与方框。 */
  readonly color: boolean;
  /** 是否对代码块做语法高亮（需要 `color`）。 */
  readonly highlight: boolean;
}

/** `createMarkdownOptions` 的入参：都允许显式 `undefined`（`exactOptionalPropertyTypes` 下 `Partial` 不允许）。 */
export interface MarkdownOptionInit {
  readonly width?: number | undefined;
  readonly color?: boolean | undefined;
  readonly highlight?: boolean | undefined;
}

/** 把 `process.stdout.columns` 之类的值收敛成一个可用宽度。 */
export function resolveWidth(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) {
    return DEFAULT_WIDTH;
  }
  return Math.max(MIN_WIDTH, Math.floor(columns));
}

export function createMarkdownOptions(partial: MarkdownOptionInit = {}): MarkdownOptions {
  return {
    width: resolveWidth(partial.width),
    color: partial.color ?? false,
    highlight: partial.highlight ?? partial.color ?? false,
  };
}

/** 渲染时的上下文：选项 + 绑好 `color` 的上色器。 */
interface Context {
  readonly options: MarkdownOptions;
  readonly paint: Painter;
}

function contextOf(options: MarkdownOptions): Context {
  return { options, paint: createPainter(options.color) };
}

const HR_PATTERN = /^\s{0,3}(?:-[-\s]*\*{0,3}|[-*_]{3,})\s*$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE_PATTERN = /^(\s*)((?:>\s?)+)(.*)$/;
const BULLET_PATTERN = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_PATTERN = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK_PATTERN = /^\[([ xX])\]\s+(.*)$/;

/**
 * marked 内置 token 的类型名。
 *
 * 用处只有一个：`Token` 是 `MarkedToken | Tokens.Generic`，而 `Generic` 带索引签名，
 * 于是 `switch (token.type)` 收不窄（`heading` 分支里 `token.depth` 仍是 `unknown` 级别）。
 * 本项目没注册任何 marked 扩展，`Generic` 永远不会出现，所以先过一道白名单把类型收窄，
 * 比在每处塞 `as Tokens.Heading` 诚实 —— 那是 22 个 cast，这里只有 1 个判断。
 */
const MARKED_TOKEN_TYPES: ReadonlySet<string> = new Set<string>([
  'blockquote',
  'br',
  'checkbox',
  'code',
  'codespan',
  'def',
  'del',
  'em',
  'escape',
  'heading',
  'hr',
  'html',
  'image',
  'link',
  'list',
  'list_item',
  'paragraph',
  'space',
  'strong',
  'table',
  'text',
]);

function isMarkedToken(token: Token): token is MarkedToken {
  return MARKED_TOKEN_TYPES.has(token.type);
}

/** 这一行是不是围栏代码块的边界（``` 或 ~~~）。 */
export function fenceOf(line: string): { readonly close: boolean; readonly language: string } | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) {
    return undefined;
  }
  const info = (match[2] ?? '').trim();
  return { close: false, language: info.split(/\s+/)[0] ?? '' };
}

/** 这一行看起来是表格行（GFM 表格每行都以 `|` 或结尾 `|`）。 */
export function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') || (trimmed.endsWith('|') && trimmed.includes('|'));
}

function rule(ctx: Context, indent: string): string {
  const width = Math.max(1, ctx.options.width - displayWidth(indent));
  return ctx.paint(RULE.repeat(width), SGR.dim);
}

function renderHeading(token: Tokens.Heading, ctx: Context, indent: string): string {
  const text = renderInlineTokens(token.tokens, ctx);
  const codes = token.depth === 1 ? [SGR.bold, SGR.magenta] : token.depth === 2 ? [SGR.bold, SGR.cyan] : [SGR.bold];
  return `${indent}${ctx.paint(text, ...codes)}\n`;
}

function renderCode(token: Tokens.Code, ctx: Context, indent: string): string {
  const body = token.text.replace(/\n$/, '');
  const lines = body.split('\n');
  const language = (token.lang ?? '').trim();

  // 纯文本模式：不画方框，只缩进。屏幕上干净，`> out.txt` 之后还能 diff。
  if (!ctx.options.color) {
    const gutter = `${indent}${INDENT}`;
    const header = language === '' ? '' : `${gutter}[${language}]\n`;
    return `${header}${lines.map((line) => `${gutter}${line}`).join('\n')}\n`;
  }

  const label = language === '' ? '' : ` ${ctx.paint(language, SGR.dim)}`;
  const gutter = `${indent}${ctx.paint('│ ', SGR.dim)}`;
  const highlighted = ctx.options.highlight ? highlightCode(body, language) : undefined;
  const renderedLines =
    highlighted === undefined
      ? lines.map((line) => ctx.paint(line, SGR.dim))
      : highlighted.split('\n');

  return [
    `${indent}${ctx.paint('┌─', SGR.dim)}${label}`,
    ...renderedLines.map((line) => `${gutter}${line}`),
    `${indent}${ctx.paint('└─', SGR.dim)}`,
  ].join('\n');
}

function renderBlockquote(token: Tokens.Blockquote, ctx: Context, indent: string): string {
  const inner = renderBlocks(token.tokens, ctx, '').replace(/\n+$/, '');
  const bar = ctx.paint('│ ', SGR.dim);
  const lines = inner.split('\n').map((line) => `${indent}${bar}${line}`);
  return lines.join('\n');
}

function renderListItem(item: Tokens.ListItem, ctx: Context, index: number, ordered: boolean, start: number): { prefix: string; body: string } {
  const marker = ordered ? `${start + index}. ` : `${ctx.paint('•', SGR.magenta)} `;
  // marked 已经把 `[x]` 从正文里摘走了，复选框从 `item.checked` 拿，
  // 别再去正文里找 `[x]`（那里根本没有，而且 `checkbox` 会单独成一个 token）。
  const checkbox = item.task === true ? checkboxMark(item.checked, ctx) : '';

  const body = renderBlocks(item.tokens, ctx, '').replace(/\n+$/, '');
  return { prefix: `${marker}${checkbox}`, body };
}

/** 任务列表的勾选框：勾过的是绿的，没勾的是灰框。 */
function checkboxMark(checked: boolean | undefined, ctx: Context): string {
  if (checked === true) {
    return `${ctx.paint('☑', SGR.green)} `;
  }
  return `${ctx.paint('☐', SGR.dim)} `;
}

function renderList(token: Tokens.List, ctx: Context, indent: string): string {
  const start = typeof token.start === 'number' ? token.start : 1;
  const lines: string[] = [];

  token.items.forEach((item, index) => {
    const { prefix, body } = renderListItem(item, ctx, index, token.ordered, start);
    const bodyLines = body.split('\n');
    const padding = ' '.repeat(displayWidth(prefix));

    lines.push(`${indent}${prefix}${bodyLines[0] ?? ''}`);
    for (const line of bodyLines.slice(1)) {
      lines.push(line === '' ? '' : `${indent}${padding}${line}`);
    }
  });

  return lines.join('\n');
}

/** 把列宽压进可用宽度：每次削最宽的那一列，直到放得下。 */
function fitWidths(widths: readonly number[], available: number): number[] {
  const fitted = [...widths];
  const limit = Math.max(1, available);
  const total = (): number => fitted.reduce((sum, width) => sum + width, 0);

  while (total() > limit) {
    let widest = 0;
    for (let index = 1; index < fitted.length; index += 1) {
      if ((fitted[index] ?? 0) > (fitted[widest] ?? 0)) {
        widest = index;
      }
    }
    if ((fitted[widest] ?? 1) <= 1) {
      break;
    }
    fitted[widest] = (fitted[widest] ?? 1) - 1;
  }

  return fitted;
}

function alignCell(text: string, width: number, align: Tokens.Table['align'][number]): string {
  const cell = truncateToWidth(text, width);
  if (align === 'right') {
    return `${' '.repeat(Math.max(0, width - displayWidth(cell)))}${cell}`;
  }
  if (align === 'center') {
    const gap = Math.max(0, width - displayWidth(cell));
    const left = Math.floor(gap / 2);
    return `${' '.repeat(left)}${cell}${' '.repeat(gap - left)}`;
  }
  return padToWidth(cell, width);
}

function renderTable(token: Tokens.Table, ctx: Context, indent: string): string {
  const columns = token.header.length;
  const header = token.header.map((cell) => renderInlineTokens(cell.tokens, ctx));
  const rows = token.rows.map((row) => row.map((cell) => renderInlineTokens(cell.tokens, ctx)));

  const natural: number[] = [];
  for (let index = 0; index < columns; index += 1) {
    const cells = [header[index] ?? '', ...rows.map((row) => row[index] ?? '')];
    natural.push(Math.max(1, ...cells.map((cell) => displayWidth(cell))));
  }

  // 两根竖线 + 每列左右各一格内边距 都算额外开销。
  const available = Math.max(columns, ctx.options.width - displayWidth(indent) - (columns + 1) - columns * 2);
  const widths = fitWidths(natural, available);

  const line = (left: string, middle: string, right: string): string =>
    `${indent}${ctx.paint(
      `${left}${widths.map((width) => RULE.repeat(width + 2)).join(middle)}${right}`,
      SGR.dim,
    )}`;

  const row = (cells: readonly string[], codes: readonly number[]): string => {
    const padded = cells
      .map((cell, index) => ` ${ctx.paint(alignCell(cell, widths[index] ?? 1, token.align[index] ?? null), ...codes)} `)
      .join(ctx.paint('│', SGR.dim));
    return `${indent}${ctx.paint('│', SGR.dim)}${padded}${ctx.paint('│', SGR.dim)}`;
  };

  return [
    line('┌', '┬', '┐'),
    row(header, [SGR.bold]),
    line('├', '┼', '┤'),
    ...rows.map((cells) => row(cells, [])),
    line('└', '┴', '┘'),
  ].join('\n');
}

function renderBlocks(tokens: readonly Token[], ctx: Context, indent: string): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (!isMarkedToken(token)) {
      continue;
    }
    const rendered = renderBlockToken(token, ctx, indent);
    if (rendered !== '') {
      // 每个块自己决定结尾要不要换行，拼的时候统一交给 `join('\n')`：
      // 否则内层多一个 `\n`，块与块之间就莫名多出空行。
      parts.push(rendered.replace(/\n+$/, ''));
    }
  }
  return parts.length === 0 ? '' : `${parts.join('\n')}\n`;
}

function renderBlockToken(token: MarkedToken, ctx: Context, indent: string): string {
  switch (token.type) {
    case 'space':
    case 'checkbox':
      // 复选框由 `renderListItem` 画在列表前缀上，这里不能再画一次。
      return '';
    case 'heading':
      return renderHeading(token, ctx, indent);
    case 'paragraph':
      return `${indent}${renderInlineTokens(token.tokens, ctx)}`;
    case 'text':
      return `${indent}${token.tokens === undefined ? token.text : renderInlineTokens(token.tokens, ctx)}`;
    case 'code':
      return renderCode(token, ctx, indent);
    case 'blockquote':
      return renderBlockquote(token, ctx, indent);
    case 'list':
      return renderList(token, ctx, indent);
    case 'table':
      return renderTable(token, ctx, indent);
    case 'hr':
      return rule(ctx, indent);
    case 'html':
      return `${indent}${token.text.trimEnd()}`;
    case 'def':
      return '';
    default:
      return `${indent}${token.raw.trimEnd()}`;
  }
}

function renderInlineToken(token: MarkedToken, ctx: Context): string {
  switch (token.type) {
    case 'strong':
      return ctx.paint(renderInlineTokens(token.tokens, ctx), SGR.bold);
    case 'em':
      return ctx.paint(renderInlineTokens(token.tokens, ctx), SGR.italic);
    case 'del':
      return ctx.paint(renderInlineTokens(token.tokens, ctx), SGR.strike);
    case 'codespan':
      return ctx.paint(token.text, SGR.cyan);
    case 'link': {
      const label = renderInlineTokens(token.tokens, ctx);
      const text = label === '' ? token.href : label;
      const visible = ctx.paint(text, SGR.underline, SGR.blue);
      // 文本与地址不同才把地址补出来，否则每个链接都跟着一长串 url，噪声太大。
      return text === token.href ? visible : `${visible} ${ctx.paint(`(${token.href})`, SGR.dim)}`;
    }
    case 'image': {
      const alt = token.text === '' ? '图片' : `图片: ${token.text}`;
      return `${ctx.paint(`[${alt}]`, SGR.dim)} ${ctx.paint(token.href, SGR.dim)}`;
    }
    case 'br':
      return '\n';
    case 'escape':
      return token.text;
    case 'text':
      return token.tokens === undefined ? token.text : renderInlineTokens(token.tokens, ctx);
    case 'html':
      return token.text;
    default:
      return token.raw;
  }
}

function renderInlineTokens(tokens: readonly Token[] | undefined, ctx: Context): string {
  if (tokens === undefined) {
    return '';
  }
  let out = '';
  for (const token of tokens) {
    if (!isMarkedToken(token)) {
      continue;
    }
    out += renderInlineToken(token, ctx);
  }
  return out;
}

/** 渲染一段完整 markdown。 */
export function renderMarkdown(source: string, options: MarkdownOptions): string {
  const ctx = contextOf(options);
  const tokens = Lexer.lex(source, { gfm: true });
  return renderBlocks(tokens, ctx, '').replace(/\n$/, '');
}

/** 只渲染一行里的行内标记（`**a**`、`` `b` `` 这类）。 */
export function renderInline(source: string, options: MarkdownOptions): string {
  return renderInlineWithContext(source, contextOf(options));
}

function renderInlineWithContext(source: string, ctx: Context): string {
  return renderInlineTokens(Lexer.lexInline(source, { gfm: true }), ctx);
}

/**
 * 渲染一行（不带结尾换行）。
 *
 * 流式渲染器按行喂进来，所以这里必须能**单独**决定一行的样式：标题、列表、引用、
 * 分隔线都靠行首特征识别，不像 `renderMarkdown` 那样有完整 token 树可用。
 */
export function renderLine(line: string, options: MarkdownOptions): string {
  const ctx = contextOf(options);

  if (line.trim() === '') {
    return '';
  }

  const quote = QUOTE_PATTERN.exec(line);
  if (quote !== null) {
    const depth = (quote[2] ?? '').split('>').length - 1;
    const bar = ctx.paint('│ ', SGR.dim).repeat(Math.max(1, depth));
    return `${quote[1] ?? ''}${bar}${renderInlineWithContext(quote[3] ?? '', ctx)}`;
  }

  const heading = HEADING_PATTERN.exec(line);
  if (heading !== null) {
    const depth = (heading[1] ?? '#').length;
    const codes = depth === 1 ? [SGR.bold, SGR.magenta] : depth === 2 ? [SGR.bold, SGR.cyan] : [SGR.bold];
    return ctx.paint(renderInlineWithContext(heading[2] ?? '', ctx), ...codes);
  }

  if (HR_PATTERN.test(line)) {
    return rule(ctx, '');
  }

  const bullet = BULLET_PATTERN.exec(line);
  const ordered = ORDERED_PATTERN.exec(line);
  if (bullet !== null || ordered !== null) {
    const match = bullet ?? ordered;
    const indent = match?.[1] ?? '';
    const marker = bullet !== null ? `${ctx.paint('•', SGR.magenta)} ` : `${ordered?.[2] ?? '1'}. `;
    const rest = match?.[3] ?? '';
    const task = TASK_PATTERN.exec(rest);
    const checkbox =
      task === null ? '' : task[1] === ' ' ? `${ctx.paint('☐', SGR.dim)} ` : `${ctx.paint('☑', SGR.green)} `;
    const content = task === null ? rest : task[2] ?? '';
    return `${indent}${marker}${checkbox}${renderInlineWithContext(content, ctx)}`;
  }

  return renderInlineWithContext(line, ctx);
}
