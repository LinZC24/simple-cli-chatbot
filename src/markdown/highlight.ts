/**
 * 代码高亮：`highlight.js` → ANSI。
 *
 * 为什么还要自己写这一层：highlight.js 只吐 HTML（`<span class="hljs-keyword">`），
 * 终端要的是 SGR 序列。它输出的 HTML 子集极其固定（只有 span + 几个实体），
 * 所以这里用一个 30 行的扫描器就够了，不必把 HTML 解析器搬进来。
 *
 * 语言用 `highlight.js/lib/common`（36 种常用语言，一个 import 全带上）：
 * 逐个 `registerLanguage` 能让安装体积更小，但那要 import 36 个子路径，
 * 而所有子路径又都没有类型声明（只有主包有），在 `strict` 下会变成一堆 TS7016。
 */
import hljs from 'highlight.js/lib/common';

import { RESET, SGR } from './ansi.js';

/** `hljs-*` 类名 → SGR。`function_` 这种带下划线后缀的会被 trim 掉再查。 */
const CLASS_STYLES: Readonly<Record<string, readonly number[]>> = {
  keyword: [SGR.magenta],
  'selector-tag': [SGR.magenta],
  'meta-keyword': [SGR.magenta],
  doctag: [SGR.gray],
  literal: [SGR.yellow],
  number: [SGR.yellow],
  symbol: [SGR.yellow],
  bullet: [SGR.magenta],
  string: [SGR.green],
  'meta-string': [SGR.green],
  'string.regexp': [SGR.red],
  regexp: [SGR.red],
  subst: [SGR.yellow],
  addition: [SGR.green],
  deletion: [SGR.red],
  comment: [SGR.gray],
  quote: [SGR.gray],
  meta: [SGR.gray],
  punctuation: [SGR.gray],
  params: [SGR.gray],
  built_in: [SGR.cyan],
  type: [SGR.cyan],
  name: [SGR.cyan],
  tag: [SGR.cyan],
  variable: [SGR.cyan],
  'template-variable': [SGR.cyan],
  'variable.language': [SGR.magenta],
  'variable.constant': [SGR.magenta],
  attr: [SGR.yellow],
  attribute: [SGR.yellow],
  property: [SGR.cyan],
  'selector-class': [SGR.yellow],
  'selector-id': [SGR.yellow],
  'selector-attr': [SGR.yellow],
  title: [SGR.blue],
  'title.function': [SGR.blue],
  'title.class': [SGR.blue, SGR.bold],
  section: [SGR.bold, SGR.blue],
  function: [SGR.blue],
  emphasis: [SGR.italic],
  strong: [SGR.bold],
  link: [SGR.underline],
  formula: [SGR.magenta],
  code: [SGR.green],
};

/** 用户常见的简写 → highlight.js 的语言名。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  py: 'python',
  python3: 'python',
  yml: 'yaml',
  html: 'xml',
  vue: 'xml',
  svg: 'xml',
  htm: 'xml',
  sqlite: 'sql',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  golang: 'go',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  plaintext: 'plaintext',
  text: 'plaintext',
  txt: 'plaintext',
};

/** 这些语言名不值得着色（等于没有高亮）。 */
const PLAIN_LANGUAGES = new Set(['plaintext', 'text', 'txt']);

/** 扫描 highlight.js 的 HTML：`<span class="…">`、`</span>`、HTML 实体。 */
const TAG_PATTERN = /<span class="([^"]*)">|<\/span>/g;
const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39|#x27|#x2F|nbsp);/g;
const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (entity) => ENTITIES[entity] ?? entity);
}

function styleOf(className: string): string {
  const codes: number[] = [];
  for (const part of className.split(/\s+/)) {
    const key = part.replace(/^hljs-/, '').replace(/_$/, '');
    const style = CLASS_STYLES[key];
    if (style !== undefined) {
      for (const code of style) {
        if (!codes.includes(code)) {
          codes.push(code);
        }
      }
    }
  }
  return codes.length === 0 ? '' : `\u001b[${codes.join(';')}m`;
}

/**
 * 把 highlight.js 的 HTML 翻成 ANSI。
 *
 * `spans` 是「外层样式栈」：highlight.js 会嵌套（`hljs-string` 里套 `hljs-subst`），
 * 内层结束时要把外层的样式重新打开，否则后面几个字符就掉色了。
 */
function htmlToAnsi(html: string): string {
  let out = '';
  let cursor = 0;
  const stack: string[] = [];
  let current = '';

  const push = (text: string): void => {
    if (text !== '') {
      out += decodeEntities(text);
    }
  };

  for (const match of html.matchAll(TAG_PATTERN)) {
    const index = match.index;
    push(html.slice(cursor, index));
    cursor = index + match[0].length;

    if (match[1] !== undefined) {
      stack.push(current);
      current = styleOf(match[1]);
      out += RESET + current;
      continue;
    }

    current = stack.pop() ?? '';
    out += RESET + current;
  }
  push(html.slice(cursor));

  return current === '' ? out : `${out}${RESET}`;
}

/** 语言名归一化；`undefined` 表示「没有可用的高亮语言」。 */
export function normalizeLanguage(language: string | undefined): string | undefined {
  if (language === undefined) {
    return undefined;
  }
  const name = language.trim().toLowerCase();
  if (name === '') {
    return undefined;
  }
  const resolved = LANGUAGE_ALIASES[name] ?? name;
  if (PLAIN_LANGUAGES.has(resolved)) {
    return undefined;
  }
  return hljs.getLanguage(resolved) === undefined ? undefined : resolved;
}

/**
 * 高亮一段代码，返回 ANSI 文本。
 *
 * 返回 `undefined` 表示这门语言不认识（或没有意义），调用方应该退回「单色代码块」。
 * `ignoreIllegals` 必须开：流式渲染时拿到的常常是半截代码，不忽略就会抛异常。
 */
export function highlightCode(code: string, language: string | undefined): string | undefined {
  const resolved = normalizeLanguage(language);
  if (resolved === undefined || code === '') {
    return undefined;
  }
  const { value } = hljs.highlight(code, { language: resolved, ignoreIllegals: true });
  return htmlToAnsi(value);
}

/** 已注册的语言（测试与 `/help` 说明用）。 */
export function supportedLanguages(): readonly string[] {
  return hljs.listLanguages();
}
