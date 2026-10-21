/**
 * ANSI 与「显示宽度」的小工具。
 *
 * 独立成一层的原因：渲染器里到处要算「这段文本在屏幕上占几列」——表格对齐、分隔线、
 * 截断都靠它，而 `String.length` 对 CJK 与 emoji 是错的（一个汉字占 2 列）。
 * 这里不引入 `string-width` 一类的依赖，够用即可。
 */

/** 复位所有样式。 */
export const RESET = '\u001b[0m';

/** 常用 SGR 代码（前景色用 16 色，终端都支持）。 */
export const SGR = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  reverse: 7,
  strike: 9,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
} as const;

/** 上色器：`paint(text, SGR.bold)`；`color` 为假时原样返回。 */
export type Painter = (text: string, ...codes: number[]) => string;

/**
 * 造一个上色器。
 *
 * 里面那句 `replaceAll(RESET, RESET + open)` 是为了**嵌套**：内层（比如行内代码）收尾时
 * 会写一个 `\u001b[0m`，那会顺手把外层（比如粗体）也擦掉。把内层的复位改写成
 * 「复位 + 重新打开外层」，视觉上才连续。
 */
export function createPainter(color: boolean): Painter {
  if (!color) {
    return (text) => text;
  }
  return (text, ...codes) => {
    if (text === '' || codes.length === 0) {
      return text;
    }
    const open = `\u001b[${codes.join(';')}m`;
    return `${open}${text.replaceAll(RESET, RESET + open)}${RESET}`;
  };
}

/** CSI 序列（颜色、光标控制），算宽度前要先摘掉。 */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** 零宽字符：组合符号、ZWJ、变体选择符等。 */
const ZERO_WIDTH =
  /^[\u0300-\u036f\u0483-\u0489\u0591-\u05bd\u0610-\u061a\u061c\u064b-\u065f\u0670\u06d6-\u06ed\u0900-\u0903\u093a-\u094f\u0e31-\u0e3a\u0e47-\u0e4e\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufe00-\ufe0f\ufeff]$/u;

/** 宽字符（东亚宽度 Wide / Fullwidth，以及常见 emoji）。 */
const WIDE =
  /^[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff00-\uff60\uffe0-\uffe6]$/u;
const WIDE_ASTRAL = /^[\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{20000}-\u{2fffd}]$/u;

/** 单个字符占几列：0（零宽）/ 1（普通）/ 2（CJK、emoji）。 */
export function charWidth(char: string): number {
  if (ZERO_WIDTH.test(char)) {
    return 0;
  }
  return WIDE.test(char) || WIDE_ASTRAL.test(char) ? 2 : 1;
}

/** 文本在终端里占几列（自动忽略 ANSI 序列）。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charWidth(char);
  }
  return width;
}

/** 按显示宽度截断，超出时补 `…`；被截断的有色文本会补一个复位。 */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (displayWidth(text) <= width) {
    return text;
  }

  const plain = stripAnsi(text);
  let out = '';
  let used = 0;
  for (const char of plain) {
    const next = charWidth(char);
    // 留一列给省略号。
    if (used + next > width - 1) {
      break;
    }
    out += char;
    used += next;
  }

  // 原文带色时，截断处可能落在某个 SGR 段中间，补一个复位免得后面的输出被染色。
  const hadAnsi = plain !== text;
  return `${out}…${hadAnsi ? RESET : ''}`;
}

/** 右侧补空格到指定显示宽度（够宽就原样返回）。 */
export function padToWidth(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? `${text}${' '.repeat(gap)}` : text;
}

/** 从左边数第 `width` 列之后切一刀（不需要省略号时用，比如折行）。 */
export function sliceByWidth(text: string, width: number): readonly string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest !== '') {
    let used = 0;
    let index = 0;
    for (const char of rest) {
      const next = charWidth(char);
      if (used + next > width && used > 0) {
        break;
      }
      used += next;
      index += char.length;
    }
    // 宽度不够一个字符时也必须前进一步，否则死循环。
    const step = index === 0 ? rest.length : index;
    chunks.push(rest.slice(0, step));
    rest = rest.slice(step);
  }
  return chunks;
}
