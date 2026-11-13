// src/services/approvals/bug-fix-uniqueness.ts
//
// U3 — ONE fix-authorising approval per BUG card (RULING 10-01 item 3).
//
// THE DATABASE IS THE ARBITER. Migration 153's partial UNIQUE index
// `approvals_one_bug_fix_authorization_per_bug_card_idx` admits at most one MARKED
// `execution.ready_signoff` row per (tenant_id, metadata->>'bug_card_id') whose status is
// NOT voided and NOT expired. Two concurrent marked mints for the same bug card race on that
// index; the loser's INSERT raises 23505 and this module maps it.
//
// `expired` is outside the index because the expiry worker (workers/approval-expiry.ts)
// puts the card back in TODO "to be re-raised": an expired row that still held the index
// would answer every re-raise with 409 (or dedupe it onto the EXPIRED row) and strand the
// card. `rejected` stays inside: a rejected bug card is terminal (RULING 10-01).
//
// ⛔ STRICT DEDUPE FOR MARKED REQUESTS (`assertSameBugFixRequest`). A marked request is
// answered with an EXISTING row only when that row is the SAME request: marked
// execution.ready_signoff with equal report_hash, equal bug_card_id and equal bug_ids (as a
// set). Anything else is a 409 with the existing id in details — never the old row silently
// returned for a different request. WHICH 409 (`refuseMarkedDedupe`):
//   * `bug_card_already_has_approval` ONLY when the existing row IS this bug card's
//     authorization — marked execution.ready_signoff with the SAME bug_card_id, i.e. exactly
//     the row `GET /api/approvals/bug-fix-for-card/:bugCardId` returns. The 409 and the read
//     therefore never contradict each other.
//   * `open_gate_conflict` (details.existing_approval_id + details.existing_kind) for every
//     other open gate the request collided with on its decision card: an UNMARKED pending
//     gate, or a marked row about a DIFFERENT bug card. For those the read is 404, and
//     "already has an approval" would be false.
// It applies on BOTH
// dedupe paths: this index's 23505, and the generic one-open-gate-per-card dedupe (the
// route's pre-check and `mintOneOpenGate`'s onConflict re-read) — on BOTH marker doors:
// execution-approvals (kind execution.ready_signoff) AND webhooks card-approval (kind
// generic; `resolveBugFixAuthorizationMint` requires and stores the same report fields there,
// so the equality is the same). "Same request" includes the request's own KIND: a marked
// generic retry dedupes onto the marked generic row it minted, never onto a ready_signoff one
// (and vice versa). Unmarked requests keep the generic behaviour untouched.
// No read-check-write, no advisory lock, no transaction, and no Planka call anywhere on this
// path — the previous design (a Planka Metadata stamp under pg_advisory_xact_lock) pinned a
// pooled connection across Planka HTTP, the fr#1314 class.
//
// HOW ncn FINDS THE APPROVAL FOR A BUG CARD: `GET /api/approvals/bug-fix-for-card/:bugCardId`
// (routes/approval-bug-fix-for-card.ts), which reads the row through
// `findBugFixApprovalForCard` below. fr writes NOTHING onto the bug card.

import { and, desc, eq, notInArray, sql } from 'drizzle-orm';

import { approvals, db as defaultDb } from '../../db/client';
import { mintOneOpenGate, type OpenGate } from '../../domain/approvals/one-open-gate';
import { AppError, pgErrorCode } from '../../utils/errors';
import { BUG_FIX_AUTHORISING_KIND, BUG_FIX_AUTHORIZATION_MARKER } from './u3-gates';

/** Migration 153. Named here so a 23505 on ANY other constraint is never mistaken for this one. */
export const BUG_FIX_AUTHORIZATION_UNIQUE_INDEX = 'approvals_one_bug_fix_authorization_per_bug_card_idx' as const;
export const BUG_CARD_ALREADY_HAS_APPROVAL = 'bug_card_already_has_approval' as const;
export const OPEN_GATE_CONFLICT = 'open_gate_conflict' as const;

