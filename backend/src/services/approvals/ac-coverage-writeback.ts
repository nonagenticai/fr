// src/services/approvals/ac-coverage-writeback.ts
//
// U3 R5 writeback: after a `qa.coverage_signoff` approval completes, POST ONE
// `ac_coverage` row per acceptance criterion to the ILS AA-TRACE sink.
//
// Contract: improvement-loop-service `docs/aa-trace-endpoints.md` (PR #226, branch
// feat/u12-aa-trace-sinks), § "POST /api/internal/aa-trace/ac-coverage → ac_coverage";
// record spec AA-TRACE §6.13/§6.14/§6.16.
//   * path  POST {AA_TRACE_SINK_URL}/api/internal/aa-trace/ac-coverage
//   * auth  `X-Internal-Secret: <AA_TRACE_SINK_SECRET>` (`require_internal_or_secret`)
//   * body  `extra='forbid'` — ONLY the documented fields; anything else is 422
//           unknown_field. ⚠️ That is why `recorded_at` is NOT sent although the U3 brief
//           listed it: the sink's AcCoverageRecord has no such field (it stamps its own).
//           counts_*, check_kind, outcome and execution_id must be null on approval rows,
//           so they are omitted.
//   * idempotency  natural key (card_id, criterion_id, coverage_source,
//           coalesce(execution_id, approval_id)): an identical re-POST is `200 replayed`;
//           any differing field is `409 trace_conflict`. So a redelivery MUST resend the
//           byte-identical body. The trace_id is therefore taken from fr#1333's
//           `decided_trace_id` (itself persisted, so every run derives the same value) and
//           copied into the delivery marker by the RECORD step AFTER the first run's POSTs;
//           every later run reuses the marker's copy. It is NOT written before the first
//           POST — nothing needs it to be, because the source it is read from is durable.
//   * the sink documents only `503 trace_store_unavailable` as retryable. fr ALSO retries
//     401/403 (an auth fault — a rotated or missing X-Internal-Secret — is fixed by an
//     operator, not by the row; recording it terminal would drop the M4 rows for good),
//     429, any other 5xx, and a network failure. 422 and other 4xx stay terminal.
//   * `409 trace_conflict` is DELIVERED, not failed: it means the natural key is already in
//     the sink (nothing is rewritten) — e.g. a concurrent deliverer won the UNIQUE race.
//     Recorded in `delivered` plus `conflicted` for the operator; never retried.
//
// SOURCE OF THE DECISION. `approvals.metadata.coverage_decision`, written by fr#1333 in the
// completing transaction: {decision, rejected_criterion_ids, covered_criterion_ids,
// criteria_total}, already resolved (absent-means-all applied there). This module NEVER
// re-derives it from the request or the decision body: if it is absent or malformed, ZERO
// rows are written and a typed warning is logged. Inferring a per-AC decision would put a
// fabricated approval into the M4 count.
//
// SOURCE (ncn#1969 amendment). A `derived` coverage_request (null SHAs, every criterion
// computed {executed:false, outcome:'not_run'}) is NEVER posted: the ILS#226 body is
// extra='forbid' (no `source` field to forward) and requires 40-hex qa_head_sha/commit_sha on
// every row. Such an approval is closed with `closed_reason: 'coverage_request_derived_unsinkable'`
// and a typed warning; the approval row keeps `metadata.coverage_request_source = 'derived'`.
// Getting derived sign-offs into ac_coverage needs an ILS contract change first.
//
// INERT WHEN UNCONFIGURED: with AA_TRACE_SINK_URL or AA_TRACE_SINK_SECRET unset nothing is
// posted and no marker is written (so a later configured run still delivers).
//
// REDELIVERY. Delivery runs first on the decide path; a retryable failure, a missing
// decision trace or a pod roll leaves the marker without `completed_at`, and
// workers/ac-coverage-redelivery.ts re-calls `deliverAcCoverageForApproval` for every such
// row. Retries are BOUNDED IN RATE, not in count: `attempts` counts the runs that ended
// retryable, and `next_attempt_at` backs off exponentially (2 min → 2 h cap). Rows are
// never silently retired — the sink is idempotent, so a late retry is harmless, while a
// retired row is a coverage record that never exists.
//
// CONCURRENCY — CLAIM / DELIVER / RECORD (see "LEASE" below). No transaction and no row
// lock is ever held across the sink HTTP: a lock held for criteria × 5 s per row is the
// fr#1314 shape that starved fr's small connection pool. Instead a short claim stamps a
// lease (`ac_coverage_delivery.lease_until` / `lease_owner`) and commits; the POSTs run
// lock-free; a short record writes the result only while the lease is still ours. A second
// deliverer (the sweep on another replica, or the decide path racing the sweep) sees the
// live lease and returns `skipped: 'locked'` without POSTing anything.
//
// TRACE (U3 rule, movies-11 10-01): every row carries fr's DECISION trace,
// `metadata.coverage_decision.decided_trace_id`, which fr#1333 is being asked to add at
// decide time. fr does NOT mint a trace here and does NOT fall back to the request's
// X-AA-Trace-Id: a minted trace would join the coverage rows to nothing, and once posted it
// is pinned by the sink's replay rule (any later "correct" trace would be 409
// trace_conflict). If the field is absent the write is SKIPPED with the typed warning
// `decided_trace_id_missing` and a backoff marker; the sweep retries later.

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db as defaultDb, approvals } from '../../db/client';
import { isTraceId } from '../../lib/aa-trace';
import {
  COVERAGE_SIGNOFF_KIND,
  CoverageRequestSchema,
  coverageRequestSource,
  coverageRequestViolation,
  type CoverageRequest,
} from './u3-gates';

