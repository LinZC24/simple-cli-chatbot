import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeEnvValue, mergeEnvContent, updateEnvFile } from '../src/env-file.js';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-chatbot-env-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('encodeEnvValue', () => {
  it.each(['gpt-4o', 'gpt-4.1', 'sk-abc123', '0.7', '256'])('%s 裸写', (value) => {
    expect(encodeEnvValue(value)).toBe(value);
  });

  it('带空格的提示语加双引号', () => {
    expect(encodeEnvValue('你是一名译者 只输出译文')).toBe('"你是一名译者 只输出译文"');
  });

  it('带 # 的值加引号（否则会被当成注释截断）', () => {
    expect(encodeEnvValue('a#b')).toBe('"a#b"');
  });

  it('双引号与反斜杠都转义', () => {
    expect(encodeEnvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(encodeEnvValue('a\\b c')).toBe('"a\\\\b c"');
  });

  it('空串加引号', () => {
    expect(encodeEnvValue('')).toBe('""');
  });
});

describe('mergeEnvContent', () => {
  it('替换已存在的键，保留其它行与顺序', () => {
    const result = mergeEnvContent('A=1\nLLM_MODEL=old\nB=2\n', { LLM_MODEL: 'new' });
    expect(result.content).toBe('A=1\nLLM_MODEL=new\nB=2\n');
    expect(result.changed).toEqual(['LLM_MODEL']);
  });

  it('新键追加到末尾，并自动空一行', () => {
    const result = mergeEnvContent('A=1\n', { LLM_TEMPERATURE: '0.7' });
    expect(result.content).toBe('A=1\n\nLLM_TEMPERATURE=0.7\n');
    expect(result.changed).toEqual(['LLM_TEMPERATURE']);
  });

  it('值为 undefined 时删掉该行', () => {
    const result = mergeEnvContent('A=1\nLLM_MAX_TOKENS=256\nB=2\n', { LLM_MAX_TOKENS: undefined });
    expect(result.content).toBe('A=1\nB=2\n');
    expect(result.changed).toEqual(['LLM_MAX_TOKENS']);
  });

  it('删除不存在的键不算改动', () => {
    const result = mergeEnvContent('A=1\n', { LLM_MAX_TOKENS: undefined });
    expect(result.content).toBe('A=1\n');
    expect(result.changed).toEqual([]);
  });

  it('注释行不算已配置，也不会被删掉', () => {
    const content = '# LLM_MODEL=gpt-4o-mini\nA=1\n';
    const result = mergeEnvContent(content, { LLM_MODEL: 'gpt-4.1' });
    expect(result.content).toBe('# LLM_MODEL=gpt-4o-mini\nA=1\n\nLLM_MODEL=gpt-4.1\n');
    expect(mergeEnvContent(content, { LLM_MODEL: undefined }).content).toBe(content);
  });

  it('认识 export 前缀写法', () => {
    const result = mergeEnvContent('export LLM_MODEL=old\n', { LLM_MODEL: 'new' });
    expect(result.content).toBe('LLM_MODEL=new\n');
  });

  it('前缀相同的键不会串门（LLM_MODEL 不会匹配 LLM_MODEL_X）', () => {
    const result = mergeEnvContent('LLM_MODEL_X=1\n', { LLM_MODEL: 'new' });
    expect(result.content).toBe('LLM_MODEL_X=1\n\nLLM_MODEL=new\n');
  });

  it('值本来就一样时 changed 为空', () => {
    const result = mergeEnvContent('LLM_MODEL=gpt-4o-mini\n', { LLM_MODEL: 'gpt-4o-mini' });
    expect(result.changed).toEqual([]);
    expect(result.content).toBe('LLM_MODEL=gpt-4o-mini\n');
  });

  it('空文件也能量出正确结果', () => {
    expect(mergeEnvContent('', { LLM_MODEL: 'new' }).content).toBe('LLM_MODEL=new\n');
  });

  it('多次改动一次写入', () => {
    const result = mergeEnvContent('LLM_MODEL=old\n', { LLM_MODEL: 'new', LLM_MAX_TOKENS: '64' });
    expect(result.content).toBe('LLM_MODEL=new\n\nLLM_MAX_TOKENS=64\n');
    expect(result.changed).toEqual(['LLM_MODEL', 'LLM_MAX_TOKENS']);
  });
});

describe('updateEnvFile', () => {
  it('写回新值，并把原文备份到 .bak', async () => {
    const dir = await makeDir();
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_API_KEY=sk-test\nLLM_MODEL=old\n', 'utf8');

    const result = await updateEnvFile(file, { LLM_MODEL: 'gpt-4.1' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toEqual(['LLM_MODEL']);
    expect(await readFile(file, 'utf8')).toBe('LLM_API_KEY=sk-test\nLLM_MODEL=gpt-4.1\n');
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('LLM_API_KEY=sk-test\nLLM_MODEL=old\n');
  });

  it('密钥不会被这段逻辑改写（只动传入的键）', async () => {
    const dir = await makeDir();
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_API_KEY=sk-real-key\nLLM_MODEL=old\n', 'utf8');

    await updateEnvFile(file, { LLM_MODEL: 'gpt-4.1' });

    expect(await readFile(file, 'utf8')).toContain('LLM_API_KEY=sk-real-key');
  });

  it('值没变化时不写盘、也不产生 .bak', async () => {
    const dir = await makeDir();
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_MODEL=gpt-4o-mini\n', 'utf8');

    const result = await updateEnvFile(file, { LLM_MODEL: 'gpt-4o-mini' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.changed).toEqual([]);
    expect(await readdir(dir)).toEqual(['.env']);
  });

  it('.env 不存在时返回 missing，不写任何东西', async () => {
    const dir = await makeDir();
    const result = await updateEnvFile(join(dir, '.env'), { LLM_MODEL: 'x' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('missing');
    expect(await readdir(dir)).toEqual([]);
  });

  it('含换行的值直接拒绝（会把一行拆成两行）', async () => {
    const dir = await makeDir();
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_MODEL=old\n', 'utf8');

    const result = await updateEnvFile(file, { LLM_SYSTEM_PROMPT: 'a\nb' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid-value');
    expect(await readFile(file, 'utf8')).toBe('LLM_MODEL=old\n');
  });

  it('带特殊字符的值写回后仍是一行', async () => {
    const dir = await makeDir();
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_MODEL=old\n', 'utf8');

    await updateEnvFile(file, { LLM_SYSTEM_PROMPT: '你是助手#只输出中文' });

    const text = await readFile(file, 'utf8');
    expect(text).toContain('LLM_SYSTEM_PROMPT="你是助手#只输出中文"');
    expect(text.split('\n').filter((line) => line.startsWith('LLM_SYSTEM_PROMPT'))).toHaveLength(1);
  });
});
