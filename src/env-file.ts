/**
 * 把配置改动写回 `.env`（`/config save` 的实现）。
 *
 * 三条自我约束：
 * - **白名单**：只改调用方传进来的键，且 CLI 层只会传 `MUTABLE_CONFIG_ENV_VARS` 里的四个，
 *   `LLM_API_KEY` 永不出现在参数里 —— 密钥不进终端回滚，也不进备份文件的新增内容；
 * - **先备份**：覆盖前把原文写进 `<path>.bak`，写坏了还能手工回滚；
 * - **纯逻辑与 IO 分离**：`mergeEnvContent` 是纯函数（就地在文本上替换/追加/删除行），
 *   `updateEnvFile` 只负责读、备份、写，测试两层都能各测各的。
 *
 * 不解析整个 dotenv 语法，只做「按行替换 `KEY=`」这一件事：`.env` 是给人看也给人改的文件，
 * 保留注释、空行与顺序比「规范化」更重要。
 */

import { readFile, writeFile } from 'node:fs/promises';

/** 备份文件后缀：`<path>.bak`。 */
export const BACKUP_SUFFIX = '.bak';

export type EnvFileFailureReason = 'missing' | 'invalid-value' | 'write-failed';

export type EnvFileResult =
  | {
      readonly ok: true;
      /** 真正发生变化的变量名；空数组表示值与文件里一致，文件未被改动。 */
      readonly changed: readonly string[];
      readonly backupPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: EnvFileFailureReason;
      readonly message: string;
    };

export interface MergeResult {
  readonly content: string;
  readonly changed: readonly string[];
}

/** 可以裸写（不加引号）的值：不含空白、`#`、引号、反斜杠。 */
const BARE_VALUE_PATTERN = /^[^\s"'#\\]+$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function linePattern(key: string): RegExp {
  return new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
}

/**
 * 值编码：能裸写就裸写，否则加双引号并转义 `\` 与 `"`。
 *
 * `node --env-file` 的解析器认双引号且引号内的 `#` 不是注释，所以带 `#` 的中文提示语
 * 必须进引号，否则会被截断成半个 prompt。
 */
export function encodeEnvValue(value: string): string {
  if (BARE_VALUE_PATTERN.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 在 `.env` 文本上就地应用改动（纯函数）。
 *
 * - 值为 `undefined` → 删除该行（表示「清空，用默认值」）；
 * - 有值 → 替换第一处匹配行；没有匹配行就追加到末尾；
 * - 注释行（`# LLM_MODEL=...`）视为「未配置」，不会被替换，也不会被删除。
 */
export function mergeEnvContent(content: string, updates: Readonly<Record<string, string | undefined>>): MergeResult {
  const lines = content.split('\n');
  // 末尾换行在 split 后会多出一个空串：先摘掉，最后统一补回去。
  if (lines.at(-1) === '') {
    lines.pop();
  }

  const changed: string[] = [];
  const appended: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const pattern = linePattern(key);
    const index = lines.findIndex((line) => pattern.test(line));

    if (value === undefined) {
      if (index !== -1) {
        lines.splice(index, 1);
        changed.push(key);
      }
      continue;
    }

    const next = `${key}=${encodeEnvValue(value)}`;
    if (index === -1) {
      appended.push(next);
      changed.push(key);
      continue;
    }
    if (lines[index] !== next) {
      lines[index] = next;
      changed.push(key);
    }
  }

  if (appended.length > 0) {
    // 追加前留一个空行，避免紧贴在上一条配置后面。
    if (lines.length > 0 && lines.at(-1) !== '') {
      lines.push('');
    }
    lines.push(...appended);
  }

  const merged = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return { content: merged, changed };
}

/**
 * 读取 `.env`、合并改动、备份原文件、写回。
 *
 * @param filePath `.env` 的路径（测试传临时文件）
 * @param updates 变量名 → 新值；`undefined` 表示删掉这一行
 */
export async function updateEnvFile(
  filePath: string,
  updates: Readonly<Record<string, string | undefined>>,
): Promise<EnvFileResult> {
  const invalid = Object.entries(updates).find(([, value]) => value !== undefined && /[\r\n]/.test(value));
  if (invalid !== undefined) {
    return { ok: false, reason: 'invalid-value', message: `${invalid[0]} 的值不能包含换行` };
  }

  let original: string;
  try {
    original = await readFile(filePath, 'utf8');
  } catch (cause) {
    const code = isNodeError(cause) ? cause.code : undefined;
    if (code === 'ENOENT') {
      return { ok: false, reason: 'missing', message: `${filePath} 不存在` };
    }
    return { ok: false, reason: 'write-failed', message: describeError(cause) };
  }

  const merged = mergeEnvContent(original, updates);
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;

  if (merged.changed.length === 0) {
    // 内容没变就别写盘，也别制造一个无意义的 .bak。
    return { ok: true, changed: [], backupPath };
  }

  try {
    await writeFile(backupPath, original, 'utf8');
    await writeFile(filePath, merged.content, 'utf8');
  } catch (cause) {
    return { ok: false, reason: 'write-failed', message: describeError(cause) };
  }

  return { ok: true, changed: merged.changed, backupPath };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
