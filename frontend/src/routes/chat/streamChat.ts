// src/routes/chat/streamChat.ts
//
// Extracted stream-handling helper for the chat page so it is testable in
// isolation. The upstream `/api/assets/workers/:name/chat/completions`
// endpoint is **SSE** (text/event-stream): each frame is `data: <json>\n\n`,
// terminated by `data: [DONE]\n\n`. See worker_management
// `src/api/providers/_chat_router.py:179-254`. This is NOT NDJSON — using
// `parseNdjson` here would treat every `data: {...}` line as malformed.
//
// Buffering rule: split the rolling buffer on the SSE frame separator
// `\n\n`; the trailing partial frame is preserved across reads. Lines
// inside a frame are only meaningful when they start with `data:`.

import { providerBusyText, SEND_ERROR_TEXT, wmByoErrorMessage } from '$lib/workers/wm-errors';

export type ChatStreamEvent =
  | { kind: 'delta'; delta: string }
  | { kind: 'meta'; meta: Record<string, unknown> }
  // Emitted exactly once by WM (`_chat_router.py::_sse_stream`) between the
  // last `delta` and the `meta` frame when the request carried an
  // `output_schema`. `value` is the validated typed output (boolean / array /
  // object); `schema` echoes the same fragment the client sent so the
  // renderer doesn't need to remember it across history navigation.
  | { kind: 'result'; value: unknown; schema: Record<string, unknown> }
  // `message` is the ONLY field a page may render (fr#1409): WM's BYO error
  // codes (worker_management#316) become an actionable sentence, PROVIDER_BUSY
  // a fixed busy line, and anything else SEND_ERROR_TEXT. WM's own `error`
  // string (exception text such as `Error code: 500 - {...}`) is kept apart in
  // `raw` for the console only. `code` keeps WM's `error_code` when it sent one.
  | { kind: 'error'; message: string; raw: string; code?: string }
  | { kind: 'done' }
  | { kind: 'malformed'; raw: string; error: unknown };

/**
 * Iterate the SSE-encoded chat-completions response body, yielding parsed
 * frame events. Stops after a `[DONE]` sentinel. Caller is responsible for
 * cancelling the underlying reader (via the upstream AbortSignal).
 */
export interface StreamChatOptions {
  /** Display label of the provider the request went to (PROVIDER_BUSY copy). */
  providerLabel?: string;
}

export async function* streamChatEvents(
  body: ReadableStream<Uint8Array>,
  opts: StreamChatOptions = {},
): AsyncIterableIterator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Drain pending UTF-8.
        buf += decoder.decode();
        break;
      }
      buf += decoder.decode(value, { stream: true });

      // Split on SSE frame separator. Keep the trailing partial frame.
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';

      for (const frame of frames) {
        const ev = parseFrame(frame, opts);
        if (!ev) continue;
        yield ev;
        if (ev.kind === 'done') return;
      }
    }

    // Tail flush: any remaining frame without a trailing blank line.
    const tail = buf;
    if (tail.length > 0) {
      const ev = parseFrame(tail, opts);
      if (ev) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * Page copy for an SSE error frame. Never derived from `obj.error`: WM puts
 * the upstream exception text there (`Provider busy: <exc>`,
 * `redact_secrets_in_text(str(exc))`, worker_management _chat_router.py).
 */
function streamErrorText(obj: Record<string, unknown>, opts: StreamChatOptions): string {
  const byo = wmByoErrorMessage(obj);
  if (byo) return byo;
  if (obj.error_code === 'PROVIDER_BUSY') return providerBusyText(opts.providerLabel);
  return SEND_ERROR_TEXT;
}

function parseFrame(frame: string, opts: StreamChatOptions): ChatStreamEvent | null {
  const line = frame.trim();
  if (!line) return null;
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (payload === '') return null;
  if (payload === '[DONE]') return { kind: 'done' };
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    if (typeof obj.error === 'string') {
      // WM keeps `error` a string and puts `error_code` / `status` / `details`
      // beside it (worker_management _chat_router.py).
      const code = typeof obj.error_code === 'string' ? obj.error_code : undefined;
      const message = streamErrorText(obj, opts);
      const raw = obj.error;
      return code ? { kind: 'error', message, raw, code } : { kind: 'error', message, raw };
    }
    if (typeof obj.delta === 'string') {
      return { kind: 'delta', delta: obj.delta };
    }
    if (obj.meta && typeof obj.meta === 'object') {
      return { kind: 'meta', meta: obj.meta as Record<string, unknown> };
    }
    // `result` may be any JSON value (incl. `false` / `0` / `""`), so check
    // for key presence rather than truthiness. `schema` is always an object
    // when WM emits the frame, but defend with a default for forwards-compat.
    if ('result' in obj) {
      const schema =
        obj.schema && typeof obj.schema === 'object' && !Array.isArray(obj.schema)
          ? (obj.schema as Record<string, unknown>)
          : {};
      return { kind: 'result', value: obj.result, schema };
    }
    return null;
  } catch (error) {
    return { kind: 'malformed', raw: payload, error };
  }
}
