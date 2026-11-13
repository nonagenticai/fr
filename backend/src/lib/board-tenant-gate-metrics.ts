// src/lib/board-tenant-gate-metrics.ts
//
// ⛔ WHAT THIS COUNTS: a write or read that `lib/board-tenant-access.ts` REFUSED.
//
// Why it exists
// -------------
// PR #1136 narrows who may write to a board. `assertBoardTenantWritable` /
// `assertCardTenantWritable` are `assertBoardTenantAuthorized` MINUS the
// internal-tenant allow, which closes a live widening: before them, any
// authenticated user in any tenant could grant board/card membership on all 12
// live internal-tenant boards, because the route wrote with the ADMIN agent and
// the read gate's branch 3 (`if (isInternalTenant(owningTenant)) return`) let
// them through. That fix is correct. It is also INVISIBLE.
//
// ⭐ A REFUSAL HERE IS SILENT, AND A SILENT REFUSAL IS A NON-EVENT. The gate's
// only exit on the refusal path is `throw new NotFoundError('Board not found')`
// — deliberately a 404, deliberately indistinguishable from a board that does
// not exist, so nothing leaks across tenants. The module logged ONLY on lookup
// FAILURE (the two `console.error` lines), never on the refusal itself. So a
// human who could assign a card yesterday and cannot today produces: a card
// that snaps back in the UI, no log line, no metric, no error budget burn, and
// no way for us to learn it happened. The upper bound on the affected
// population is every authenticated non-super-admin user, because the READ gate
// makes internal boards appear in `handleListBoards` — the boards are visible
// to everyone, so anyone can try to act on one.
//
// ⭐ THE TWO POPULATIONS ARE OPPOSITE FACTS, AND `reason` IS WHAT SEPARATES THEM.
// `tenant_mismatch` is a refusal the PRE-#1136 code would ALSO have made — the
// boundary working as it always did, uninteresting, and the denominator. The
// one worth watching is `internal_board_write`: an internal/system-owned board
// refused to a foreign tenant, which is EXACTLY and ONLY the branch the fix
// removed. See `BOARD_TENANT_REFUSAL_REASONS` below for why that classification
// is exact rather than a heuristic.
//
// ⚠️ A REFUSAL IS NOT AUTOMATICALLY A BUG, and this counter does not decide
// that. `internal_board_write` counts the widening being CLOSED, which is the
// intended effect of the PR; it is worth a number because it is also the only
// place a legitimate human workflow can have been broken by it. Nonzero means
// "look", not "revert".
//
// ⛔ WHY A SIBLING MODULE AND NOT `conveyor-refusal-metrics.ts`. The mechanism
// below is that module's, deliberately copied line-for-line in shape: closed
// label sets, pre-seeded to zero, an increment-only recorder, a `report*` that
// also emits one structured line and a `render*` for routes/metrics.ts. What is
// NOT reused is its COUNTER, for two
// reasons, the second of which is a measured defect and not a taste argument:
//
//   1. `fr_conveyor_inbound_refused_total` is documented as, and alerted on as,
//      "an INBOUND CONVEYOR request that fr refused" — n8n and the Claude
//      sessions calling INTO fr. This gate refuses HUMAN browser traffic
//      (a card drag, a member assignment, a relation link). Filing those under
//      a conveyor counter would misattribute the traffic and corrupt the one
//      number the conveyor's own dark-channel alert is written against.
//   2. `CONVEYOR_SURFACES` is closed AND `renderConveyorRefusalMetrics` loops
//      over that same constant — but `recordConveyorRefusal` normalises only
//      the REASON, never the surface. So a caller passing a surface outside the
//      list mints a map entry that is incremented and then NEVER EXPORTED: the
//      count is silently unreachable. Reusing the counter therefore requires
//      editing `CONVEYOR_SURFACES` itself, which is the shared dependency of
//      `routes/kanban/comments.ts`.
//
// ⛔ THE COUNTER IS THE DURABLE HALF, NOT THE LOG — the same split
// `conveyor-refusal-metrics.ts` documents. `console.error` names the board, the
// card and the user, which is what a human needs to chase one report; that line
// dies with the pod. Prometheus scrapes `/metrics` and retains, so the counter
// is what survives a restart and what an alert can be written against. Both are
// emitted on purpose; neither substitutes for the other.
//
// Cardinality: gate x reason, both CLOSED sets, pre-seeded to zero — 24 series,
// fixed. Board ids, card ids, user ids and tenant ids are LOG-ONLY and never
// labels; they are unbounded and would mint a series per board. The zero
// baseline is deliberate: a series that only appears once it fires cannot be
// distinguished from an exporter that is not wired up, and here that matters
// more than usual — the expected steady state of `internal_board_write` is
// ZERO, so the zero IS the measurement.
//
// Lives in `lib/` for the same reason `conveyor-refusal-metrics.ts` does: it
// must not transitively import `db/client`, so the hermetic kanban unit tests
// that run with no database can still import the callers.

