// src/lib/net/ndjson.test.ts
// Verifies parseNdjson: chunk-boundary buffering, CRLF support, malformed-line
// surfacing, final-line-no-newline handling, and multi-byte UTF-8 split safety.

import { describe, it, expect } from 'vitest';
import { parseNdjson, type NdjsonParsedValue } from './ndjson';

const enc = new TextEncoder();

/** Build a ReadableStream from a list of string chunks (one enqueue each). */
function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      }
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<Uint8Array>): Promise<NdjsonParsedValue<T>[]> {
  const out: NdjsonParsedValue<T>[] = [];
  for await (const item of parseNdjson<T>(stream)) {
    out.push(item);
  }
  return out;
}

describe('parseNdjson', () => {
  it('parses three valid records in a single chunk', async () => {
    const results = await collect<{ n: number }>(
      streamOf('{"n":1}\n{"n":2}\n{"n":3}\n'),
    );
    expect(results).toEqual([
      { ok: true, value: { n: 1 } },
      { ok: true, value: { n: 2 } },
      { ok: true, value: { n: 3 } },
    ]);
  });

  it('reassembles records split across chunk boundaries', async () => {
    const results = await collect<Record<string, number>>(
      streamOf('{"a":1}\n{"b":2', '}\n'),
    );
    expect(results).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it('yields the final line when stream ends without a trailing newline', async () => {
    const results = await collect<Record<string, number>>(
      streamOf('{"a":1}\n{"b":2}'),
    );
    expect(results).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it('surfaces malformed lines as ok:false with raw + error, then resumes', async () => {
    const results = await collect<{ valid: number }>(
      streamOf('{"valid":1}\nnot-json\n{"valid":2}\n'),
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, value: { valid: 1 } });
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) {
      expect(results[1].raw).toBe('not-json');
      expect(results[1].error).toBeInstanceOf(SyntaxError);
    }
    expect(results[2]).toEqual({ ok: true, value: { valid: 2 } });
  });

  it('handles \\r\\n line endings without leaking \\r into the payload', async () => {
    const results = await collect<Record<string, number>>(
      streamOf('{"a":1}\r\n{"b":2}\r\n'),
    );
    expect(results).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
    // Defensive: nothing in the parsed view should retain a CR.
    for (const r of results) {
      if (!r.ok) {
        expect(r.raw).not.toContain('\r');
      }
    }
  });

  it('skips blank lines between records', async () => {
    const results = await collect<{ n: number }>(
      streamOf('{"n":1}\n\n{"n":2}\n'),
    );
    expect(results).toEqual([
      { ok: true, value: { n: 1 } },
      { ok: true, value: { n: 2 } },
    ]);
  });

  it('handles a multi-byte UTF-8 character split across chunks', async () => {
    // 'é' encodes to bytes 0xC3 0xA9. Split between them so chunk 1 ends with
    // a partial UTF-8 sequence; the decoder must hold it across reads.
    const eAcuteBytes = enc.encode('é'); // [0xC3, 0xA9]
    expect(eAcuteBytes).toEqual(new Uint8Array([0xc3, 0xa9]));

    const head = enc.encode('{"a":"');
    const tail = enc.encode('"}\n');

    const chunk1 = new Uint8Array(head.length + 1);
    chunk1.set(head, 0);
    chunk1[head.length] = 0xc3;

    const chunk2 = new Uint8Array(1 + tail.length);
    chunk2[0] = 0xa9;
    chunk2.set(tail, 1);

    const results = await collect<{ a: string }>(streamOf(chunk1, chunk2));
    expect(results).toEqual([{ ok: true, value: { a: 'é' } }]);
  });
});