const AC_COVERAGE_PATH = '/api/internal/aa-trace/ac-coverage';
const POST_TIMEOUT_MS = 5000;
/** ILS#226 aa-trace-endpoints.md "Responses": the one 409 code — same natural key, field differs. */
const SINK_DUPLICATE_CODE = 'trace_conflict';

type AcCoverageSkipReason =
  | 'locked'
  | 'lease_lost'
  | 'decided_trace_id_missing'
  | 'not_coverage_kind'
  | 'not_decided'
  | 'sink_unconfigured'
  | 'coverage_decision_absent'
  | 'coverage_decision_malformed'
  | 'coverage_request_malformed'
  | 'coverage_request_derived_unsinkable'
  | 'already_delivered'
  | 'approval_not_found';

interface AcCoverageRow {
  trace_id: string;
  tenant_id: string;
  project_id: string | null;
  card_id: string;
  card_type: string;
  criterion_id: string;
  scenario_id: string | null;
  coverage_source: 'approval';
  qa_head_sha: string;
  commit_sha: string;
  approval_id: string;
  decision: 'approve' | 'reject';
  artifact_ref: string;
  writer: 'approval_callback';
}

interface AcCoverageDeliveryMarker {
  /** The decision trace stamped on every row; absent only while decided_trace_id is missing. */
  trace_id?: string;
  delivered: string[];
  failed?: Record<string, string>;
  /**
   * Criteria the sink answered `409 trace_conflict` for: the natural key is already recorded
   * (counted in `delivered`), with a differing field. Kept for the operator, never retried.
   */
  conflicted?: Record<string, string>;
  /** Runs that ended retryable (sink unavailable / auth / trace missing). */
  attempts?: number;
  /** The sweep does not pick the row up before this instant. */
  next_attempt_at?: string;
  last_error?: string;
  /** Terminal: every criterion delivered or terminally refused, or the input is permanently malformed. */
  completed_at?: string;
  /** Set with completed_at when the run was closed without POSTing (permanently malformed input). */
  closed_reason?: AcCoverageSkipReason;
  /** CLAIM lease: no other deliverer may claim the row before this instant. Dropped by RECORD. */
  lease_until?: string;
  /** Who holds the lease; RECORD writes only while this is still the caller. */
  lease_owner?: string;
}

/** Backoff for the n-th retryable run (n ≥ 1): 2 min · 2^(n-1), capped at 2 h. */
const AC_COVERAGE_BACKOFF_BASE_MS = 120_000;
const AC_COVERAGE_BACKOFF_CAP_MS = 7_200_000;
function acCoverageBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(AC_COVERAGE_BACKOFF_CAP_MS, AC_COVERAGE_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
}

