// src/lib/approval-answerability-metrics.ts
//
// ⛔ WHAT THIS COUNTS: every approval fr was asked to MINT, and whether the row
// it was about to write could ever have been answered by a human.
//
// Why it exists
// -------------
// The gate in `domain/approvals/one-open-gate.ts` ships in OBSERVE mode
// (`FR_APPROVAL_ANSWERABILITY_MODE`, default `observe`), which means it changes
// no outcome at all on day one. ⭐ SO THE COUNTER IS NOT INSTRUMENTATION FOR
// THE FIX — UNTIL THE FLAG FLIPS IT *IS* THE FIX. It is the only thing that can
// answer "has the approver arm stopped firing?", and therefore the only thing
// that can say whether `enforce` may be turned on without stopping the
// conveyor fleet-wide.
//
// ⛔ THE COUNTER IS THE DURABLE HALF, NOT THE LOG — the same split
// `conveyor-refusal-metrics.ts` and `board-tenant-gate-metrics.ts` document,
// and this module copies their mechanism line-for-line in shape: closed label
// sets, pre-seeded to zero, an increment-only recorder, a `report*` that also
// emits one structured line, a `render*` for routes/metrics.ts, and the two
// `__*ForTests` accessors. The `console.warn` names the approval, the card and
// the tenant, which is what a human needs to chase one row; that line dies with
// the pod. Prometheus scrapes `/metrics` and retains.
//
// ⛔ WHY A THIRD SIBLING AND NOT A REUSE. `fr_conveyor_inbound_refused_total`
// is documented and alerted on as "an inbound conveyor request fr REFUSED" —
// the events counted here are overwhelmingly NOT refusals (observe mode mints
// every one of them), so filing them there would corrupt the one number the
// conveyor's dark-channel alert is written against. `fr_board_tenant_gate_
// refused_total` is human browser traffic. Neither can absorb this without the
// label meaning two things at once.
//
// Cardinality
// -----------
// reason x kind x outcome, all three CLOSED, and the pairs are pre-seeded
// SELECTIVELY rather than as a full cross product: `reason="none"` only ever
// pairs with `outcome="clean"`, and every other reason only with
// resolved/observed/refused. With 6 reasons (5 + `none`), 7 kinds and the
// selective pairing above that is 5x3x7 + 1x7 = 112 fixed series — MEASURED by
// counting `renderAnswerabilityMetrics()`'s non-comment lines, not derived from
// a remembered figure. If a reason or a kind is added, re-count from the
// renderer rather than editing this arithmetic. Approval ids, card
// ids, tenant ids and user ids are LOG-ONLY and never labels — they are
// unbounded and would mint a series per card.
//
// ⭐ THE ZERO BASELINE IS THE MEASUREMENT, not politeness. A series that only
// appears once it fires cannot be told apart from an exporter that was never
// wired up — and here the intended end state of `approver_foreign_tenant` is
// ZERO, so an absent series and a fixed defect would look identical.
//
// Lives in `lib/` and imports only `middleware/request-context`, for the same
// reason its two siblings do: the mint paths are unit-tested with no database,
// so this module must not transitively import `db/client`. The approval-kind
// list below is therefore a LOCAL mirror of `db/schema.ts :: approvalKindEnum`
// rather than an import of it; `tests/unit/lib/approval-answerability.test.ts`
// pins the two together (`describe('the counter') > 'the kind list MIRRORS
// db/schema.ts approvalKindEnum'`) so the mirror cannot drift silently.

import { tryGetRequestContext } from '../middleware/request-context';
import {
  ANSWERABILITY_OUTCOMES,
  ANSWERABILITY_REASONS,
  type AnswerabilityOutcome,
  type AnswerabilityReason,
} from './approval-answerability';

/**
 * The producer axis, as `approvals.kind`.
 *
 * ⚠️ `kind` is the finest PRODUCER attribution available at the chokepoint and
 * it is not a perfect one: `generic` covers the card-approval webhook AND the
 * human self-service path, which mint through different doors. It is used
 * anyway because it is the only producer label that is a CLOSED set — a route
 * name would have to be threaded through `mintOneOpenGate`'s signature from
 * four callers, and `callback_path` is caller-supplied and therefore unbounded.
 * The structured log line carries the callback_path for the finer question.
 *
 * Mirrors `db/schema.ts :: approvalKindEnum`, plus `other` for a value outside
 * it (which the enum makes unreachable from the database side, but not from a
 * unit-test caller).
 */
export const ANSWERABILITY_KINDS = [
  'generic',
  'improvement.design',
  'improvement.release',
  'execution.ready_signoff',
  'improvement.canary_action',
  'project_outline.approval',
  'execution.feature_design_approval',
  // U3: feature_design above is 152's; coverage is 153. The bug-fix gate is a metadata
  // marker, not a kind (RULING 10-01), so it adds no kind here.
  'qa.coverage_signoff',
  // U4: A5 landing sign-off, migration 156.
  'execution.landing_signoff',
  // U3: A6 conveyor QUESTION, migration 155.
  'execution.question',
  // G8 / R313: tenant promotion of a project asset copy, migration 200.
  'asset.promotion',
  // Migration 204 (R318, retired by R349: nothing creates it). Kept: this list mirrors
  // approvalKindEnum, pinned by tests/unit/lib/approval-answerability.test.ts.
  'board.move_confirmation',
  'other',
] as const;
export type AnswerabilityKind = (typeof ANSWERABILITY_KINDS)[number];

const key = (
  r: AnswerabilityReason,
  k: AnswerabilityKind,
  o: AnswerabilityOutcome,
): string => `${r}|${k}|${o}`;

