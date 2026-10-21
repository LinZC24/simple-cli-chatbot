/**
 * L1：highlight.js → ANSI 的翻译层。
 *
 * 断言分两类：
 * - 「文本不能变形」：实体解码、HTML 标签必须摘干净 —— 颜色错了只是难看，标签漏出来就是事故；
 * - 「样式确实套上了」：只挑几个稳定的类（keyword/string/comment）钉住颜色码。
 */

import { describe, expect, it } from 'vitest';
import { SGR, stripAnsi } from '../src/markdown/ansi.js';
import { highlightCode, normalizeLanguage, supportedLanguages } from '../src/markdown/highlight.js';

const magenta = `\u001b[${SGR.magenta}m`;
const green = `\u001b[${SGR.green}m`;

describe('normalizeLanguage', () => {
  it.each([
    ['ts', 'typescript'],
    ['TS', 'typescript'],
    ['js', 'javascript'],
    ['sh', 'bash'],
    ['py', 'python'],
    ['yml', 'yaml'],
    ['html', 'xml'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });

  it('已经规范的名字直接透传', () => {
    expect(normalizeLanguage('rust')).toBe('rust');
  });

  it('两端空白不影响判断', () => {
    expect(normalizeLanguage('  go  ')).toBe('go');
  });

  it.each([['text'], ['plaintext'], ['txt']])('%s 等于不高亮', (input) => {
    expect(normalizeLanguage(input)).toBeUndefined();
  });

  it('空串与 undefined 都表示没有语言', () => {
    expect(normalizeLanguage('')).toBeUndefined();
    expect(normalizeLanguage(undefined)).toBeUndefined();
  });

  it('common 包里没有的语言返回 undefined', () => {
    expect(normalizeLanguage('brainfuck')).toBeUndefined();
  });
});

describe('highlightCode', () => {
  it('关键字与字符串分别上色', () => {
    const out = highlightCode('const s = "hi";', 'ts');
    expect(out).toBeDefined();
    expect(out).toContain(magenta);
    expect(out).toContain(green);
  });

  it('正文内容一字不改（实体被解码回来）', () => {
    const out = highlightCode('if (a < b && c > d) { f("x"); }', 'ts');
    expect(stripAnsi(out ?? '')).toContain('a < b && c > d');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&amp;');
  });

  it('引号不会被转义成实体', () => {
    const out = highlightCode(`const s = 'a"b';`, 'js');
    expect(stripAnsi(out ?? '')).toContain(`'a"b'`);
    expect(out).not.toContain('&quot;');
  });

  it('不留下任何 HTML 标签', () => {
    const out = highlightCode('function f() { return 1; }', 'javascript') ?? '';
    expect(out).not.toContain('<span');
    expect(out).not.toContain('</span>');
  });

  it('嵌套样式：内层结束时重新打开外层，后续字符不掉色', () => {
    const out = highlightCode('const t = `a${b}c`;', 'ts') ?? '';
    // 模板字符串里套了插值，highlight.js 会输出 hljs-string > hljs-subst 的嵌套 span。
    expect(stripAnsi(out)).toContain('const t = `a${b}c`;');
    expect(out).not.toContain('<');
  });

  it('空代码返回 undefined', () => {
    expect(highlightCode('', 'ts')).toBeUndefined();
  });

  it('没有语言时返回 undefined（调用方退回单色）', () => {
    expect(highlightCode('const a = 1;', undefined)).toBeUndefined();
  });

  it('不认识的语言返回 undefined，不抛异常', () => {
    expect(highlightCode('whatever', 'brainfuck')).toBeUndefined();
  });

  it('半截代码也能高亮（ignoreIllegals 才不抛）', () => {
    expect(() => highlightCode('function f( { "x', 'ts')).not.toThrow();
  });

  it('收尾不把样式留在打开状态', () => {
    // 逐个扫 SGR 序列，最后生效的那个必须是复位；否则后面接的 `bot>` 之类都会被染色。
    const stylesAtEnd = (text: string): string => {
      let last = '0';
      for (const match of text.matchAll(/\u001b\[([0-9;]*)m/g)) {
        last = match[1] ?? '0';
      }
      return last;
    };

    expect(stylesAtEnd(highlightCode('let x = 1;', 'ts') ?? '')).toBe('0');
    expect(stylesAtEnd(highlightCode('const t = `a${b}c`;', 'ts') ?? '')).toBe('0');
  });
});

describe('supportedLanguages', () => {
  it('common 包带上了常用语言', () => {
    const languages = supportedLanguages();
    expect(languages).toContain('typescript');
    expect(languages).toContain('bash');
    expect(languages).toContain('json');
  });
});
