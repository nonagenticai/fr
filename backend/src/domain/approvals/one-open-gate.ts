// domain/approvals/one-open-gate.ts
//
// ONE OWNER for "does this card already have a gate holding it?".
//
// The rule existed, was measured, was carefully commented — and lived inside
// ONE of the two routes that mint approvals. `routes/webhooks.ts` suppressed a
// duplicate; `routes/execution-approvals.ts` inserted unconditionally. So the
// answer to "can this card get a second pending approval?" depended on which
// door the request came through, which is the same asymmetry that path has
// already been fixed for twice (it also set no triage at all until 2026-09-01,
// while its sibling always had).
//
// MEASURED 2026-08-30 against the complete tenant population (585 rows):
//   101 live pending rows for only 69 distinct (card_id, kind) pairs
//   24 pairs carried more than one live row, accounting for 56 of the 101
//   every refutation in that triage run was this one defect (32 of 101)
// and earlier, 2026-08-26: seven cards each carried TWO pending approvals with
// ZERO `moveCard` rows between the mints — double-mints on an UNCHANGED card,
// not a card released and re-blocked. That discriminator matters: re-block
// hardening (cooldowns, exit guards) would not have touched a single one.
//
// ⚠️ NOT KIND-SCOPED, deliberately. The two producers mint different KINDS for
// the same stuck card: `execution.ready_signoff` within ~1s of READY→BLOCKED,
// then `generic` 23s-11min later because the first blocked the card without
// persisting a reason. A kind-scoped guard would fire on NEITHER. The question a
// human faces is "why is this card stuck", and it has one answer, so the card
// gets one gate.
//
// INDEXED since migration 114. The read below was a bare SELECT and the callers
// INSERTed unconditionally, so two n8n executions for one card both read null and
// both minted: MEASURED 39 consecutive mints on one (tenant, card) within 60s,
// tightest pair 57ms apart, and 352 duplicate gates carried 352 duplicate
// notifications — a human paged twice, and asked to decide twice, for one stuck
// card. The read cannot close that on its own; `mintOneOpenGate` below makes the
// insert itself the arbiter, against the partial unique index.

import { and, asc, eq, sql } from 'drizzle-orm';

import {
  db,
  approvals,
  projects,
  projectRequests,
  streams,
  userRoles,
} from '../../db/client';
import { deadlineFromHours } from '../../lib/approval-deadline';
import {
  ANSWERABILITY_REFUSAL_CODE,
  answerabilityEnforces,
  answerabilityRefusalMessage,
  classifyAnswerability,
  type AnswerabilityReason,
} from '../../lib/approval-answerability';
import { reportAnswerability } from '../../lib/approval-answerability-metrics';
import { ValidationError } from '../../utils/errors';
import { stripDecideOwnedMetadata } from '../engagement/deblock-actions';

/**
 * The full pending row. Returned whole rather than projected because the two
 * callers answer in DIFFERENT response envelopes — `webhooks.ts` replies
 * `{ approval_id, deduplicated }`, `execution-approvals.ts` replies
 * `{ data: { id, kind, status, ... } }` — and a dedup response must match the
 * shape its OWN route already promises, or a caller reading `data.id` breaks
 * and the response-envelope ratchet flags the route.
 */
export type OpenGate = typeof approvals.$inferSelect;

/**
 * The approval already holding this card, or null.
 *
 * Callers return the existing row rather than 409-ing: the caller
 * (`blocked-escalate :: Call FR`) reads `frResult.approval_id || null`, so a 200
 * carrying the row that IS holding the card is the honest answer to "make sure
 * this card has a gate". A second row would not add a gate — it would add a
 * second thing for a human to decide about one stuck card.
 */
export async function findOpenGateForCard(params: {
  tenantId: string;
  cardId: string | null | undefined;
}): Promise<OpenGate | null> {
  if (!params.cardId) return null;
  const [existing] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.tenant_id, params.tenantId),
        eq(approvals.card_id, params.cardId),
        eq(approvals.status, 'pending'),
      ),
    )
    // OLDEST first, explicitly. This was a bare `limit(1)` over an unordered
    // scan, so with duplicates present it could return a DIFFERENT row per call
    // — two reads of "the gate holding this card" disagreeing. Migration 114
    // keeps the oldest row and voids the rest, so the tie-break here is the same
    // rule the migration applied; `id` breaks an exact `created_at` tie so the
    // answer is total, not merely usually-stable.
    .orderBy(asc(approvals.created_at), asc(approvals.id))
    .limit(1);
  return existing ?? null;
}