import { tryGetRequestContext } from '../middleware/request-context';

/**
 * WHICH GATE REFUSED. The four exported entry points of
 * `lib/board-tenant-access.ts`, kept distinct because read and write mean
 * opposite things here: a `board_read` / `card_read` refusal is the long-
 * standing tenant boundary, while a `board_write` / `card_write` refusal is the
 * surface #1136 narrowed.
 *
 * ⚠️ This is also the finest ROUTE attribution available without changing the
 * gate's signature. The gate is called as `assert*(user, id)` from five route
 * modules owned by other work; it receives no route or operation name, and
 * `RequestContext` carries no path or method (correlationId, initiator,
 * channel, tenantId, userId, subjectId, activeTenant*, jwtTenantId — no path).
 * Adding an `operation` parameter that no caller passes would be a label no
 * caller can produce. `initiator` and `channel` ride in the log line instead,
 * and the correlation id joins a refusal to its request.
 */
export const BOARD_TENANT_GATES = [
  /** `assertBoardTenantAuthorized` — handleGetBoard. */
  'board_read',
  /**
   * `assertBoardTenantWritable` / `assertListTenantWritable` — handleMoveCard,
   * handleCreateCard (list-keyed), handleLinkRelation.
   */
  'board_write',
  /** `assertCardTenantAuthorized` — the card-keyed read boundary. */
  'card_read',
  /**
   * `assertCardTenantWritable` — the kept card writes in routes/kanban
   * (update / duplicate / delete / comment create / label attach+detach).
   */
  'card_write',
] as const;
export type BoardTenantGate = (typeof BOARD_TENANT_GATES)[number];

