// src/lib/components/observability/livenessLogic.ts
//
// Pure helpers backing the REST-polled `observability/LivenessBadge.svelte`.
// Kept separate from the `.svelte` file so they can be unit-tested under
// `bun test` / vitest's default `node` environment without spinning up a
// jsdom component-render harness.
//
// Plan: docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md
//   §"Open follow-ups" — global ActivityTray + LivenessBadge mount.

/**
 * Backend `/api/tools/kanban/liveness` returns this shape under `data`.
 * Mirrors `LivenessSummary` in `backend/src/routes/tools/kanban.ts`.
 */
export interface KanbanLivenessSnapshot {
  status: 'live' | 'stale' | 'disconnected' | string;
  subscribers: number;
  max_lag_seconds: number;
  last_broadcast_seq?: number;
}

export interface BadgeView {
  /** Coarse two-bucket label used by the compact badge. */
  bucket: 'live' | 'idle';
  /** Status string from the snapshot, lower-cased and trimmed. */
  rawStatus: string;
  /** Human-readable label (e.g. "Live", "Idle", "Stale 32s"). */
  label: string;
  /** Subscriber count, defaulted to 0 when missing/non-finite. */
  subscriberCount: number;
  /** Max lag seconds, defaulted to 0 when missing/non-finite. */
  maxLagSeconds: number;
}

/**
 * Reduce an UNREADABLE liveness read to a badge view.
 *
 * ⚠️ WHY THIS IS NOT `snapshotToBadgeView(null)`.
 *
 * A null snapshot has two causes that the tray collapsed into one: the endpoint
 * answered and carried no `data` (nothing is subscribed — a measurement), and
 * the read FAILED (non-2xx or a thrown fetch — no measurement at all). Both
 * produced `{ bucket:'idle', rawStatus:'unknown', subscriberCount: 0 }`, so the
 * andon rendered "0 subscribers, max lag 0s" as a fact about the WS pool it had
 * just failed to reach. On an andon that is the worst possible direction: the
 * surface is calmest exactly when it is blindest.
 *
 * `rawStatus: 'unreadable'` falls through `LivenessPill.badgeStatus`'s default
 * to the `unknown` palette (so no new colour token is introduced) while giving
 * the template a value it can branch on to say the read failed rather than
 * printing a subscriber count nobody counted.
 */
export function unreadableBadgeView(): BadgeView {
  return {
    bucket: 'idle',
    rawStatus: 'unreadable',
    label: 'Unreadable',
    subscriberCount: 0,
    maxLagSeconds: 0,
  };
}

/**
 * Reduce a snapshot to the compact badge view. The badge only distinguishes
 * "live" (kanban WS pool has at least one healthy subscriber) from "idle"
 * (no subscribers, stale lag, or disconnected). Detailed status colours are
 * handled by the sibling `LivenessPill` inside the tray panel.
 */
export function snapshotToBadgeView(
  snap: KanbanLivenessSnapshot | null | undefined,
): BadgeView {
  if (!snap) {
    return {
      bucket: 'idle',
      rawStatus: 'unknown',
      label: 'Unknown',
      subscriberCount: 0,
      maxLagSeconds: 0,
    };
  }
  const raw = String(snap.status ?? 'unknown').toLowerCase();
  const subs = Number.isFinite(snap.subscribers) ? Number(snap.subscribers) : 0;
  const lag = Number.isFinite(snap.max_lag_seconds) ? Number(snap.max_lag_seconds) : 0;
  if (raw === 'live') {
    return {
      bucket: 'live',
      rawStatus: raw,
      label: 'Live',
      subscriberCount: subs,
      maxLagSeconds: lag,
    };
  }
  if (raw === 'stale') {
    return {
      bucket: 'idle',
      rawStatus: raw,
      label: `Stale ${Math.round(lag)}s`,
      subscriberCount: subs,
      maxLagSeconds: lag,
    };
  }
  if (raw === 'disconnected') {
    return {
      bucket: 'idle',
      rawStatus: raw,
      label: 'Idle',
      subscriberCount: subs,
      maxLagSeconds: lag,
    };
  }
  return {
    bucket: 'idle',
    rawStatus: raw,
    label: raw.length > 0 ? raw : 'Unknown',
    subscriberCount: subs,
    maxLagSeconds: lag,
  };
}

/**
 * Count executions whose `started_at` falls within the last `windowMs`.
 * Used by the tray panel to render "n executions in last hour".
 *
 * Items without a parseable `started_at` are treated as "not in window" so
 * stuck/queued runs don't inflate the freshness indicator.
 */
export function countWithinLastMs(
  rows: ReadonlyArray<{ started_at?: string | undefined | null }>,
  now: number,
  windowMs: number,
): number {
  const cutoff = now - windowMs;
  let n = 0;
  for (const r of rows) {
    if (!r.started_at) continue;
    const t = Date.parse(r.started_at);
    if (!Number.isFinite(t)) continue;
    if (t >= cutoff) n += 1;
  }
  return n;
}