/** Statuses fr retries. 0 = network failure / timeout. */
function isRetryableSinkStatus(status: number): boolean {
  return status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
}

export interface AcCoverageResult {
  emitted: number;
  skipped?: AcCoverageSkipReason;
  pending?: string[];
}

/** The trace sink, read at call time. */
function sinkEnv(): { url?: string; secret?: string } {
  return {
    url: process.env.AA_TRACE_SINK_URL?.trim() || undefined,
    secret: process.env.AA_TRACE_SINK_SECRET?.trim() || undefined,
  };
}

function warn(event: { code: string; approval_id: string; detail?: unknown }): void {
  console.warn(`[ac-coverage] ${event.code}`, JSON.stringify(event));
}

/**
 * fr#1333's resolved per-AC decision (its `CoverageDecision`, deblock-actions.ts @ e08c0581).
 * Read, never written, here. `decision` is already in SINK vocabulary (approve|reject) and
 * must agree with the row's fr status (approved|rejected).
 */
const CoverageDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  rejected_criterion_ids: z.array(z.string().min(1)),
  covered_criterion_ids: z.array(z.string().min(1)),
  criteria_total: z.number().int().nonnegative(),
  decided_trace_id: z.string().optional(),
});
export type CoverageDecision = z.infer<typeof CoverageDecisionSchema>;

/**
 * The rows to emit, one per criterion in covered ∪ rejected. PURE. Returns a string
 * error code instead of rows when the decision does not describe the request's criteria
 * exactly (overlap, unknown id, union ≠ criteria_total ≠ request size).
 */
function buildAcCoverageRows(input: {
  approval: { id: string; tenant_id: string; project_id: string | null };
  request: CoverageRequest;
  decision: CoverageDecision;
  traceId: string;
}): AcCoverageRow[] | 'coverage_decision_malformed' | 'coverage_request_derived_unsinkable' {
  const { request, decision } = input;
  // DERIVED requests (source 'derived', ncn#1969) carry null SHAs, and the sink requires
  // qa_head_sha/commit_sha as 40-hex on every row AND is extra='forbid' (no `source` field):
  // there is no body ILS#226 would accept that keeps a derived sign-off distinguishable from
  // a computed-backed one. Refuse to build rather than post a row the sink 422s, or one that
  // reads as R3-backed coverage.
  const qaHeadSha = request.qa_head_sha;
  const commitSha = request.commit_sha;
  if (coverageRequestSource(request) !== 'r3' || typeof qaHeadSha !== 'string' || typeof commitSha !== 'string') {
    return 'coverage_request_derived_unsinkable';
  }
  const covered = new Set(decision.covered_criterion_ids);
  const rejected = new Set(decision.rejected_criterion_ids);
  const byId = new Map(request.criteria.map((c) => [c.criterion_id, c]));
  const union = new Set([...covered, ...rejected]);
  const overlap = [...covered].some((id) => rejected.has(id));
  const unknown = [...union].some((id) => !byId.has(id));
  if (
    overlap ||
    unknown ||
    covered.size !== decision.covered_criterion_ids.length ||
    rejected.size !== decision.rejected_criterion_ids.length ||
    union.size !== decision.criteria_total ||
    union.size !== byId.size
  ) {
    return 'coverage_decision_malformed';
  }
  return [...union].sort().map((criterionId) => ({
    trace_id: input.traceId,
    tenant_id: input.approval.tenant_id,
    project_id: input.approval.project_id,
    card_id: request.card_id,
    card_type: request.card_type,
    criterion_id: criterionId,
    scenario_id: byId.get(criterionId)!.scenario_id,
    coverage_source: 'approval',
    qa_head_sha: qaHeadSha,
    commit_sha: commitSha,
    approval_id: input.approval.id,
    decision: covered.has(criterionId) ? 'approve' : 'reject',
    artifact_ref: `fr:approvals/${input.approval.id}`,
    writer: 'approval_callback',
  }));
}

type Executor = typeof defaultDb;

