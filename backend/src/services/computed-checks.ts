// src/services/computed-checks.ts
//
// The COMPUTED-PASS store (migration 162) and the break-glass DONE override audit.
//
//   card_computed_checks  append-only; one row per computed evaluator verdict. Written ONLY
//                         by POST /api/internal/cards/:cardId/computed-checks
//                         (routes/internal-computed-checks.ts) — per-caller X-Internal-Token,
//                         `written_by` derived from the token. Never by a human JWT.
//   card_done_overrides   append-only; the break-glass audit row (done_by='human_override').
//
// Both tables are guarded append-only by a DB trigger; this module never UPDATEs/DELETEs.
//
// ⭐ WHAT "HAS A COMPUTED PASS" MEANS (PER-KIND rule, 2026-10-06). For EACH kind ALLOWED
// FOR THE CARD'S TYPE (lib/computed-kind-table.ts — the one kind↔card-type table) take that
// kind's OWN most recent verdict; the card has a computed pass iff ANY of those per-kind latest
// verdicts is 'pass'. Within one kind a later 'fail' revokes an earlier 'pass': a regression
// found by a recheck must not be outvoted by a stale success. ACROSS kinds nothing shadows: one
// kind's later 'fail' does not revoke another kind's 'pass' — they are independent proofs. For a single-kind type this is
// exactly the old "latest allowed row is a pass" rule. A row of a kind NOT allowed for the type
// is invisible: it neither satisfies the guard nor shadows a right-kind verdict. No allowed
// row at all (or a type with an empty / absent row) = no pass (the DONE guard refuses).

import type { ISql } from 'postgres';

import { queryClient } from '../db/client';
import { allowedKindsForCardType } from '../lib/computed-kind-table';

export type ComputedVerdict = 'pass' | 'fail';

export interface ComputedCheckRow {
  id: string;
  card_id: string;
  check_kind: string;
  verdict: ComputedVerdict;
  evidence_sha: string;
  written_by: string;
  created_at: string;
}

/**
 * Append one verdict row. `sql` defaults to the pool; pass a TransactionSql to record the row in
 * the caller's transaction.
 */
