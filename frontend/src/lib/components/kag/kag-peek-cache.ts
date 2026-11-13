/**
 * Hover-peek provenance cache + debouncer.
 *
 * The graph canvas fires an `onpeek(node, x, y)` on every mouse enter/move over
 * a node. Turning each of those into a `/ask` call would hammer the RAG
 * endpoint, so this module:
 *   · debounces — only fetch once the cursor RESTS on a node (default 350ms);
 *   · caches — a label's provenance is fetched at most once per session;
 *   · dedupes in-flight — concurrent requests for the same label share a promise.
 *
 * It lives at module scope (not inside a component) so the cache survives the
 * canvas's full teardown/rebuild on every re-render, and is shared with the
 * detail drawer's "Sources" section.
 */

import { kagGraphApi, type KagRecord } from '$lib/api/kag';

export interface PeekResult {
  answer?: string;
  chunks: KagRecord[];
}

const cache = new Map<string, PeekResult>();
const inflight = new Map<string, Promise<PeekResult>>();

/** Fetch (or return cached) source provenance for a concept label. */
export function peekProvenance(label: string): Promise<PeekResult> {
  const cached = cache.get(label);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(label);
  if (pending) return pending;

  const p = kagGraphApi
    .provenance(label)
    .then((r) => {
      const v: PeekResult = { answer: r.answer, chunks: r.chunks };
      cache.set(label, v);
      inflight.delete(label);
      return v;
    })
    .catch((e) => {
      inflight.delete(label);
      throw e;
    });
  inflight.set(label, p);
  return p;
}

export interface PeekCallbacks {
  /** Fires when the debounce elapses and a fetch is about to run. */
  onStart?: () => void;
  onDone: (result: PeekResult) => void;
  onError?: (err: unknown) => void;
}

/**
 * A single-slot debouncer: `schedule(label, cbs)` cancels any pending fetch and
 * arms a new one; `onDone`/`onError` only fire if `label` is still the current
 * target when the fetch resolves (so a fast move to another node wins).
 */
export function createPeekDebouncer(ms = 350) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: string | null = null;

  return {
    schedule(label: string, cbs: PeekCallbacks) {
      if (timer) clearTimeout(timer);
      current = label;
      timer = setTimeout(() => {
        const target = label;
        cbs.onStart?.();
        peekProvenance(target)
          .then((v) => {
            if (current === target) cbs.onDone(v);
          })
          .catch((e) => {
            if (current === target) cbs.onError?.(e);
          });
      }, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
    },
  };
}
