/**
 * Omni-Skill-Proxy - stream_stripper （流式响应过滤器）
 *
 * 拦截上游返回的 SSE 流：动态识别 ``` 代码块边界；代码块之外的废话前缀
 * （"好的"、"当然可以"、"以下是代码"、"Sure, here's" …）直接丢弃；进入
 * 代码块或遇到关键内容后无缝透传给客户端。
 *
 * Intercepts upstream SSE streams: tracks ``` code-fence boundaries live,
 * drops chatter outside the fences, and passes code through untouched.
 * Zero dependencies: only Node's `stream`, `http` and `StringDecoder`.
 */

import { Transform, TransformCallback } from 'stream';
import { StringDecoder } from 'string_decoder';
import { ApiFormat } from './types';

/* ------------------------------------------------------------------ *
 * 1. Filler phrase tables / 废话词表                                  *
 * ------------------------------------------------------------------ */

// 中文废话前缀（按归一化后的核心文本匹配 / matched against normalized core）
const FILLERS_ZH = [
  '好的', '好嘞', '当然可以', '当然', '没问题', '必须的', '收到', '了解', '明白',
  '嗯嗯', '嗯', '诶', '是啊', '对的', '可以',
  '以下是', '以下为', '下面是', '下面为', '如下', '这是', '这就是', '这是你的',
  '这是你要的', '你要的', '你的代码', '给你的', '你需要的', '需要的就是',
  '让我', '我来', '我会', '我帮', '帮你', '为您', '我们可以', '我们先',
  '首先', '其次', '然后', '接着', '最后', '稍等', '马上', '马上好', '开始',
  '关于', '对于', '针对', '这个', '那', '那么', '所以', '因此',
  '解释', '解释一下', '说明', '说明一下', '简单来说', '通俗地说', '比如',
  '举个例子', '例如', '总结一下', '概括来说', '核心是', '关键在于',
  '题目', '这个问题', '这种', '用法', '效果', '结果', '答案', '示例',
  '代码', '完整代码', '最终代码', '修改后的代码', '实现如下', '代码如下',
  '希望对你有帮助', '希望可以帮到你', '希望对你有用', '如有问题', '欢迎随时',
  '随时问我', '有问题随时', '谢谢', '感谢', '感谢支持', '祝你',
];

// 英文废话前缀（已小写、去空格 / lowercased, whitespace removed）
const FILLERS_EN = [
  'sure', 'surething', 'sure!', 'ofcourse', 'certainly', 'absolutely',
  'definitely', 'great', 'perfect', 'okay', 'ok', 'sounds good', 'no problem',
  'noproblem', 'noprob', 'you got it', 'yougotit', 'here you go', 'hereyougo',
  'hereis', 'heres', 'below is', 'belowis', 'beloware', 'the following',
  'thefollowing', 'your code', 'yourcode', 'the code', 'thecode', 'this code',
  'thiscode', 'the result', 'theresult', 'the answer', 'theanswer',
  'let me', 'letme', "let's", 'lets', 'i will', 'iwill', "i'll", 'ill',
  'i am going', 'iamgoing', 'i can', 'ican', 'as requested', 'asrequested',
  'happy to help', 'happytohelp', 'hope this helps', 'hopethishelps',
  'hopeit helps', 'hopeithelps', 'enjoy', 'cheers', 'thanks', 'thankyou',
  'first', 'firstly', 'secondly', 'next', 'then', 'finally', 'so', 'well',
  'basically', 'to begin', 'tobegin', 'to start', 'tostart', 'in short',
  'inshort', 'for example', 'forexample', 'for instance', 'forinstance',
  'as you can see', 'as shown', 'here we have',
  'note that', 'just', 'simply',
];

// 去重 + 归一化（与正文相同的归一化：去空白/标点/符号、小写）后使用
const FILLER_SET = new Set(
  [...FILLERS_ZH, ...FILLERS_EN].map((p) => p.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()),
);

