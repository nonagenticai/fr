// src/workers/project-request-analysis-timeout.ts
//
// Recovers project requests stranded in `analysing`.
//
// Submit flips a request to `analysing` after the n8n analysis webhook accepted
// the dispatch (routes/project-request-lifecycle.ts). From then on the ONLY way
// out is the agent's callback, POST /api/webhooks/n8n/project-request-outline/:id.
// If the workflow fails, is deactivated, or n8n restarts mid-run, no callback
// ever arrives — fr has no outbox and no job queue — and the request sits in
// `analysing` forever, with the requester told analysis is under way.
//
// This worker turns that silence into a visible, recoverable state: after
// PROJECT_REQUEST_ANALYSIS_TTL_MS without progress the request goes to `failed`
// with error `analysis_timeout` and a history entry. `failed` is a SUBMIT source
// (EVENT_SOURCES.submit), so the requester can re-submit.
//
// Concurrency: no advisory lock. The whole tick is ONE conditional UPDATE whose
// WHERE re-checks `status = 'analysing'` on the row it locks, so two replicas
// ticking together fail each row at most once, and an outline that lands
// between SELECT and UPDATE cannot be overwritten — there is no SELECT.
//
// Clock: `updated_at` is stamped by the dispatch transition itself, so the TTL
// measures time since dispatch (or since the last write to the row).

import { and, eq, lt } from 'drizzle-orm';

import { db as defaultDb } from '../db/client';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { projectRequests } from '../db/schema';
import { appendHistorySql } from '../routes/project-request-history';
import { eventSources } from '../routes/project-request-lifecycle';

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export const ANALYSIS_TIMEOUT_ERROR = 'analysis_timeout';

export interface AnalysisTimeoutTickResult {
  outcome: 'ok' | 'failed';
  timedOut: string[];
  error?: string;
}

function ttlMs(): number {
  const raw = Number(process.env.PROJECT_REQUEST_ANALYSIS_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_TTL_MS;
}

/** One sweep. TTL: PROJECT_REQUEST_ANALYSIS_TTL_MS (read per call). */
export async function runProjectRequestAnalysisTimeoutTick(): Promise<AnalysisTimeoutTickResult> {
  const db = defaultDb;
  const now = new Date();
  const cutoff = new Date(now.getTime() - ttlMs());
  const [from] = eventSources('analysis_timeout');
  try {
    const rows = await db
      .update(projectRequests)
      .set({
        status: 'failed',
        error: ANALYSIS_TIMEOUT_ERROR,
        updated_at: now,
        history: appendHistorySql({
          at: now.toISOString(),
          action: 'analysis_timed_out',
          by: 'system:project-request-analysis-timeout',
          from_status: from,
          detail: `no outline within ${Math.round((now.getTime() - cutoff.getTime()) / 60_000)} min of dispatch`,
        }),
      })
      .where(and(eq(projectRequests.status, from!), lt(projectRequests.updated_at, cutoff)))
      .returning({ id: projectRequests.id });
    return { outcome: 'ok', timedOut: rows.map((r) => r.id) };
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'project-request-analysis-timeout',
      degradedTo: 'no requests timed out this tick (retried next tick)',
    });
    return {
      outcome: 'failed',
      timedOut: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** Idempotent. Interval override: PROJECT_REQUEST_ANALYSIS_TIMEOUT_INTERVAL_MS. */
export function startProjectRequestAnalysisTimeoutWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(
    process.env.PROJECT_REQUEST_ANALYSIS_TIMEOUT_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[project-request-analysis-timeout] interval invalid, refusing to start');
    return;
  }
  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const r = await runProjectRequestAnalysisTimeoutTick();
      if (r.timedOut.length > 0 || r.outcome === 'failed') {
        console.log(
          `[project-request-analysis-timeout] outcome=${r.outcome} timed_out=${r.timedOut.length}` +
            (r.timedOut.length ? ` ids=${r.timedOut.join(',')}` : '') +
            (r.error ? ` error=${r.error}` : ''),
        );
      }
    } finally {
      tickInFlight = false;
    }
  };
  void runOnce();
  timer = setInterval(() => void runOnce(), intervalMs);
  console.log(`[project-request-analysis-timeout] scheduler started, interval=${intervalMs}ms ttl=${ttlMs()}ms`);
}

export function stopProjectRequestAnalysisTimeoutWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