/**
 * True ONLY for a unique violation raised by the bug-fix index. Strict on the constraint
 * name: a candidate carrying 23505 without that exact `constraint_name` does not match.
 * Drizzle wraps the driver error, so both `err` and `err.cause` are inspected.
 */
export function isBugFixAuthorizationUniqueViolation(err: unknown): boolean {
  if (pgErrorCode(err) !== '23505') return false;
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const e = candidate as { code?: unknown; constraint_name?: unknown } | null | undefined;
    if (e?.code === '23505' && e.constraint_name === BUG_FIX_AUTHORIZATION_UNIQUE_INDEX) return true;
  }
  return false;
}

/** Statuses outside migration 153's index — and therefore never returned by the lookup. */
export const BUG_FIX_NON_BLOCKING_STATUSES = ['voided', 'expired'] as const;

/**
 * The marked execution.ready_signoff row for this bug card in this tenant whose status is
 * neither voided nor expired, or null. The WHERE is spelled as the index predicate, so "found"
 * here and "conflicts there" are the same set (at most one row). Newest first by
 * (created_at, id) so the answer is total even if that invariant were ever broken.
 * Tenant-predicated: another tenant's row is null, never a leak.
 *
 * `includeClosed: true` (ONLY the bug-fix-for-card route's `include_closed=true`) drops the
 * status predicate: the LATEST marked row in ANY status (voided / expired included), same
 * tenant + marker predicate, same ordering — so a hunt can tell "never raised" (null) from
 * "raised and closed". It is NOT the index predicate; the conflict path never passes it.
 */
export async function findBugFixApprovalForCard(
  tenantId: string,
  bugCardId: string,
  executor: Pick<typeof defaultDb, 'select'> = defaultDb,
  options: { includeClosed?: boolean } = {},
): Promise<OpenGate | null> {
  const [row] = await executor
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.tenant_id, tenantId),
        eq(approvals.kind, BUG_FIX_AUTHORISING_KIND),
        sql`${approvals.metadata} ->> 'approval_kind' = ${BUG_FIX_AUTHORIZATION_MARKER}`,
        sql`${approvals.metadata} ->> 'bug_card_id' = ${bugCardId}`,
        options.includeClosed === true ? undefined : notInArray(approvals.status, [...BUG_FIX_NON_BLOCKING_STATUSES]),
      ),
    )
    .orderBy(desc(approvals.created_at), desc(approvals.id))
    .limit(1);
  return row ?? null;
}

/** The validated marker fields a marked mint carries (resolveBugFixAuthorizationMint). */
export type BugFixRequest = { bug_card_id: string; report_hash: string; bug_ids: readonly string[] };

function sameIdSet(a: unknown, b: readonly string[]): boolean {
  if (!Array.isArray(a)) return false;
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of right) if (!left.has(id)) return false;
  return true;
}

/** Column default of `approvals.kind` — the kind of an insert that does not set one. */
const APPROVALS_DEFAULT_KIND = 'generic' as const;

/**
 * True only when `existing` is the SAME marked request (see the module header): same kind as
 * the request being minted (`requestKind`), marked, equal report_hash and bug_card_id, equal
 * bug_ids as a set.
 */
export function isSameBugFixRequest(existing: OpenGate, bugFix: BugFixRequest, requestKind: string): boolean {
  const m = (existing.metadata ?? {}) as Record<string, unknown>;
  return (
    existing.kind === requestKind &&
    m.approval_kind === BUG_FIX_AUTHORIZATION_MARKER &&
    m.report_hash === bugFix.report_hash &&
    m.bug_card_id === bugFix.bug_card_id &&
    sameIdSet(m.bug_ids, bugFix.bug_ids)
  );
}

function bugCardAlreadyHasApproval(bugCardId: string, existing: OpenGate | null): AppError {
  return new AppError(
    409,
    `bug card ${bugCardId} already has a bug-fix authorization` +
      (existing ? ` (${existing.id}, status ${existing.status})` : '') +
      '; a second, different one is refused',
    existing ? { existing_approval_id: existing.id, existing_status: existing.status } : undefined,
  ).withCode(BUG_CARD_ALREADY_HAS_APPROVAL);
}

