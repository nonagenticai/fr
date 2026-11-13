// fr/backend/src/domain/bridge/sources/output-cache.ts
//
// ONE per-process output LRU for every bridge producer, keyed by the CALLER'S
// SCOPE as well as the output id.
//
// THE DEFECT THIS CLOSES. The kag / artifacts / coding sources each held a
// module-level `Map` keyed only by `output_id`, and `getOutput` returned a hit
// with no scope check. `drafts.ts` calls `getOutput(ctx.request, outputId)` for
// every id in a create request, so tenant B naming an id that tenant A had just
// listed got A's cached output copied into B's draft — no upstream call, no
// authorisation, nothing in B's context consulted.
//
// The fix is structural rather than a check on hit: the key carries
// `tenantId|userId`, so B's lookup of A's id is a plain MISS and falls through
// to the producer's normal upstream path, which runs with B's context.
//
// ⚠️ A context with no tenantId OR no userId is NOT cached at all (put is a
// no-op, get always misses). An empty scope would otherwise become one shared
// bucket for every unscoped caller — the same leak with a different key.

import type { RequestContext } from '../../../integrations/_lib/context';
import type { ToolOutput } from '../types';

export interface ScopedOutputCache {
  put(ctx: RequestContext, output: ToolOutput): void;
  get(ctx: RequestContext, outputId: string): ToolOutput | undefined;
  clear(): void;
}

function scopeOf(ctx: RequestContext): string | null {
  if (!ctx.tenantId || !ctx.userId) return null;
  return `${ctx.tenantId}|${ctx.userId}`;
}

export function createScopedOutputCache(
  producer: string,
  max = 1024,
): ScopedOutputCache {
  const entries = new Map<string, ToolOutput>();
  const keyFor = (ctx: RequestContext, outputId: string): string | null => {
    const scope = scopeOf(ctx);
    return scope === null ? null : `${producer}|${scope}|${outputId}`;
  };
  return {
    put(ctx, output) {
      const k = keyFor(ctx, output.output_id);
      if (k === null) return;
      if (entries.has(k)) entries.delete(k);
      entries.set(k, output);
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get(ctx, outputId) {
      const k = keyFor(ctx, outputId);
      return k === null ? undefined : entries.get(k);
    },
    clear() {
      entries.clear();
    },
  };
}