// ── LEASE: claim / deliver / record ─────────────────────────────────────────────────
//
// A delivery is THREE steps, and only the first and the last touch the database:
//   (i)   CLAIM  — one short statement (its own transaction): pick the row(s)
//                  `FOR UPDATE SKIP LOCKED` and stamp `ac_coverage_delivery.lease_until` /
//                  `lease_owner`. Committed before any HTTP.
//   (ii)  DELIVER — POST to the sink with NO transaction and NO row lock held.
//   (iii) RECORD — one short statement: write the marker (and drop the lease) ONLY IF
//                  `lease_owner` is still ours.
// The sweep (workers/ac-coverage-redelivery.ts) and the decide path both claim through
// this module, so whichever claims first is the only one that POSTs; the other sees a
// live lease and skips. A deliverer that dies mid-POST leaves a lease that expires, and
// the sweep reclaims the row then.
//
// The lease is sized to the worst-case delivery: one POST_TIMEOUT_MS per criterion plus
// slack, never under a minute. A deliverer that would outrun it stops POSTing (and
// records a retryable stop) rather than racing the next claimant.
const AC_COVERAGE_LEASE_MIN_SECS = 60;
const AC_COVERAGE_LEASE_SLACK_SECS = 30;

interface ClaimedCoverageApproval {
  id: string;
  tenant_id: string;
  project_id: string | null;
  kind: string;
  status: string;
  metadata: Record<string, unknown> | null;
  lease_owner: string;
  lease_secs: number;
  /** Local clock just BEFORE the claim was sent; the lease deadline counts from here, so it is never later than the DB's lease_until. */
  claimed_at_ms: number;
}

/** Lease seconds for the row aliased `a` — criteria × POST timeout + slack, floor 60 s. */
const LEASE_SECS = sql`GREATEST(${AC_COVERAGE_LEASE_MIN_SECS}, ${AC_COVERAGE_LEASE_SLACK_SECS} + ${POST_TIMEOUT_MS / 1000} *
  CASE WHEN jsonb_typeof(a.metadata -> 'coverage_request' -> 'criteria') = 'array'
       THEN jsonb_array_length(a.metadata -> 'coverage_request' -> 'criteria') ELSE 0 END)`;

/** Stamp the lease on the picked ids and return the claimed rows. One statement. */
async function stampLease(executor: Executor, picked: ReturnType<typeof sql>, owner: string): Promise<ClaimedCoverageApproval[]> {
  // Taken BEFORE the claim statement is sent. The DB stamps lease_until = now() + lease_secs
  // with ITS now(), which is no earlier than this instant (the statement has not started yet),
  // so the local deadline claimedAt + lease_secs can only fall at or BEFORE the DB's
  // lease_until — never after it. Taken after the claim returned, the local deadline would
  // include the claim's round-trip and could outrun the lease the next claimant reads.
  const claimedAt = new Date().getTime();
  const rows = await executor.execute<Record<string, unknown>>(sql`
    WITH picked AS (${picked})
    UPDATE approvals a
       SET metadata = coalesce(a.metadata, '{}'::jsonb) || jsonb_build_object(
             'ac_coverage_delivery',
             coalesce(a.metadata -> 'ac_coverage_delivery', '{}'::jsonb) || jsonb_build_object(
               'lease_until', to_char((now() + make_interval(secs => ${LEASE_SECS})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'lease_owner', ${owner}::text))
      FROM picked
     WHERE a.id = picked.id
    RETURNING a.id, a.tenant_id, a.project_id, a.kind::text AS kind, a.status, a.metadata, ${LEASE_SECS} AS lease_secs`);
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    project_id: r.project_id == null ? null : String(r.project_id),
    kind: String(r.kind),
    status: String(r.status),
    metadata: (r.metadata ?? null) as Record<string, unknown> | null,
    lease_owner: owner,
    lease_secs: Number(r.lease_secs),
    claimed_at_ms: claimedAt,
  }));
}

/**
 * CLAIM ONE (decide path). The approval must be a decided coverage sign-off with no
 * completed marker and no live lease. Returns [] when any of that is false — including
 * when the sweep holds it.
 */
