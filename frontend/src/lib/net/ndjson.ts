// src/lib/net/ndjson.ts
//
// parseNdjson — async iterator over a fetch Response body that yields one
// parsed value per newline-delimited JSON line.
//
// Correctness contract:
//   - Buffers across chunk boundaries (lines may straddle Uint8Array chunks).
//   - Flushes the TextDecoder on stream end to drain pending multi-byte UTF-8.
//   - Accepts both LF and CRLF line endings.
//   - Surfaces malformed lines as { ok: false, raw, error } so callers decide
//     whether to log/skip/abort. (Silent catch is the bug we're avoiding.)
//   - Yields the final non-empty buffer when the stream ends without a
//     trailing newline.
//   - Skips blank lines silently.

export type NdjsonParsedValue<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; raw: string; error: unknown };

export async function* parseNdjson<T = unknown>(
  stream: ReadableStream<Uint8Array>,
): AsyncIterableIterator<NdjsonParsedValue<T>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        // Drain any pending multi-byte UTF-8 bytes still inside the decoder.
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Split on LF or CRLF; keep the trailing partial line in `buffer`.
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') continue;
        try {
          yield { ok: true, value: JSON.parse(line) as T };
        } catch (error) {
          yield { ok: false, raw: line, error };
        }
      }
    }

    // Tail: final non-empty buffer (no trailing newline case). A bare CR
    // can be left over if the stream ended mid-CRLF; trim it before parsing.
    const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (tail !== '') {
      try {
        yield { ok: true, value: JSON.parse(tail) as T };
      } catch (error) {
        yield { ok: false, raw: tail, error };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