export const BOARD_TENANT_REFUSAL_REASONS = [
  /**
   * ⭐ THE NEW POPULATION — the only reason on this list that did not exist as
   * a refusal before #1136, and the one worth alerting on.
   *
   * The board resolved to an INTERNAL/system tenant and the gate refused
   * anyway. That combination is reachable from exactly one place: the write
   * gate. The read gate returns on `allowInternal && isInternalTenant(...)`
   * before the throw, so if control arrives at the refusal with an internal
   * owning tenant then `allowInternal` was necessarily FALSE.
   *
   * ⭐ WHY THIS IS EXACT AND NOT A HEURISTIC. The pre-#1136 gate was a single
   * predicate, equivalent to today's `allowInternal: true` — it allowed iff
   * short-circuit OR `isInternalTenant(owning)` OR `owning === active`. Today's
   * write gate refuses iff NOT short-circuit AND NOT `owning === active`. So a
   * refusal is NEW precisely when the old code's surviving allow would have
   * fired, i.e. precisely when `isInternalTenant(owningTenant)`. No timestamp,
   * no shadow evaluation, no second predicate to drift: the discriminator is
   * the branch that was deleted, read at the moment it would have fired.
   *
   * ⚠️ THE HONEST LIMIT, on a DIFFERENT axis. This label counts "the
   * internal-tenant allow was dropped", not "this route had no fr-side gate
   * before". Since 2026-10-10 fr acts in Planka as ONE configured account (per
   * tenant, not per user), so every kanban route is gated by fr alone and
   * Planka board membership refuses nothing; `tenant_mismatch` therefore also
   * counts refusals Planka's membership check used to make before fr saw them.
   * `board_write` is shared by several callers and nothing in the label set
   * separates them; join the `board_tenant_gate_refused` log line to the
   * `[http]` access line on `cid=` to attribute one refusal to its route (a
   * LOG join — it dies with the pod and cannot back an alert).
   *
   * ⛔ Do NOT "fix" this by minting a relations-specific gate label. The gate
   * receives no route name (see `BOARD_TENANT_GATES`' note above), these four
   * values name the PREDICATE that refused rather than the caller, and a fifth
   * invented to carry route identity would make `gate` mean two things at once
   * — the same failure this module's header refuses for the conveyor counter.
   * Merging two different meanings into one series is how a metric stops
   * meaning anything.
   */
  'internal_board_write',
  /**
   * The board resolved to a tenant that is neither internal nor the caller's
   * active tenant. The ordinary cross-tenant boundary — the PRE-#1136 code
   * refused this identically, on both the read and the write path. Expected,
   * uninteresting, and the DENOMINATOR that makes `internal_board_write`
   * readable as a share rather than a bare count.
   */
  'tenant_mismatch',
  /**
   * fr row 14d-2: a PLATFORM-owned board/card READ refused to a caller whose
   * active tenant is not a platform tenant. Before 14d-2 the read gate allowed
   * any caller onto an internal-tenant board; this is that allow being closed.
   * Read gates only (`board_read` / `card_read`). Expected steady state: 0 —
   * Planka members of platform boards are service accounts only (M-14d-2 §2).
   */
  'platform_board_foreign_read',
  /**
   * `resolveBoardTenant` returned null: fr owns no `projects` row and no
   * `streams` row for that `planka_board_id`. An ad-hoc Planka board, or an fr
   * row that lost its `planka_board_id`. Also refused identically before
   * #1136 — but split out because the REMEDY differs (reconcile fr's rows,
   * rather than move a user between tenants).
   */
  'board_tenant_unknown',
  /**
   * The `resolveBoardTenant` query THREW. fr's own database is unreachable or
   * sick, and the gate failed CLOSED.
   *
   * ⛔ Not an authorization event at all — an OUTAGE wearing an authorization
   * event's clothes. Counted separately and deliberately: without it, a
   * Postgres wobble presents as a spike in refusals and reads as "the new gate
   * is refusing everyone", which is the single most likely way this PR gets
   * wrongly reverted.
   */
  'board_lookup_failed',
  /**
   * The card→board resolution failed: the agent `GET /api/cards/:id` threw
   * (Planka 4xx/5xx/timeout, agent login failure) or returned no `boardId`.
   * Same reading as `board_lookup_failed` — fail-closed on an upstream, not a
   * judgement about the caller — for the card-keyed gates.
   */
  'card_lookup_failed',
  'other',
] as const;
export type BoardTenantRefusalReason =
  (typeof BOARD_TENANT_REFUSAL_REASONS)[number];

const key = (g: BoardTenantGate, r: BoardTenantRefusalReason): string =>
  `${g}|${r}`;

const refusals = new Map<string, number>();
for (const g of BOARD_TENANT_GATES) {
  for (const r of BOARD_TENANT_REFUSAL_REASONS) refusals.set(key(g, r), 0);
}

function normaliseGate(gate: string): BoardTenantGate {
  return (BOARD_TENANT_GATES as readonly string[]).includes(gate)
    ? (gate as BoardTenantGate)
    : 'board_write';
}

