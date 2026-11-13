// src/routes/chat/chat-stream.test.ts
//
// Verifies the chat page's stream-handling helper buffers correctly across
// chunk boundaries. The upstream is SSE (text/event-stream) — frames are
// `data: <json>\n\n`, terminated by `data: [DONE]\n\n`.

import { describe, it, expect } from 'vitest';
import { streamChatEvents, type ChatStreamEvent, type StreamChatOptions } from './streamChat';

const enc = new TextEncoder();

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  opts?: StreamChatOptions,
): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const ev of streamChatEvents(stream, opts)) out.push(ev);
  return out;
}

describe('streamChatEvents (SSE chat-completions parser)', () => {
  it('yields ordered delta + done frames in a single chunk', async () => {
    const events = await collect(
      streamOf('data: {"delta":"hi"}\n\ndata: {"delta":"!"}\n\ndata: [DONE]\n\n'),
    );
    expect(events).toEqual([
      { kind: 'delta', delta: 'hi' },
      { kind: 'delta', delta: '!' },
      { kind: 'done' },
    ]);
  });

  it('reassembles a frame whose payload is split mid-JSON across two chunks', async () => {
    // Chunk 1 ends mid-JSON; chunk 2 completes it AND starts the next frame.
    const events = await collect(
      streamOf(
        'data: {"delta":"hi"',
        '}\n\ndata: {"delta":"!"',
        '}\n\ndata: [DONE]\n\n',
      ),
    );
    expect(events).toEqual([
      { kind: 'delta', delta: 'hi' },
      { kind: 'delta', delta: '!' },
      { kind: 'done' },
    ]);
  });

  it('reassembles a frame whose separator is split across two chunks', async () => {
    // The `\n\n` separator itself straddles chunk boundary.
    const events = await collect(
      streamOf(
        'data: {"delta":"a"}\n',
        '\ndata: {"delta":"b"}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    expect(events).toEqual([
      { kind: 'delta', delta: 'a' },
      { kind: 'delta', delta: 'b' },
      { kind: 'done' },
    ]);
  });

  it('passes through meta frames before done', async () => {
    const events = await collect(
      streamOf(
        'data: {"delta":"x"}\n\n',
        'data: {"meta":{"pp_tps":12.5,"output_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    expect(events).toEqual([
      { kind: 'delta', delta: 'x' },
      { kind: 'meta', meta: { pp_tps: 12.5, output_tokens: 1 } },
      { kind: 'done' },
    ]);
  });

  it('stops yielding after [DONE] even if more bytes arrive', async () => {
    const events = await collect(
      streamOf('data: {"delta":"only"}\n\ndata: [DONE]\n\ndata: {"delta":"ignored"}\n\n'),
    );
    expect(events).toEqual([
      { kind: 'delta', delta: 'only' },
      { kind: 'done' },
    ]);
  });

  it('parses a result frame carrying a boolean validated value', async () => {
    const events = await collect(
      streamOf(
        'data: {"delta":"t"}\n\ndata: {"delta":"rue"}\n\n',
        'data: {"result":true,"schema":{"type":"boolean"}}\n\n',
        'data: {"meta":{"output_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    expect(events).toEqual([
      { kind: 'delta', delta: 't' },
      { kind: 'delta', delta: 'rue' },
      { kind: 'result', value: true, schema: { type: 'boolean' } },
      { kind: 'meta', meta: { output_tokens: 1 } },
      { kind: 'done' },
    ]);
  });

  it('parses a result frame carrying an array validated value', async () => {
    const events = await collect(
      streamOf(
        'data: {"result":["red","green","blue"],"schema":{"type":"array","items":{"type":"string"}}}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    expect(events[0]).toEqual({
      kind: 'result',
      value: ['red', 'green', 'blue'],
      schema: { type: 'array', items: { type: 'string' } },
    });
  });

  it('parses a result frame carrying an object validated value', async () => {
    const events = await collect(
      streamOf(
        'data: {"result":{"answer":"yes","confidence":0.9},"schema":{"type":"object","properties":{"answer":{"type":"string"}}}}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    expect(events[0]).toEqual({
      kind: 'result',
      value: { answer: 'yes', confidence: 0.9 },
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
    });
  });

  it('treats a falsy validated value as a present result, not a missing key', async () => {
    // Regression: `if (obj.result)` would miss `false` / `0` / `""`. The
    // parser must use `'result' in obj` (key-presence) instead.
    const events = await collect(
      streamOf(
        'data: {"result":false,"schema":{"type":"boolean"}}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    expect(events[0]).toEqual({
      kind: 'result',
      value: false,
      schema: { type: 'boolean' },
    });
  });

  it('defaults missing schema to an empty object so the renderer falls through to TextResult', async () => {
    const events = await collect(
      streamOf('data: {"result":42}\n\n', 'data: [DONE]\n\n'),
    );
    expect(events[0]).toEqual({ kind: 'result', value: 42, schema: {} });
  });

  it('does not emit a result event when the frame has no result key', async () => {
    // Free-text path: only deltas + meta + done — never result.
    const events = await collect(
      streamOf(
        'data: {"delta":"plain"}\n\ndata: {"meta":{"output_tokens":1}}\n\ndata: [DONE]\n\n',
      ),
    );
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });

  it('surfaces a malformed JSON payload without aborting the stream', async () => {
    const events = await collect(
      streamOf(
        'data: {"delta":"good"}\n\n',
        'data: not-json\n\n',
        'data: {"delta":"after"}\n\n',
        'data: [DONE]\n\n',
      ),
    );
    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ kind: 'delta', delta: 'good' });
    expect(events[1].kind).toBe('malformed');
    if (events[1].kind === 'malformed') expect(events[1].raw).toBe('not-json');
    expect(events[2]).toEqual({ kind: 'delta', delta: 'after' });
    expect(events[3]).toEqual({ kind: 'done' });
  });
});