/**
 * Which (reason, outcome) pairs are REACHABLE. Used both to seed and to render,
 * so an unreachable pair is never exported as a permanent zero that an operator
 * would read as "this never happens" when it in fact cannot happen.
 */
function outcomesFor(reason: AnswerabilityReason): readonly AnswerabilityOutcome[] {
  return reason === 'none'
    ? (['clean'] as const)
    : (['resolved', 'observed', 'refused'] as const);
}

const counts = new Map<string, number>();
for (const r of ANSWERABILITY_REASONS) {
  for (const k of ANSWERABILITY_KINDS) {
    for (const o of outcomesFor(r)) counts.set(key(r, k, o), 0);
  }
}

function normaliseReason(reason: string): AnswerabilityReason {
  return (ANSWERABILITY_REASONS as readonly string[]).includes(reason)
    ? (reason as AnswerabilityReason)
    : 'none';
}

/**
 * ⚠️ NORMALISED, like `board-tenant-gate-metrics.ts` and unlike the conveyor
 * sibling. `render*` below loops over the three constants, so an un-normalised
 * label would mint a map entry that is incremented and then NEVER EXPORTED —
 * a defect that increments a number nobody can read. That is a measured failure
 * mode in this repo, not a hypothetical one.
 */
export function normaliseAnswerabilityKind(kind: string | null | undefined): AnswerabilityKind {
  return kind && (ANSWERABILITY_KINDS as readonly string[]).includes(kind)
    ? (kind as AnswerabilityKind)
    : 'other';
}

function normaliseOutcome(outcome: string): AnswerabilityOutcome {
  return (ANSWERABILITY_OUTCOMES as readonly string[]).includes(outcome)
    ? (outcome as AnswerabilityOutcome)
    : 'observed';
}

/** Increment only. */
export function recordAnswerability(
  reason: AnswerabilityReason,
  kind: string | null | undefined,
  outcome: AnswerabilityOutcome,
): void {
  const r = normaliseReason(reason);
  const o = normaliseOutcome(outcome);
  // Keep an unreachable pair out of the map rather than minting a series the
  // renderer will not emit. A caller that gets here with one has a bug, and a
  // silently-unexported count would hide it.
  if (!outcomesFor(r).includes(o)) return;
  const k = key(r, normaliseAnswerabilityKind(kind), o);
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

export interface AnswerabilityReportDetail {
  reason: AnswerabilityReason;
  kind: string | null | undefined;
  outcome: AnswerabilityOutcome;
  /** Planka card id. Named in the log line, never in a label. */
  cardId?: string | null;
  /** The approval's tenant. Log-only. */
  tenantId?: string | null;
  /** Caller-supplied and therefore unbounded — log-only, never a label. */
  callbackPath?: string | null;
  /** What the resolution ladder derived, on `outcome="resolved"`. Log-only. */
  resolvedFrom?: string | null;
  /** Free-form, log-only. Keep it short and factual. */
  detail?: Record<string, unknown>;
}

/**
 * Count it AND emit one structured line — the two halves described in the
 * header, neither substituting for the other.
 *
 * ⛔ NEVER THROWS and never changes a verdict. The mint decision is already
 * made by the caller; a throw from in here would turn a diagnosable observation
 * into an undiagnosable 500 on the whole n8n ingest path — i.e. the instrument
 * would become the outage. Same contract, and the same deliberately silent
 * catch, as `reportBoardTenantGateRefusal`.
 *
 * ⛔ NO CREDENTIAL MATERIAL. `RequestContext` carries `bearerToken` one property
 * access away, so the context is read by EXPLICITLY NAMED fields only. There is
 * no `...ctx` spread here and there must never be.
 *
 * ⚠️ `console.warn`, not `console.error`, and only off the `clean` path: in
 * observe mode this fires on essentially every card-approval mint (105 of 106
 * measured), and logging that at error level would bury the refusals that
 * matter under a per-mint line the operator cannot act on yet.
 */
export function reportAnswerability(d: AnswerabilityReportDetail): void {
  try {
    recordAnswerability(d.reason, d.kind, d.outcome);
    if (d.outcome === 'clean') return;
    const ctx = tryGetRequestContext();
    console.warn(
      JSON.stringify({
        telemetry: 'approval_answerability',
        reason: normaliseReason(d.reason),
        kind: normaliseAnswerabilityKind(d.kind),
        outcome: normaliseOutcome(d.outcome),
        card_id: d.cardId ?? null,
        tenant_id: d.tenantId ?? null,
        callback_path: d.callbackPath ?? null,
        resolved_from: d.resolvedFrom ?? null,
        // Explicitly named, never spread — see the ⛔ above.
        correlation_id: ctx?.correlationId ?? null,
        initiator: ctx?.initiator ?? null,
        channel: ctx?.channel ?? null,
        ...(d.detail ?? {}),
      }),
    );
  } catch {
    // Deliberately silent: an instrument must not become the outage.
  }
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderAnswerabilityMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_approval_answerability_total Approval mints by whether the row could ever be answered, by reason, approval kind and what fr did about it. outcome="clean" with reason="none" is the healthy denominator; outcome="observed" is the live defect rate; outcome="refused" only occurs under FR_APPROVAL_ANSWERABILITY_MODE=enforce.',
    '# TYPE fr_approval_answerability_total counter',
  ];
  for (const r of ANSWERABILITY_REASONS) {
    for (const k of ANSWERABILITY_KINDS) {
      for (const o of outcomesFor(r)) {
        lines.push(
          `fr_approval_answerability_total{reason="${r}",kind="${k}",outcome="${o}"} ${counts.get(key(r, k, o)) ?? 0}`,
        );
      }
    }
  }
  return lines;
}