function normaliseReason(reason: string): BoardTenantRefusalReason {
  return (BOARD_TENANT_REFUSAL_REASONS as readonly string[]).includes(reason)
    ? (reason as BoardTenantRefusalReason)
    : 'other';
}

/**
 * Increment only.
 *
 * ⚠️ BOTH labels are normalised, unlike the conveyor sibling which normalises
 * only the reason. An un-normalised label is not a cosmetic difference here:
 * `renderBoardTenantGateRefusalMetrics` below loops over the two constants, so
 * a map entry outside them would be counted and never exported — a refusal that
 * increments a number nobody can read.
 */
export function recordBoardTenantGateRefusal(
  gate: BoardTenantGate,
  reason: BoardTenantRefusalReason,
): void {
  const k = key(normaliseGate(gate), normaliseReason(reason));
  refusals.set(k, (refusals.get(k) ?? 0) + 1);
}

export interface BoardTenantRefusalDetail {
  gate: BoardTenantGate;
  reason: BoardTenantRefusalReason;
  /** Planka board id. Named in the log line, never in a label. */
  boardId?: string | null;
  /** Planka card id, for the card-keyed gates. Log-only. */
  cardId?: string | null;
  /** The fr tenant that owns the board, as resolved. Log-only. */
  owningTenant?: string | null;
  /** The caller's ACTIVE tenant (post `X-Active-Tenant`). Log-only. */
  activeTenant?: string | null;
  /** Keycloak user uuid. An identifier, not a credential. Log-only. */
  userId?: string | null;
}

/**
 * Count the refusal AND emit one structured line naming the board, card and
 * user — the two halves described in the header, neither substituting for the
 * other.
 *
 * ⛔ NEVER THROWS, and never changes a verdict. Every call site is already
 * committed to a refusal; the `throw new NotFoundError(...)` follows this call
 * unconditionally. A throw from in here would replace a diagnosable 404 with an
 * undiagnosable 500 — i.e. the instrument would become the outage.
 *
 * ⛔ NO CREDENTIAL MATERIAL. `RequestContext` carries `bearerToken` — the
 * caller's live Keycloak JWT or fr licence token — and it is one property
 * access away below. The context is therefore read by EXPLICITLY NAMED FIELDS
 * only; there is no spread of `ctx`, and no spread of the caller's `user`
 * object either. Do not "simplify" either read into `...ctx`.
 */
export function reportBoardTenantGateRefusal(
  d: BoardTenantRefusalDetail,
): void {
  try {
    recordBoardTenantGateRefusal(d.gate, d.reason);
    const ctx = tryGetRequestContext();
    console.error(
      JSON.stringify({
        telemetry: 'board_tenant_gate_refused',
        gate: normaliseGate(d.gate),
        reason: normaliseReason(d.reason),
        board_id: d.boardId ?? null,
        card_id: d.cardId ?? null,
        owning_tenant: d.owningTenant ?? null,
        active_tenant: d.activeTenant ?? null,
        user_id: d.userId ?? null,
        // Explicitly named, never spread — see the ⛔ above.
        correlation_id: ctx?.correlationId ?? null,
        initiator: ctx?.initiator ?? null,
        channel: ctx?.channel ?? null,
      }),
    );
  } catch {
    // Deliberately silent: see above.
  }
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderBoardTenantGateRefusalMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_board_tenant_gate_refused_total Board/card reads and writes refused by the fr tenant gate, by gate and reason. reason="internal_board_write" is the population #1136 newly refuses.',
    '# TYPE fr_board_tenant_gate_refused_total counter',
  ];
  for (const g of BOARD_TENANT_GATES) {
    for (const r of BOARD_TENANT_REFUSAL_REASONS) {
      lines.push(
        `fr_board_tenant_gate_refused_total{gate="${g}",reason="${r}"} ${refusals.get(key(g, r)) ?? 0}`,
      );
    }
  }
  return lines;
}