// worker_management keeps `error` a string on the SSE stream and puts
// `error_code` / `status` / `details` beside it. A BYO code becomes an
// actionable sentence; the code rides along.
describe('streamChatEvents — WM BYO error frames', () => {
  it('maps a BYO error frame to the user sentence and keeps the code', async () => {
    const frame = JSON.stringify({
      error: 'openai rejected the call with this key: 401',
      error_code: 'BYO_PROVIDER_CALL_FAILED',
      status: 502,
      provider: 'openai',
    });
    const events = await collect(streamOf(`data: ${frame}\n\n`, 'data: [DONE]\n\n'));
    expect(events[0]).toEqual({
      kind: 'error',
      code: 'BYO_PROVIDER_CALL_FAILED',
      raw: 'openai rejected the call with this key: 401',
      message:
        "openai rejected the request made with your workspace's key. Check the key and the provider account in Settings → LLM provider.",
    });
  });

  // fr#1409: WM's non-BYO frame carries the upstream exception text in
  // `error` (`redact_secrets_in_text(str(exc))`). It must never become the
  // renderable `message`; it is kept apart in `raw` for the console.
  it('a non-BYO error frame gets the neutral send text; the upstream text stays in raw', async () => {
    const upstream = 'Error code: 500 - {"detail":"x"}';
    const events = await collect(
      streamOf(`data: ${JSON.stringify({ error: upstream, provider: 'prov_a' })}\n\n`),
    );
    expect(events[0]).toEqual({
      kind: 'error',
      message: "Couldn't send the message. Try again.",
      raw: upstream,
    });
  });

  it('PROVIDER_BUSY gets a fixed busy line with the provider label, never the exception', async () => {
    const frame = JSON.stringify({
      error: 'Provider busy: queue slot wait exceeded 30s (ir-pod 10.42.0.9)',
      error_code: 'PROVIDER_BUSY',
      status: 503,
      provider: 'prov_a',
      details: { retry_after: 5 },
    });
    const events = await collect(streamOf(`data: ${frame}\n\n`), { providerLabel: 'Prov A' });
    expect(events[0]).toEqual({
      kind: 'error',
      code: 'PROVIDER_BUSY',
      message: 'Prov A is busy right now. Try again shortly.',
      raw: 'Provider busy: queue slot wait exceeded 30s (ir-pod 10.42.0.9)',
    });
    const noLabel = await collect(streamOf(`data: ${frame}\n\n`));
    expect(noLabel[0].kind === 'error' && noLabel[0].message).toBe(
      'The provider is busy right now. Try again shortly.',
    );
  });
});
