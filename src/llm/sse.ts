/**
 * SSE（`text/event-stream`）解析：把字节流还原成一条条 `data`。
 *
 * 为什么要单独一层：网络给的是**任意切分**的文本块，一次 `push` 可能只拿到半行
 * （`data: {"choi`），也可能一次拿到三条完整事件。解析器只负责「攒行 → 按空行成帧」，
 * 不懂 JSON、不懂 OpenAI 协议 —— 那是 `llm-client.ts` 的事。
 *
 * 只实现本场景用得到的部分（按 SSE 规范）：`data` / `event` 字段、冒号注释行、
 * 空行成帧、`\r\n` / `\n` / `\r` 三种换行。`id` / `retry` 会被忽略。
 */

/** 一帧事件。`data` 已按规范把多行 `data:` 用 `\n` 连好。 */
export interface SseEvent {
  readonly data: string;
  readonly event?: string;
}

export interface SseParser {
  /** 喂一块文本，返回这次新成帧的事件（可能为空数组）。 */
  push(chunk: string): readonly SseEvent[];
  /** 流结束时调用：把缓冲区里没有以空行收尾的最后一行也成帧。 */
  flush(): readonly SseEvent[];
}

/**
 * 一次换行（含 `\r\n`）的位置。单独拿出来是为了不依赖 `String.prototype.split`
 * 的正则分组行为，让它同时能处理「末尾残行」。
 */
const LINE_BREAK = /\r\n|\n|\r/;

/** `field: value`，冒号后最多吃掉一个空格（SSE 规范允许，且不允许吃更多）。 */
function splitField(line: string): { readonly field: string; readonly value: string } {
  const colon = line.indexOf(':');
  if (colon < 0) {
    // 没有冒号的整行是「字段名 + 空值」，例如单独一行 `data`。
    return { field: line, value: '' };
  }
  const rawValue = line.slice(colon + 1);
  return { field: line.slice(0, colon), value: rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue };
}

export function createSseParser(): SseParser {
  /** 还没遇到换行符的残行。 */
  let partial = '';
  /** 当前帧攒下的 `data` 行，空行时清算。 */
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const takeFrame = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      // 只有 `event:` 没有 `data:` 的帧没有意义，丢掉（但事件名也要清掉）。
      eventName = undefined;
      return undefined;
    }
    const event: SseEvent =
      eventName === undefined ? { data: dataLines.join('\n') } : { data: dataLines.join('\n'), event: eventName };
    dataLines = [];
    eventName = undefined;
    return event;
  };

  const consumeLine = (line: string, events: SseEvent[]): void => {
    if (line === '') {
      const event = takeFrame();
      if (event !== undefined) {
        events.push(event);
      }
      return;
    }
    // `:` 开头是注释（很多服务端用它做保活心跳）。
    if (line.startsWith(':')) {
      return;
    }

    const { field, value } = splitField(line);
    if (field === 'data') {
      dataLines.push(value);
      return;
    }
    if (field === 'event') {
      eventName = value;
    }
  };

  return {
    push(chunk) {
      const events: SseEvent[] = [];
      const segments = (partial + chunk).split(LINE_BREAK);

      // 最后一段一定是「还没收到换行的残行」，留着等下一块。
      partial = segments.pop() ?? '';
      for (const line of segments) {
        consumeLine(line, events);
      }
      return events;
    },

    flush() {
      const events: SseEvent[] = [];
      if (partial !== '') {
        consumeLine(partial, events);
        partial = '';
      }
      const event = takeFrame();
      if (event !== undefined) {
        events.push(event);
      }
      return events;
    },
  };
}

/**
 * 把异步文本块流变成事件流。
 *
 * 解析器是同步的（好测），这层只是把「喂块 / 收尾」接在 `for await` 上，
 * 流结束（或抛错）时都不忘 `flush()`。
 */
export async function* parseSseStream(chunks: AsyncIterable<string>): AsyncGenerator<SseEvent, void, undefined> {
  const parser = createSseParser();
  for await (const chunk of chunks) {
    yield* parser.push(chunk);
  }
  yield* parser.flush();
}