async function claimAcCoverageApproval(
  approvalId: string,
  owner: string,
  executor: Executor = defaultDb,
): Promise<ClaimedCoverageApproval[]> {
  return stampLease(
    executor,
    sql`SELECT id FROM approvals
         WHERE id = ${approvalId}::uuid
           AND kind = ${COVERAGE_SIGNOFF_KIND}
           AND status IN ('approved', 'rejected')
           AND COALESCE((metadata -> 'ac_coverage_delivery') ? 'completed_at', false) = false
           AND COALESCE((metadata -> 'ac_coverage_delivery' ->> 'lease_until')::timestamptz, '-infinity'::timestamptz) <= now()
         FOR UPDATE SKIP LOCKED`,
    owner,
  );
}

/**
 * CLAIM A BATCH (the sweep). Same lease rule, plus the sweep's own predicates: fr#1333
 * wrote the decision, the decide path had its turn (settle window) and the backoff
 * elapsed. The `status`/`completed_at` clauses are spelled EXACTLY as the partial index
 * `approvals_ac_coverage_sweep_idx` (migration 153) so the planner can prove the index
 * applies; `kind` is its leading key; `coverage_decision` filters within it.
 */
export async function claimAcCoverageBatch(
  opts: { owner: string; limit: number; settleSecs: number },
  executor: Executor = defaultDb,
): Promise<ClaimedCoverageApproval[]> {
  return stampLease(
    executor,
    sql`SELECT id FROM approvals
         WHERE kind = ${COVERAGE_SIGNOFF_KIND}
           AND status IN ('approved', 'rejected')
           AND metadata ? 'coverage_decision'
           AND COALESCE((metadata -> 'ac_coverage_delivery') ? 'completed_at', false) = false
           AND COALESCE((metadata -> 'ac_coverage_delivery' ->> 'lease_until')::timestamptz, '-infinity'::timestamptz) <= now()
           AND updated_at < now() - make_interval(secs => ${opts.settleSecs})
           AND COALESCE((metadata -> 'ac_coverage_delivery' ->> 'next_attempt_at')::timestamptz, '-infinity'::timestamptz) <= now()
         ORDER BY COALESCE((metadata -> 'ac_coverage_delivery' ->> 'next_attempt_at')::timestamptz, updated_at::timestamptz) ASC, id ASC
         LIMIT ${opts.limit}
         FOR UPDATE SKIP LOCKED`,
    opts.owner,
  );
}

/**
 * RECORD. Writes `marker` (lease fields dropped) — or, with `marker === null`, removes the
 * marker entirely (a claim that did nothing) — ONLY while `lease_owner` is still `owner`.
 * Returns false when the lease was lost (expired and reclaimed): the caller's results are
 * then NOT written, so a slow deliverer can never overwrite the newer owner's marker.
 */
async function recordDelivery(
  executor: Executor,
  claimed: ClaimedCoverageApproval,
  marker: AcCoverageDeliveryMarker | null,
  touch: boolean,
): Promise<boolean> {
  let next: AcCoverageDeliveryMarker | null = null;
  if (marker) {
    const { lease_until: _until, lease_owner: _owner, ...rest } = marker;
    next = rest;
  }
  const rows = await executor.execute<{ id: string }>(sql`
    UPDATE approvals
       SET metadata = CASE WHEN ${next === null}::boolean
                           THEN coalesce(metadata, '{}'::jsonb) - 'ac_coverage_delivery'
                           ELSE coalesce(metadata, '{}'::jsonb) || jsonb_build_object('ac_coverage_delivery', ${JSON.stringify(next ?? {})}::jsonb)
                      END,
           -- The sweep's settle predicate keys on updated_at, so a real marker write is
           -- also a floor on the retry spacing. Releasing an unused claim does not count.
           updated_at = CASE WHEN ${touch}::boolean THEN now() ELSE updated_at END
     WHERE id = ${claimed.id}::uuid
       AND tenant_id = ${claimed.tenant_id}::uuid
       AND metadata -> 'ac_coverage_delivery' ->> 'lease_owner' = ${claimed.lease_owner}::text
    RETURNING id`);
  return (Array.isArray(rows) ? rows : []).length > 0;
}