/** Max tail (normalized chars) still considered part of a filler preamble. */
const FILLER_TAIL = 24;

/** Remove whitespace, punctuation and symbols (incl. emoji) for matching. */
function normalize(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/**
 * Filler classifier core. Consumes filler phrases recursively; a short tail
 * that itself starts with filler words, or a colon-terminated preamble,
 * still counts as filler.
 */
function isFillerCore(core: string, depth: number, endsColon: boolean): boolean {
  if (core.length === 0) return true;
  if (depth > 4) return false;
  for (const p of FILLER_SET) {
    if (core.startsWith(p)) {
      const rest = core.slice(p.length);
      if (rest.length === 0) return true;
      if (rest.length <= FILLER_TAIL) {
        if (isFillerCore(rest, depth + 1, endsColon)) return true;
        if (endsColon) return true; // "好的，这是你要的代码：" 形如冒号收尾
      }
    }
  }
  return false;
}

type Verdict = 'filler' | 'meaningful';

/* ------------------------------------------------------------------ *
 * 2. TextStripper - the streaming text state machine                  *
 * ------------------------------------------------------------------ */

/**
 * State machine over one logical text stream.
 *
 * - Outside a code fence: text is buffered in `pending`. A fence flushes the
 *   buffer - filler preamble is dropped, meaningful prose is emitted first.
 * - Inside a code fence: everything passes through verbatim, except a
 *   possible partial closing fence held back at the tail.
 * - After a code fence has closed: everything is dropped (silence rule) until
 *   a new fence reopens code mode.
 * - `flush()` is called once at end-of-stream and decides the fate of any
 *   still-buffered text.
 */
export class TextStripper {
  private pending = '';
  private inCode = false;
  /**
   * True once a closing fence has been emitted. Per the injected rule
   * ("stop right after the closing fence, add nothing after it"), everything
   * after a delivered code block is dropped unless a NEW fence reopens code
   * mode. Only a possible partial fence (``) is held back so it can still
   * complete.
   */
  private afterCode = false;
  private readonly maxHoldChars: number;

  constructor(maxHoldChars = 200) {
    this.maxHoldChars = maxHoldChars > 0 ? maxHoldChars : 200;
  }

  /** Feed the next chunk of assistant text; return what may be emitted now. */
  feed(text: string): string {
    this.pending += text;
    return this.pump();
  }

  /** End of stream: emit any remaining meaningful text, drop trailing filler. */
  flush(): string {
    if (this.pending.length === 0) return '';
    if (this.inCode) {
      // Stream ended inside a code block: release everything we held back.
      const out = this.pending;
      this.pending = '';
      return out;
    }
    if (this.afterCode) {
      // A code block was already delivered - trailing chatter never ships.
      this.pending = '';
      return '';
    }
    const held = this.trailingBackticks(this.pending);
    const candidate = held > 0 ? this.pending.slice(0, this.pending.length - held) : this.pending;
    const out = this.classify(candidate) === 'meaningful' ? candidate : '';
    this.pending = '';
    return out;
  }

  /** True when the machine is currently inside a code fence. */
  get insideCode(): boolean {
    return this.inCode;
  }

  private pump(): string {
    let out = '';
    for (;;) {
      if (this.inCode) {
        const idx = this.pending.indexOf('```');
        if (idx >= 0) {
          out += this.pending.slice(0, idx + 3);
          this.pending = this.pending.slice(idx + 3);
          this.inCode = false;
          this.afterCode = true;
          continue; // reprocess the remainder outside the fence
        }
        // No complete fence: emit all but hold back a possible partial fence.
        const held = this.trailingBackticks(this.pending);
        const cut = this.pending.length - held;
        out += this.pending.slice(0, cut);
        this.pending = this.pending.slice(cut);
        return out;
      }

      // Post-code silence: a code block was already delivered. Drop all
      // chatter that follows; a new fence still reopens code mode.
      if (this.afterCode) {
        const nextFence = this.pending.indexOf('```');
        if (nextFence >= 0) {
          this.pending = this.pending.slice(nextFence); // discard inter-block prose
        } else {
          const held = this.trailingBackticks(this.pending);
          this.pending = held > 0 ? this.pending.slice(this.pending.length - held) : '';
          return out;
        }
      }

      const idx = this.pending.indexOf('```');
      if (idx >= 0) {
        const prefix = this.pending.slice(0, idx);
        if (this.classify(prefix) === 'meaningful') out += prefix;
        out += '```';
        this.pending = this.pending.slice(idx + 3);
        this.inCode = true;
        continue; // inside the fence now
      }

      // No fence yet. Hold back trailing backticks that may complete one.
      const held = this.trailingBackticks(this.pending);
      const candidate = held > 0 ? this.pending.slice(0, this.pending.length - held) : this.pending;
      const verdict = this.classify(candidate);

      if (verdict === 'meaningful') {
        out += candidate;
        this.pending = held > 0 ? this.pending.slice(this.pending.length - held) : '';
        return out;
      }

      // Still filler-shaped: keep buffering, but never starve the client.
      if (this.pending.length > this.maxHoldChars) {
        out += this.pending;
        this.pending = '';
        return out;
      }
      return out;
    }
  }

  private classify(text: string): Verdict {
    const core = normalize(text);
    if (core.length === 0) return 'filler';
    const endsColon = /[:：]$/.test(text.trim());
    return isFillerCore(core, 0, endsColon) ? 'filler' : 'meaningful';
  }

  /** Count trailing backticks (capped at 2; 3 would be a complete fence). */
  private trailingBackticks(s: string): number {
    let n = 0;
    for (let i = s.length - 1; i >= 0 && s[i] === '`' && n < 2; i--) n++;
    return n;
  }
}

/* ------------------------------------------------------------------ *
 * 3. Non-streaming filter / 非流式正文过滤                             *
 * ------------------------------------------------------------------ */

/**
 * Filter a fully-assembled assistant text: keep only the fenced code blocks
 * when any are present, otherwise strip the filler preamble.
 */
export function stripCompletedText(text: string, maxHoldChars = 200): string {
  const stripper = new TextStripper(maxHoldChars);
  const filtered = stripper.feed(text);
  return (filtered + stripper.flush()).trim();
}

/* ------------------------------------------------------------------ *
 * 4. SSE filter stream / SSE 流过滤器                                  *
 * ------------------------------------------------------------------ */

const DONE_MARKER = '[DONE]';

/**
 * A Transform that sits between the upstream socket and the client.
 *
 * It parses upstream SSE line-by-line, extracts the assistant text from each
 * OpenAI `choices[].delta.content` or Anthropic `content_block_delta` event,
 * runs it through a TextStripper, and re-emips well-formed SSE in the same
 * wire format it received. Non-text events (role deltas, tool calls, usage,
 * `[DONE]`) are passed through untouched - the client cannot tell the
 * difference except that the chatter is gone.
 */
export class SseStripTransform extends Transform {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  /** Lines collected for the SSE event currently being assembled. */
  private eventLines: string[] = [];
  /** Transformed output lines for the current event (may be empty = skip). */
  private outLines: string[] = [];
  private readonly stripper: TextStripper;
  private readonly format: ApiFormat;
  /** `data: [DONE]` is withheld until flush so trailing text stays before it. */
  private pendingDone: string | null = null;

  constructor(format: ApiFormat, maxHoldChars = 200) {
    super({ writableObjectMode: false, readableObjectMode: false });
    this.format = format;
    this.stripper = new TextStripper(maxHoldChars);
  }

  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.buffer += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.processLine(line);
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const rest = this.decoder.end();
    if (rest) this.buffer += rest;
    if (this.buffer.length > 0) this.processLine(this.buffer);
    this.finishEvent(true);
    // End of stream: release any held-back text before [DONE] goes out.
    const tail = this.stripper.flush();
    if (tail) this.push(this.wrapOpenAiChunk(tail));
    if (this.pendingDone) this.push(this.pendingDone + '\n\n');
    callback();
  }

  private processLine(line: string): void {
    const raw = line.replace(/\r$/, '');

    if (raw === '') {
      // Blank line terminates an SSE event.
      this.finishEvent(false);
      return;
    }

    if (raw.startsWith(':')) {
      // SSE comment / heartbeat.
      this.outLines.push(raw);
      return;
    }

    if (raw.startsWith('event:')) {
      // Anthropic pairs `event:` with a following `data:` line - buffer it so
      // the pair is emitted or skipped atomically.
      this.eventLines.push(raw);
      return;
    }

    if (raw.startsWith('data:')) {
      const payload = raw.slice(5).trimStart();
      if (payload === DONE_MARKER) {
        this.pendingDone = `data: ${DONE_MARKER}`;
        this.eventLines = [];
        return;
      }
      const replacement = this.transformDataLine(payload);
      if (replacement !== null) {
        // Emit the `event:` line and its (filtered) `data:` line atomically.
        this.outLines = this.outLines.concat(this.eventLines, replacement);
      }
      // Either way the event/data pair is now decided - never carry it over.
      this.eventLines = [];
      return;
    }

    // Anything else (id:, retry:, stray text): forward verbatim.
    this.outLines = this.outLines.concat(this.eventLines, raw);
    this.eventLines = [];
  }

  /** End of an SSE event: emit its lines if any survived filtering. */
  private finishEvent(final: boolean): void {
    if (this.eventLines.length > 0 && !final) {
      // Dangling `event:` line without its data line so far: keep buffering.
      this.outLines = this.outLines.concat(this.eventLines);
      this.eventLines = [];
    }
    if (this.outLines.length > 0) {
      this.push(this.outLines.join('\n') + '\n\n');
      this.outLines = [];
    } else if (final) {
      // nothing to emit
    }
  }

  /**
   * Transform one `data:` JSON payload. Returns the replacement line, or null
   * when the event is pure chatter and should be swallowed entirely.
   */
  private transformDataLine(payload: string): string | null {
    let obj: any;
    try {
      obj = JSON.parse(payload);
    } catch {
      return `data: ${payload}`; // not JSON: forward untouched
    }

    const shape = this.detectShape(obj);
    if (shape === 'anthropic') {
      const delta = obj && obj.delta;
      if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
        const filtered = this.stripper.feed(delta.text);
        if (!filtered) return null;
        return `data: ${JSON.stringify({ ...obj, delta: { ...delta, text: filtered } })}`;
      }
      return `data: ${JSON.stringify(obj)}`;
    }

    if (shape === 'openai') {
      const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : undefined;
      const delta = choice && choice.delta;
      if (delta && typeof delta.content === 'string') {
        const filtered = this.stripper.feed(delta.content);
        if (!filtered) return null;
        delta.content = filtered;
        return `data: ${JSON.stringify(obj)}`;
      }
      return `data: ${JSON.stringify(obj)}`;
    }

    return `data: ${JSON.stringify(obj)}`;
  }

  /** Detect the wire shape of a parsed payload (explicit format wins). */
  private detectShape(obj: any): 'openai' | 'anthropic' | 'other' {
    if (this.format === 'anthropic' || (obj && obj.type === 'content_block_delta')) {
      return 'anthropic';
    }
    if (this.format === 'openai' || (obj && Array.isArray(obj.choices))) {
      return 'openai';
    }
    return 'other';
  }

  /** Wrap leftover text as a final OpenAI-shaped chunk (used at flush time). */
  private wrapOpenAiChunk(text: string): string {
    if (this.format === 'anthropic') {
      const data = JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      });
      return `event: content_block_delta\ndata: ${data}\n\n`;
    }
    const data = JSON.stringify({
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
    return `data: ${data}\n\n`;
  }
}