export async function insertComputedCheck(
  row: {
    cardId: string;
    checkKind: string;
    verdict: ComputedVerdict;
    evidenceSha: string;
    writtenBy: string;
  },
  sql: ISql = queryClient,
): Promise<ComputedCheckRow> {
  const [inserted] = await sql<ComputedCheckRow[]>`
    INSERT INTO card_computed_checks (card_id, check_kind, verdict, evidence_sha, written_by)
    VALUES (${row.cardId}::text, ${row.checkKind}::text, ${row.verdict}::text,
            ${row.evidenceSha}::text, ${row.writtenBy}::text)
    RETURNING id::text, card_id, check_kind, verdict, evidence_sha, written_by,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;
  return inserted!;
}

/**
 * The card's most recent computed verdict row AMONG THE KINDS ALLOWED FOR `cardType`, or null.
 * Informational (latest-of-any-allowed-kind). ⚠️ It is NO LONGER the DONE guard's query: since
 * 2026-10-06 hasComputedPass goes through {@link latestComputedChecksPerKind} (the per-kind
 * rule, see the header). An external reader that must agree with the guard (the R10 grader's
 * b0v2 collector, read-only SQL) must reproduce THAT query — same kind filter (it vendors
 * lib/computed-kind-table.ts), same per-kind ordering, pass iff ANY kind's latest is 'pass'.
 *
 * An empty allowed set (or an unknown / null type) returns null without querying: fail closed.
 *
 * ⚠️ ORDER BY names the TABLE columns (`c.created_at`, `c.id`). The output aliases `id` and
 * `created_at` are TEXT (to_char / ::text), and a bare name in ORDER BY binds to the output
 * column first, so a bare `id DESC` would sort '9' above '10' on a created_at tie.
 */
export async function latestComputedCheck(
  cardId: string,
  cardType: string | null,
): Promise<ComputedCheckRow | null> {
  const kinds = allowedKindsForCardType(cardType);
  if (kinds.length === 0) return null;
  const rows = await queryClient<ComputedCheckRow[]>`
    SELECT c.id::text AS id, c.card_id, c.check_kind, c.verdict, c.evidence_sha, c.written_by,
           to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM card_computed_checks c
     WHERE c.card_id = ${cardId}::text
       AND c.check_kind IN ${queryClient([...kinds])}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * THE DONE GUARD'S QUERY: for each kind allowed for `cardType`, that kind's OWN most recent row
 * (at most one row per kind). An external reader that must agree with the guard reproduces
 * exactly this: `DISTINCT ON (check_kind)` over the allowed kinds, ordered per kind by
 * `created_at DESC, id DESC` on the TABLE columns (the same tie-break as latestComputedCheck —
 * the inner SELECT returns raw columns, so the ORDER BY can only bind to the table's own
 * timestamptz / bigint, never to a TEXT alias).
 *
 * An empty allowed set (or an unknown / null type) returns [] without querying: fail closed.
 */
export async function latestComputedChecksPerKind(
  cardId: string,
  cardType: string | null,
): Promise<ComputedCheckRow[]> {
  const kinds = allowedKindsForCardType(cardType);
  if (kinds.length === 0) return [];
  return await queryClient<ComputedCheckRow[]>`
    SELECT l.id::text AS id, l.card_id, l.check_kind, l.verdict, l.evidence_sha, l.written_by,
           to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM (
        SELECT DISTINCT ON (c.check_kind)
               c.id, c.card_id, c.check_kind, c.verdict, c.evidence_sha, c.written_by, c.created_at
          FROM card_computed_checks c
         WHERE c.card_id = ${cardId}::text
           AND c.check_kind IN ${queryClient([...kinds])}
         ORDER BY c.check_kind, c.created_at DESC, c.id DESC
      ) l
     ORDER BY l.check_kind`;
}

/**
 * True iff, among the kinds allowed for `cardType`, ANY kind's OWN most recent verdict is
 * 'pass' (per-kind rule — a later verdict of one kind never shadows another kind's pass).
 */
export async function hasComputedPass(cardId: string, cardType: string | null): Promise<boolean> {
  return (await latestComputedChecksPerKind(cardId, cardType)).some((r) => r.verdict === 'pass');
}

export async function insertDoneOverride(row: {
  cardId: string;
  boardId: string;
  cardType: string;
  actorId: string;
  reason: string;
}): Promise<{ id: string; created_at: string; done_by: 'human_override' }> {
  const [inserted] = await queryClient<{ id: string; created_at: string; done_by: 'human_override' }[]>`
    INSERT INTO card_done_overrides (card_id, board_id, card_type, actor_id, reason)
    VALUES (${row.cardId}::text, ${row.boardId}::text, ${row.cardType}::text,
            ${row.actorId}::text, ${row.reason}::text)
    RETURNING id::text, done_by,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;
  return inserted!;
}

/**
 * The subset of `cardIds` that reached DONE by break-glass (`done_kind: 'human_override'`).
 * Every fr DONE consumer subtracts this set: an override is recorded, never scored as DONE.
 */
export async function findHumanOverrideCardIds(cardIds: readonly string[]): Promise<Set<string>> {
  if (cardIds.length === 0) return new Set();
  const rows = await queryClient<{ card_id: string }[]>`
    SELECT DISTINCT card_id FROM card_done_overrides
     WHERE card_id IN ${queryClient([...cardIds])}`;
  return new Set(rows.map((r) => r.card_id));
}

export type DoneKind = 'computed' | 'human_override';

/** Break-glass DONE card ids recorded on one board (for count-only read models). */
export async function findHumanOverrideCardIdsOnBoard(boardId: string): Promise<string[]> {
  const rows = await queryClient<{ card_id: string }[]>`
    SELECT DISTINCT card_id FROM card_done_overrides WHERE board_id = ${boardId}::text`;
  return rows.map((r) => r.card_id);
}