/** Why a claim found nothing, read WITHOUT a lock. */
async function classifyUnclaimed(approvalId: string, executor: Executor): Promise<AcCoverageResult> {
  const [row] = await executor
    .select({ kind: approvals.kind, status: approvals.status, metadata: approvals.metadata })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .limit(1);
  if (!row) return { emitted: 0, skipped: 'approval_not_found' };
  if (row.kind !== COVERAGE_SIGNOFF_KIND) return { emitted: 0, skipped: 'not_coverage_kind' };
  if (row.status !== 'approved' && row.status !== 'rejected') return { emitted: 0, skipped: 'not_decided' };
  const m = ((row.metadata ?? {}) as Record<string, unknown>).ac_coverage_delivery as AcCoverageDeliveryMarker | undefined;
  if (m?.completed_at) return { emitted: 0, skipped: 'already_delivered' };
  return { emitted: 0, skipped: 'locked' };
}

export function newLeaseOwner(prefix: 'decide' | 'sweep'): string {
  return `${prefix}:${randomUUID()}`;
}

/**
 * Deliver the ac_coverage rows for one decided coverage approval (the DECIDE path).
 * NEVER throws: every failure is a typed warning plus a result, because a failed
 * writeback must not turn a human's decision into an error response.
 *
 * Claims the row first (see "LEASE" above); a row the sweep holds is `skipped: 'locked'`.
 * ⛔ Must not be called inside a transaction: the claim has to COMMIT before the POSTs,
 * or the lease is invisible to the sweep and the row lock is held across HTTP.
 */
export async function deliverAcCoverageForApproval(
  approvalId: string,
  executor: Executor = defaultDb,
): Promise<AcCoverageResult> {
  try {
    const env = sinkEnv();
    if (!env.url || !env.secret) {
      warn({ code: 'sink_unconfigured', approval_id: approvalId });
      return { emitted: 0, skipped: 'sink_unconfigured' };
    }
    const [claimed] = await claimAcCoverageApproval(approvalId, newLeaseOwner('decide'), executor);
    if (!claimed) return await classifyUnclaimed(approvalId, executor);
    return await deliverClaimedAcCoverage(claimed, executor);
  } catch (err) {
    warn({ code: 'ac_coverage_writeback_error', approval_id: approvalId, detail: String(err) });
    return { emitted: 0 };
  }
}

/**
 * Steps (ii) + (iii) for a row this caller has CLAIMED. NEVER throws. No transaction is
 * open while it POSTs: the only DB calls are the final single-statement RECORD.
 */
export async function deliverClaimedAcCoverage(
  claimed: ClaimedCoverageApproval,
  executor: Executor = defaultDb,
): Promise<AcCoverageResult> {
  try {
    return await deliverClaimed(claimed, executor);
  } catch (err) {
    warn({ code: 'ac_coverage_writeback_error', approval_id: claimed.id, detail: String(err) });
    return { emitted: 0 };
  }
}

