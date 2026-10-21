import { describe, expect, it } from 'vitest';

import { createSseParser, parseSseStream, type SseEvent } from '../src/llm/sse.js';

describe('createSseParser', () => {
  it('一条完整的 data 帧', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }]);
  });

  it('一行被切成两块也能拼回来', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"choi')).toEqual([]);
    expect(parser.push('ce":1}\n\n')).toEqual([{ data: '{"choice":1}' }]);
  });

  it('一块里含多帧', () => {
    const parser = createSseParser();
    expect(parser.push('data: 1\n\ndata: 2\n\ndata: 3\n\n')).toEqual([{ data: '1' }, { data: '2' }, { data: '3' }]);
  });

  it('多行 data 用换行连接（SSE 规范）', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\ndata: b\n\n')).toEqual([{ data: 'a\nb' }]);
  });

  it('CRLF 与单独 CR 都当换行', () => {
    const parser = createSseParser();
    expect(parser.push('data: a\r\n\r\n')).toEqual([{ data: 'a' }]);
    expect(parser.push('data: b\r\r')).toEqual([{ data: 'b' }]);
  });

  it('注释行（心跳）不产出事件', () => {
    const parser = createSseParser();
    expect(parser.push(': keep-alive\n\n')).toEqual([]);
  });

  it('冒号后只吃一个空格', () => {
    const parser = createSseParser();
    expect(parser.push('data:  two spaces\n\n')).toEqual([{ data: ' two spaces' }]);
  });

  it('没有冒号的 data 行是空字符串', () => {
    const parser = createSseParser();
    expect(parser.push('data\n\n')).toEqual([{ data: '' }]);
  });

  it('event 字段被记录，未知字段被忽略', () => {
    const parser = createSseParser();
    expect(parser.push('event: message\nid: 7\nretry: 100\ndata: x\n\n')).toEqual([{ data: 'x', event: 'message' }]);
  });

  it('只有 event 没有 data 的帧被丢弃', () => {
    const parser = createSseParser();
    expect(parser.push('event: ping\n\n')).toEqual([]);
  });

  it('flush 把没有空行收尾的残行成帧', () => {
    const parser = createSseParser();
    expect(parser.push('data: [DONE]')).toEqual([]);
    expect(parser.flush()).toEqual([{ data: '[DONE]' }]);
  });

  it('flush 之后状态清零，可以继续用', () => {
    const parser = createSseParser();
    parser.push('data: a\n\n');
    parser.flush();
    expect(parser.push('data: b\n\n')).toEqual([{ data: 'b' }]);
  });

  it('空块不产出事件', () => {
    const parser = createSseParser();
    expect(parser.push('')).toEqual([]);
  });
});

describe('parseSseStream', () => {
  it('把块流串成事件流，并在末尾 flush', async () => {
    const chunks = (async function* (): AsyncGenerator<string> {
      yield 'data: 1\n\ndata: ';
      yield '2\n\n';
      yield 'data: 3';
    })();

    const events: SseEvent[] = [];
    for await (const event of parseSseStream(chunks)) {
      events.push(event);
    }

    expect(events).toEqual([{ data: '1' }, { data: '2' }, { data: '3' }]);
  });

  it('空流没有事件', async () => {
    const chunks = (async function* (): AsyncGenerator<string> {
      // 故意不产出任何块。
    })();

    const events: SseEvent[] = [];
    for await (const event of parseSseStream(chunks)) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });
});