/** True when `existing` is THIS bug card's authorization — the row the bug-fix-for-card read returns. */
function isAuthorizationForBugCard(existing: OpenGate, bugCardId: string): boolean {
  const m = (existing.metadata ?? {}) as Record<string, unknown>;
  return (
    existing.kind === BUG_FIX_AUTHORISING_KIND &&
    m.approval_kind === BUG_FIX_AUTHORIZATION_MARKER &&
    m.bug_card_id === bugCardId
  );
}

function openGateConflict(bugCardId: string, existing: OpenGate): AppError {
  return new AppError(
    409,
    `the decision card already holds open approval ${existing.id} (kind ${existing.kind}) that is not ` +
      `bug card ${bugCardId}'s bug-fix authorization; the marked request cannot be deduplicated onto it`,
    { existing_approval_id: existing.id, existing_kind: existing.kind },
  ).withCode(OPEN_GATE_CONFLICT);
}

/**
 * The 409 for a marked request that is NOT the same request as `existing` (see the module
 * header): `bug_card_already_has_approval` only when `existing` is this bug card's
 * authorization, else `open_gate_conflict`.
 */
function refuseMarkedDedupe(bugFix: BugFixRequest, existing: OpenGate): AppError {
  return isAuthorizationForBugCard(existing, bugFix.bug_card_id)
    ? bugCardAlreadyHasApproval(bugFix.bug_card_id, existing)
    : openGateConflict(bugFix.bug_card_id, existing);
}

/**
 * A marked request may be answered with `existing` (a dedupe) ONLY when it is the same
 * request; otherwise a 409 chosen by `refuseMarkedDedupe`. Unmarked (`bugFix` null): no-op.
 * `requestKind` is the kind the caller would mint (execution.ready_signoff on the
 * execution-approvals door, generic on webhooks card-approval).
 */
export function assertSameBugFixRequest(existing: OpenGate, bugFix: BugFixRequest | null, requestKind: string): void {
  if (!bugFix) return;
  if (!isSameBugFixRequest(existing, bugFix, requestKind)) throw refuseMarkedDedupe(bugFix, existing);
}

/**
 * `mintOneOpenGate`, with the bug-fix index's 23505 mapped (see the module header).
 * `bugFix` is the validated marker (resolveBugFixAuthorizationMint) or null for an unmarked
 * row, for which this is exactly `mintOneOpenGate`.
 */
export async function mintGateOnePerBugCard(
  params: Parameters<typeof mintOneOpenGate>[0],
  bugFix: BugFixRequest | null,
): Promise<{ gate: OpenGate; deduplicated: boolean }> {
  const requestKind = params.values.kind ?? APPROVALS_DEFAULT_KIND;
  let minted: { gate: OpenGate; deduplicated: boolean };
  try {
    minted = await mintOneOpenGate(params);
  } catch (err) {
    if (!bugFix || !isBugFixAuthorizationUniqueViolation(err)) throw err;
    // The winner committed before our INSERT could raise (a unique check waits for the
    // conflicting transaction), so this read-committed SELECT sees it.
    const existing = await findBugFixApprovalForCard(params.tenantId, bugFix.bug_card_id);
    if (existing && isSameBugFixRequest(existing, bugFix, requestKind)) {
      return { gate: existing, deduplicated: true };
    }
    // This index holds ONLY marked rows keyed on this bug card, so the row we collided with
    // is this bug card's authorization by construction — `existing` is the read's answer,
    // never an unmarked gate. (null: the holder vanished between the raise and the read; the
    // conflict was still with a marked row, so the code stays.)
    throw existing ? refuseMarkedDedupe(bugFix, existing) : bugCardAlreadyHasApproval(bugFix.bug_card_id, null);
  }
  // The generic one-open-gate onConflict re-read hands back whatever pending row holds this
  // decision card; for a marked request that is a dedupe only if it is the same request.
  if (minted.deduplicated) assertSameBugFixRequest(minted.gate, bugFix, requestKind);
  return minted;
}