async function deliverClaimed(claimed: ClaimedCoverageApproval, executor: Executor): Promise<AcCoverageResult> {
  // Local deadline = (local instant taken BEFORE the claim) + the lease's LENGTH — not its DB
  // timestamp, so a clock skew between fr and Postgres cannot stretch it, and not an instant
  // taken after the claim, so the claim's round-trip cannot push it past the DB's lease_until.
  const leaseDeadlineMs = claimed.claimed_at_ms + claimed.lease_secs * 1000;
  const meta = (claimed.metadata ?? {}) as Record<string, unknown>;
  const rawPrior = meta.ac_coverage_delivery as AcCoverageDeliveryMarker | undefined;
  // The marker as it stood BEFORE our claim stamped the lease into it.
  let prior: AcCoverageDeliveryMarker | undefined;
  if (rawPrior) {
    const { lease_until: _u, lease_owner: _o, ...rest } = rawPrior;
    prior = Object.keys(rest).length ? (rest as AcCoverageDeliveryMarker) : undefined;
  }
  const lost = (): AcCoverageResult => {
    warn({ code: 'ac_coverage_lease_lost', approval_id: claimed.id });
    return { emitted: 0, skipped: 'lease_lost' };
  };
  const skip = (code: AcCoverageSkipReason, detail?: unknown): AcCoverageResult => {
    warn({ code, approval_id: claimed.id, detail });
    return { emitted: 0, skipped: code };
  };
  // Give the claim back untouched (nothing to deliver right now).
  const release = async (code: AcCoverageSkipReason, detail?: unknown): Promise<AcCoverageResult> => {
    if (!(await recordDelivery(executor, claimed, prior ?? null, false))) return lost();
    return skip(code, detail);
  };
  // A PERMANENTLY malformed input will never deliver; close the marker so the sweep stops
  // selecting it (an open one would be re-read every tick and starve healthy rows).
  const close = async (code: AcCoverageSkipReason, detail?: unknown): Promise<AcCoverageResult> => {
    const ok = await recordDelivery(
      executor,
      claimed,
      { ...(prior ?? { delivered: [] }), delivered: prior?.delivered ?? [], completed_at: new Date().toISOString(), closed_reason: code },
      true,
    );
    if (!ok) return lost();
    return skip(code, detail);
  };

  if (meta.coverage_decision === undefined || meta.coverage_decision === null) {
    // fr#1333 not landed, or a pre-#1333 decision. Never infer the per-AC decision.
    return release('coverage_decision_absent');
  }

  const decision = CoverageDecisionSchema.safeParse(meta.coverage_decision);
  const statusFor = { approve: 'approved', reject: 'rejected' } as const;
  if (!decision.success || statusFor[decision.data.decision] !== claimed.status) {
    return close('coverage_decision_malformed', decision.success ? 'decision disagrees with approval.status' : decision.error.issues);
  }
  const request = CoverageRequestSchema.safeParse(meta.coverage_request);
  if (!request.success) return close('coverage_request_malformed', request.error.issues);
  // The source-dependent rules the mint gate enforced, re-checked on the stored copy.
  const violation = coverageRequestViolation(request.data);
  if (violation) return close('coverage_request_malformed', violation);
  // A derived sign-off has no sinkable form (see buildAcCoverageRows): close it with its own
  // typed reason — terminal and visible, never a per-criterion 422 the sweep cannot fix.
  if (coverageRequestSource(request.data) === 'derived') {
    return close('coverage_request_derived_unsinkable', { source: 'derived' });
  }

  // The trace that stamps every row: the persisted one on a retry (the sink's replay needs
  // the identical body), else fr#1333's decision trace. NEVER minted here, never taken
  // from a request header — see the module header ("TRACE").
  const decidedTrace = decision.data.decided_trace_id?.trim().toLowerCase();
  const traceId =
    (prior?.trace_id && isTraceId(prior.trace_id) ? prior.trace_id : undefined) ??
    (decidedTrace && isTraceId(decidedTrace) ? decidedTrace : undefined);
  if (!traceId) {
    const attempts = (prior?.attempts ?? 0) + 1;
    const ok = await recordDelivery(
      executor,
      claimed,
      {
        ...(prior ?? {}),
        delivered: prior?.delivered ?? [],
        attempts,
        next_attempt_at: new Date(new Date().getTime() + acCoverageBackoffMs(attempts)).toISOString(),
        last_error: 'decided_trace_id_missing',
      },
      true,
    );
    if (!ok) return lost();
    return skip('decided_trace_id_missing', { attempts, present: decision.data.decided_trace_id !== undefined });
  }

  const rows = buildAcCoverageRows({
    approval: { id: claimed.id, tenant_id: claimed.tenant_id, project_id: claimed.project_id },
    request: request.data,
    decision: decision.data,
    traceId,
  });
  if (rows === 'coverage_decision_malformed') return close('coverage_decision_malformed', 'criteria sets disagree');
  if (rows === 'coverage_request_derived_unsinkable') return close(rows, { source: coverageRequestSource(request.data) });

  const env = sinkEnv();
  if (!env.url || !env.secret) return release('sink_unconfigured');

  const marker: AcCoverageDeliveryMarker = {
    ...(prior ?? {}),
    trace_id: traceId,
    delivered: [...(prior?.delivered ?? [])],
    ...(prior?.failed ? { failed: { ...prior.failed } } : {}),
    ...(prior?.conflicted ? { conflicted: { ...prior.conflicted } } : {}),
  };

  const done = new Set([...marker.delivered, ...Object.keys(marker.failed ?? {})]);
  let emitted = 0;
  let retryable: string | undefined;
  for (const row of rows) {
    if (done.has(row.criterion_id)) continue;
    // Never start a POST that could still be running when the lease lapses: past that
    // instant the sweep may legitimately reclaim the row and POST the same criterion.
    if (new Date().getTime() + POST_TIMEOUT_MS > leaseDeadlineMs) {
      retryable = 'lease_expiring';
      warn({ code: 'ac_coverage_lease_expiring', approval_id: claimed.id, detail: { criterion_id: row.criterion_id } });
      break;
    }
    let status: number;
    let code: string | undefined;
    try {
      const res = await fetch(`${env.url.replace(/\/+$/, '')}${AC_COVERAGE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.secret },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      status = res.status;
      if (status >= 300) code = ((await res.json().catch(() => ({}))) as { code?: string }).code;
    } catch (err) {
      status = 0;
      code = `network:${String(err)}`;
    }
    if (status === 201 || status === 200) {
      marker.delivered.push(row.criterion_id);
      if (status === 201) emitted += 1;
    } else if (status === 409 && code === SINK_DUPLICATE_CODE) {
      // DELIVERED, not failed. ILS#226 docs/aa-trace-endpoints.md: the sink is
      // INSERT … ON CONFLICT DO NOTHING on the natural key (card_id, criterion_id,
      // coverage_source, coalesce(execution_id, approval_id)) — an identical re-POST is
      // `200 replayed` and the same key with any field different is
      // `409 trace_conflict`, "nothing is rewritten". So a 409 means a row for THIS AC and
      // THIS approval is already in the sink (a concurrent deliverer's insert won the UNIQUE
      // race, or an earlier send landed). The record exists; retrying cannot change it and
      // calling it a permanent failure would report a recorded AC as missing. The differing
      // fields are kept for the operator.
      marker.delivered.push(row.criterion_id);
      marker.conflicted = { ...(marker.conflicted ?? {}), [row.criterion_id]: `${status}:${code}` };
      warn({ code: 'ac_coverage_row_conflict', approval_id: claimed.id, detail: { criterion_id: row.criterion_id, status, code } });
    } else if (isRetryableSinkStatus(status)) {
      // Stop: the rest would hit the same store / the same credential.
      retryable = `${status}:${code ?? 'unknown'}`;
      warn({
        code: status === 401 || status === 403 ? 'ac_coverage_sink_auth_refused' : 'ac_coverage_sink_unavailable',
        approval_id: claimed.id,
        detail: { status, code, attempts: (prior?.attempts ?? 0) + 1 },
      });
      break;
    } else {
      // 422 / other 4xx (and a 409 that is not trace_conflict): the row itself is refused; do not retry.
      marker.failed = { ...(marker.failed ?? {}), [row.criterion_id]: `${status}:${code ?? 'unknown'}` };
      warn({
        code: 'ac_coverage_row_refused',
        approval_id: claimed.id,
        detail: { criterion_id: row.criterion_id, status, code },
      });
    }
  }
  if (retryable) {
    marker.attempts = (prior?.attempts ?? 0) + 1;
    marker.next_attempt_at = new Date(new Date().getTime() + acCoverageBackoffMs(marker.attempts)).toISOString();
    marker.last_error = retryable;
  } else {
    marker.completed_at = new Date().toISOString();
    delete marker.next_attempt_at;
  }
  if (!(await recordDelivery(executor, claimed, marker, true))) {
    // The lease lapsed and another deliverer owns the row now; its marker stands. The
    // POSTs above were replay-safe (identical bodies), so nothing is lost but this record.
    const r = lost();
    return { ...r, emitted };
  }
  const pending = rows.map((r) => r.criterion_id).filter((id) => !marker.delivered.includes(id) && !marker.failed?.[id]);
  return { emitted, ...(pending.length ? { pending } : {}) };
}