/** Uniform log line, so a suppression reads the same from either door. */
export function describeSuppression(
  route: string,
  cardId: string,
  existing: OpenGate,
): string {
  const minted =
    existing.created_at instanceof Date
      ? existing.created_at.toISOString()
      : String(existing.created_at);
  return (
    `[${route}] approval for card ${cardId} SUPPRESSED as a duplicate: ` +
    `approval ${existing.id} (kind=${existing.kind}, minted ${minted}) is already ` +
    'pending on this card. Returning it instead of minting a second gate.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ANSWERABILITY — the gate that refuses to mint an approval nobody could ever
// discharge.
// ═══════════════════════════════════════════════════════════════════════════
//
// ⭐ WHY IT LIVES HERE AND NOWHERE ELSE. This file already holds the ONE
// sentence every n8n-facing producer must pass through: "the INSERT itself has
// to be the arbiter". Three doors mint through `mintOneOpenGate` (a fourth,
// POST /api/improvement/approvals, was deleted 2026-11-03) —
//
//   POST /api/webhooks/n8n/card-approval      (routes/webhooks.ts, kind=generic)
//   POST /api/webhooks/n8n/approval-request   (routes/webhooks.ts, kind=generic)
//   POST /api/execution/approvals             (routes/execution-approvals.ts)
//
// — and that is the complete set of producers in the measured 7-day table that
// mints on behalf of an n8n workflow. Putting the check in any ONE route repeats the exact
// asymmetry this file was created to delete: for two releases the one-open-gate
// rule lived inside `webhooks.ts` and `execution-approvals.ts` inserted
// unconditionally, so the answer to "can this card get a second gate?" depended
// on which door the request came through. A validation in a route is a
// validation the next route forgets.
//
// ⛔ FOUR INSERT PATHS DO *NOT* PASS THROUGH HERE, AND THEY ARE OUT OF SCOPE ON
// PURPOSE — named rather than silently uncovered:
//   * `domain/bridge/submit.ts`             (source='bridge', human CP review)
//   * `domain/engagement/action-approvals.ts` (AG-UI action gates)
//   * `routes/approvals.ts` (~:1912)         (source='web', human self-service)
//   * `routes/project-request-lifecycle.ts`  (kind='project_outline.approval')
//
// The first three are HUMAN-AUTHORED rows: each sets `requester_id` to the
// authenticated caller and each writes its own `expires_at`, so a human IS the
// requester by construction and the arms this gate applies cannot fire on them.
// None of the three appears in the measured 7-day producer table.
//
// ⚠️ THE FOURTH IS DIFFERENT AND THE DIFFERENCE IS WORTH STATING PRECISELY,
// because the obvious shorthand ("the other inserts are not n8n") is FALSE:
// `routes/project-request-lifecycle.ts` writes `source: 'n8n'` and it IS in the
// measured table (2 rows in 7 days, both `expires_at IS NULL`, both lacking
// card_type and gate_terms). It is fixed AT ITS PRODUCER rather than routed
// through here, for a reason this chokepoint cannot get around: it is fr's own
// code and it HOLDS the outline, so it can state a real `card_type`, real
// `gate_terms` derived from the proposer's own deliverables, and a deadline —
// none of which this gate could do except by inventing them. Routing it here
// would make the row lie better, not be more correct.
//
// ⚠️ MODE. Default `observe`: every row below is minted exactly as it is today
// and the only effect is a counter plus one log line. Refusal is armed solely
// by `FR_APPROVAL_ANSWERABILITY_MODE=enforce`. See lib/approval-answerability.ts
// for why a default-refuse would be a fleet-wide outage rather than a fix.

/** A derivation that succeeded, and where it came from. `null` = nothing found. */
interface Derived {
  value: string;
  from: string;
}

/**
 * Derive the human this approval is FROM, using only values already present in
 * the request's own object graph.
 *
 * ⛔ FOUR HONEST SOURCES, IN OWNERSHIP ORDER — and nothing else. Every step
 * follows an existing foreign key from a field the producer itself supplied, so
 * the answer is a fact fr already holds rather than a plausible human:
 *
 *   1. `project_id`         -> `projects.owner_id`
 *   2. `project_request_id` -> `project_requests.created_by`
 *   3. `metadata.requested_by_user_id` — the JWT door stamps this AFTER the
 *      caller's metadata spread (routes/execution-approvals.ts), so it cannot
 *      be forged, and it names the human who actually raised the gate.
 *   4. `metadata.stream_id` -> `streams.project_id` -> `projects.owner_id`.
 *      ⭐ THIS IS THE STEP THAT MATTERS: 105 of the 106 measured `generic`
 *      rows are stream-only (`project_source='stream_only'`), which is exactly
 *      why `resolveCardApprovalRequesterId(projectId)` returns NULL for them —
 *      it is handed a null project. Migration 120 gave `streams` a
 *      `project_id` (the fr project whose repository the stream's work
 *      targets), so a stream-raised approval DOES have an owner reachable in
 *      two hops. Nobody was making them.
 *
 * ⛔ WHAT IS DELIBERATELY NOT A SOURCE: the tenant's workspace-admin, the
 * fallback approver, or the approver of this very row. Each would produce a
 * non-null `requester_id` and a green metric while attesting that a person
 * asked for something they have never heard of. `lib/approval-rationale.ts`
 * states the rule one file over — fr never writes what it was not given — and
 * a fabricated requester is worse than a NULL one, because the NULL at least
 * stops an approver from trusting the attribution.
 *
 * ⚠️ NEVER THROWS. A lookup failure returns null, which classifies as
 * `requester_unresolvable` and — in observe mode — changes nothing. A database
 * wobble must not become a 500 on the n8n ingest path.
 */
async function resolveRequesterId(
  values: typeof approvals.$inferInsert,
): Promise<Derived | null> {
  const meta =
    values.metadata && typeof values.metadata === 'object' && !Array.isArray(values.metadata)
      ? (values.metadata as Record<string, unknown>)
      : {};

  try {
    if (values.project_id) {
      const [row] = await db
        .select({ owner_id: projects.owner_id })
        .from(projects)
        .where(eq(projects.id, values.project_id))
        .limit(1);
      if (row?.owner_id) return { value: row.owner_id, from: 'project.owner_id' };
    }

    if (values.project_request_id) {
      const [row] = await db
        .select({ created_by: projectRequests.created_by })
        .from(projectRequests)
        .where(eq(projectRequests.id, values.project_request_id))
        .limit(1);
      if (row?.created_by) {
        return { value: row.created_by, from: 'project_request.created_by' };
      }
    }

    const jwtCaller = meta.requested_by_user_id;
    if (typeof jwtCaller === 'string' && jwtCaller.trim()) {
      return { value: jwtCaller.trim(), from: 'metadata.requested_by_user_id' };
    }

    const streamId = meta.stream_id;
    if (typeof streamId === 'string' && streamId.trim()) {
      const [row] = await db
        .select({ owner_id: projects.owner_id })
        .from(streams)
        .innerJoin(projects, eq(projects.id, streams.project_id))
        .where(eq(streams.id, streamId.trim()))
        .limit(1);
      if (row?.owner_id) {
        return { value: row.owner_id, from: 'stream.project.owner_id' };
      }
    }
  } catch (err) {
    console.warn(
      '[one-open-gate] requester derivation failed (treated as unresolvable, not as an error): ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return null;
}

/**
 * Does the named approver hold ANY role in this approval's tenant?
 *
 * `user_roles` is fr's own tenant-membership table — it is what
 * `resolveApprover` reads to find a tenant's workspace-admins — so "has a row
 * here under this tenant_id" IS fr's definition of membership. Any role
 * counts: the question is standing in the tenant, not seniority.
 *
 * ⚠️ RETURNS `null` — NOT ESTABLISHED — when there is no approver to check or
 * the lookup throws, and `classifyAnswerability` treats `null` as answerable.
 * This arm FAILS OPEN on purpose: a Postgres wobble presenting as "every
 * approval is unanswerable" is the single most likely way a correct gate gets
 * blamed and reverted (the same reasoning `board_lookup_failed` is split out
 * for in board-tenant-gate-metrics.ts).
 */
async function approverIsTenantMember(
  tenantId: string,
  approverUserId: string | null | undefined,
): Promise<boolean | null> {
  if (!approverUserId || !approverUserId.trim()) return null;
  try {
    const [row] = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.tenant_id, tenantId),
          eq(userRoles.user_id, approverUserId.trim()),
        ),
      )
      .limit(1);
    return Boolean(row);
  } catch (err) {
    console.warn(
      '[one-open-gate] approver tenant-membership lookup failed (NOT ESTABLISHED, fails open): ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }
}

const UUID_IN_STRING =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The tenant named INSIDE `metadata.policy_key`, when it disagrees with the
 * tenant fr resolved for the row. `null` when they agree, when no policy_key
 * was sent, or when it embeds no tenant at all.
 *
 * ⛔ WHICH SIDE WINS, AND WHY IT IS NOT A CHOICE. `approvals.tenant_id` is
 * resolved from fr's OWN ownership chain (board -> project -> department ->
 * workspace, or board -> stream) and is the column every authorization site
 * reads to decide who may see and decide the row. `policy_key` is a
 * producer-supplied string on a `.passthrough()` metadata object. Deriving the
 * tenant FROM the policy key would let a producer move a gate into a tenant
 * that never owned the work — a cross-tenant authorization defect, strictly
 * worse than the mislabelling it would fix.
 *
 * ⭐ So the two are NOT reconciled by picking one. The resolved tenant stands,
 * and the disagreement is written onto the row as evidence
 * (`metadata.policy_key_tenant_mismatch`) and counted, so it is surfaced rather
 * than silently chosen. This is the live cause of the tenant-scoped count split
 * in fr#1140: 9 `execution.ready_signoff` rows in 7 days tagged `…0003` while
 * their own policy_key names `…0001`.
 *
 * The extraction is a UUID search rather than an equality test because
 * `policy_key` is a composite key, not a bare id — anything with no UUID in it
 * names no tenant and yields no finding. Substring, so `<uuid>`,
 * `policy:<uuid>:ready` and `<uuid>/v3` all resolve identically.
 */
function policyKeyTenantMismatch(
  tenantId: string,
  metadata: unknown,
): string | null {
  const meta =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const policyKey = meta.policy_key;
  if (typeof policyKey !== 'string' || !policyKey.trim()) return null;
  const named = UUID_IN_STRING.exec(policyKey)?.[0];
  if (!named) return null;
  return named.toLowerCase() === tenantId.toLowerCase() ? null : named.toLowerCase();
}

/**
 * The gate. Resolves what it honestly can, counts everything, and refuses only
 * under `FR_APPROVAL_ANSWERABILITY_MODE=enforce`.
 *
 * ⭐ RESOLUTION RUNS IN BOTH MODES, and that is deliberate rather than a leak
 * of enforcement into the observe path. A resolution only ever fills a column
 * that was about to be written NULL, from a value fr already held — it takes
 * nothing away from any reader and cannot refuse anything. Gating it behind the
 * flag would mean the observe window ships the measurement without the part
 * that actually makes rows answerable, and the counter would then measure a
 * defect the flag flip is supposed to have already shrunk.
 *
 * ⚠️ THE COST, STATED HONESTLY. The requester derivation runs ONLY when
 * `requester_id` is absent, so a row that already carries one pays nothing for
 * it. The membership lookup is NOT conditional and cannot be: "is this approver
 * in this tenant?" has no cheap pre-check, so every mint naming an approver
 * pays one indexed single-row `user_roles` read. That is one extra round trip
 * on a path already performing an INSERT, and it is the price of the arm.
 *
 * ⚠️ A REQUEST THAT WILL DEDUPLICATE STILL PASSES THROUGH HERE, and under
 * enforce it can be refused rather than answered with the existing gate. That
 * is deliberate: the producer sent an unanswerable request, and the fact that
 * some earlier request already gated the card does not make this one well
 * formed. In observe mode nothing changes — the row is minted or deduplicated
 * exactly as before and the event is only counted.
 *
 * Returns the values to insert — possibly with `requester_id`, `expires_at` and
 * `metadata.policy_key_tenant_mismatch` filled in. Throws `ValidationError`
 * (code `approval_unanswerable`) only in enforce mode.
 */
export async function ensureAnswerable(params: {
  tenantId: string;
  cardId: string | null | undefined;
  values: typeof approvals.$inferInsert;
}): Promise<typeof approvals.$inferInsert> {
  const values = { ...params.values };
  const kind = values.kind ?? 'generic';
  const report = (
    reason: AnswerabilityReason,
    outcome: 'resolved' | 'observed' | 'refused' | 'clean',
    extra?: { resolvedFrom?: string; detail?: Record<string, unknown> },
  ): void =>
    reportAnswerability({
      reason,
      kind,
      outcome,
      cardId: params.cardId ?? null,
      tenantId: params.tenantId,
      callbackPath: values.callback_path ?? null,
      resolvedFrom: extra?.resolvedFrom ?? null,
      detail: extra?.detail,
    });

  // ── RESOLVE FIRST ──────────────────────────────────────────────────────────
  // "A refusal that could have been a resolution is a worse outcome than the
  // defect" — so every derivable value is derived BEFORE anything is classified.

  if (!values.requester_id) {
    const derived = await resolveRequesterId(values);
    if (derived) {
      values.requester_id = derived.value;
      report('requester_unresolvable', 'resolved', { resolvedFrom: derived.from });
    }
  }

  if (values.expires_at == null) {
    // `deadlineFromHours(null)` is the tenant default (DEFAULT_TTL_DAYS = 14),
    // an explicit operator decision recorded in lib/approval-deadline.ts. It is
    // reused rather than re-derived so this gate and the reaper can never
    // disagree about what "no deadline was asked for" means.
    values.expires_at = deadlineFromHours(null);
    report('deadline_absent', 'resolved', { resolvedFrom: 'approval-deadline.DEFAULT_TTL_DAYS' });
  }

  const mismatch = policyKeyTenantMismatch(params.tenantId, values.metadata);
  if (mismatch) {
    // Recorded ON THE ROW, not just in a log line that dies with the pod. The
    // evidence has to survive to whoever asks later why the tenant-scoped
    // counts split. Written AFTER the producer's metadata, so a producer
    // cannot forge or blank it.
    values.metadata = {
      ...(values.metadata && typeof values.metadata === 'object' && !Array.isArray(values.metadata)
        ? (values.metadata as Record<string, unknown>)
        : {}),
      policy_key_tenant_mismatch: {
        policy_key_tenant: mismatch,
        row_tenant: params.tenantId,
      },
    } as typeof values.metadata;
  }

  // ── THEN CLASSIFY WHAT IS LEFT ─────────────────────────────────────────────
  const reasons = classifyAnswerability({
    requesterId: values.requester_id,
    approverUserId: values.approver_user_id,
    approverIsTenantMember: await approverIsTenantMember(
      params.tenantId,
      values.approver_user_id,
    ),
    expiresAt: values.expires_at,
    metadata: values.metadata,
    policyKeyTenantMismatch: mismatch,
  });

  if (reasons.length === 0) {
    report('none', 'clean');
    return values;
  }

  // ⚠️ `tenant_policy_key_mismatch` is REPORTED but never REFUSED, even under
  // enforce. The row is fully answerable — a human can read it and decide it —
  // and the mislabelling is the producer's policy lookup, not a dead gate. It
  // rides this counter because it is the same class of producer defect and
  // wants the same dashboard; refusing on it would stop 9 perfectly decidable
  // sign-offs a week to punish a label.
  const refusable = reasons.filter((r) => r !== 'tenant_policy_key_mismatch');
  const enforcing = answerabilityEnforces() && refusable.length > 0;

  for (const reason of reasons) {
    report(
      reason,
      reason === 'tenant_policy_key_mismatch'
        ? 'observed'
        : enforcing
          ? 'refused'
          : 'observed',
      reason === 'tenant_policy_key_mismatch'
        ? { detail: { policy_key_tenant: mismatch } }
        : undefined,
    );
  }

  if (enforcing) {
    throw new ValidationError(
      answerabilityRefusalMessage(refusable, params.cardId),
    ).withCode(ANSWERABILITY_REFUSAL_CODE);
  }

  return values;
}

/**
 * Mint the gate for this card, or return the one that already holds it.
 *
 * ⚠️ THE READ ABOVE IS NOT A GUARD. `findOpenGateForCard` is a cheap pre-check
 * that saves the triage/fan-out work in the common case; it cannot make the
 * decision, because between its SELECT and the caller's INSERT another request
 * can mint. That gap is the whole of fr#1000. The INSERT itself has to be the
 * arbiter, so this does the check and the write in ONE statement against the
 * partial unique index from migration 114.
 *
 * Correctness under pgbouncer TRANSACTION pooling (fr's actual topology, which
 * is why `pg_advisory_lock` is unusable here and every lock in this repo is
 * `pg_advisory_xact_lock`): `ON CONFLICT DO NOTHING` takes a speculative
 * insertion lock, so a loser BLOCKS until the winner commits and then gets zero
 * rows back. The follow-up read runs as its own read-committed statement and
 * therefore sees the committed winner. No connection is held across triage or
 * fan-out — each statement is a single round trip.
 *
 * The loser re-reads rather than trusting its own earlier SELECT, because the
 * row it must return is the one that WON, not the one it hoped to write.
 */
export async function mintOneOpenGate(params: {
  tenantId: string;
  // Nullable on purpose, so a caller never has to branch. A row with no card_id
  // does not match the index predicate (`card_id IS NOT NULL`), so the conflict
  // clause is simply inert for it — an approval that gates no card cannot be a
  // duplicate gate, and there is nothing to dedupe against.
  cardId: string | null | undefined;
  values: typeof approvals.$inferInsert;
}): Promise<{ gate: OpenGate; deduplicated: boolean }> {
  // ⭐ THE ANSWERABILITY GATE RUNS HERE, INSIDE THE MINTER — not in the four
  // routes that call it. A route-level check is a check the fifth door forgets,
  // which is the precise history of the one-open-gate rule below it. It may
  // rewrite `values` (resolutions) and, under
  // `FR_APPROVAL_ANSWERABILITY_MODE=enforce` only, throw.
  //
  // ⚠️ BEFORE the insert, deliberately. Refusing after the write would leave the
  // unanswerable row in place and merely fail the response — the inverse of the
  // intent. A deduplicated request never reaches this line's write either: the
  // insert below is still the arbiter, so a losing racer resolves nothing and
  // returns the winner's row.
  // ⛔ DECIDE-OWNED KEYS NEVER COME FROM A MINTER. `coverage_decision` and `new_card_type`
  // are written only by the decide path; stripped here — the one door every minter passes —
  // so an expired/voided row can never carry a verdict nobody gave.
  const values = await ensureAnswerable({
    ...params,
    values: { ...params.values, metadata: stripDecideOwnedMetadata(params.values.metadata) },
  });

  // Two attempts, not a loop: the only way a conflict is followed by an empty
  // re-read is the winner resolving (approved/expired/voided) in the microseconds
  // between, which frees the partial index and makes a fresh insert legal. That
  // can happen once as a race; if it happens twice the premise is wrong and a
  // silent null would hand the caller "no gate" for a card it just tried to gate.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [row] = await db
      .insert(approvals)
      // The RESOLVED values, not `params.values` — the derived requester and
      // deadline must reach the row, or the gate would measure a resolution it
      // never actually wrote.
      .values(values)
      .onConflictDoNothing({
        target: [approvals.tenant_id, approvals.card_id],
        // MUST match migration 114's index predicate exactly, or Postgres finds
        // no arbiter index and raises 42P10 instead of doing nothing — which
        // would surface as a 500 on every mint, not just the racing ones.
        //
        // `where`, not `targetWhere`: on this drizzle (0.45.2) `onConflictDoNothing`
        // accepts only `{ target, where }`, and with no SET clause there is no
        // ambiguity — `where` IS the arbiter's index predicate. `targetWhere`
        // belongs to `onConflictDoUpdate` and does not typecheck here. The emitted
        // SQL is asserted in the unit test rather than trusted from the option name.
        where: sql`status = 'pending' AND card_id IS NOT NULL`,
      })
      .returning();
    if (row) return { gate: row, deduplicated: false };

    const existing = await findOpenGateForCard(params);
    if (existing) return { gate: existing, deduplicated: true };
  }

  throw new Error(
    `one-open-gate: card ${params.cardId} (tenant ${params.tenantId}) conflicted on ` +
      'insert twice, and no pending gate was found either time. Refusing to report ' +
      'a gate that does not exist.',
  );
}
