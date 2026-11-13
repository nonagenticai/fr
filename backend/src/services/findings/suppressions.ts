// src/services/findings/suppressions.ts
//
// The finding SUPPRESSION ledger (migration 130). A fingerprint a human/QA
// marked false-positive for a project. `POST /api/cards/project` consults
// `isFindingSuppressed` BEFORE its open-card dedupe and create lease, so a
// suppressed finding is never turned into a card again.
//
// ⛔ Keyed on (project_id, fingerprint) — NEVER on the caller's tenant. One
// project can be visible under two active tenants (its EXEC owner's home view
// and the aa-orchestrator acting for the customer tenant); a suppression
// recorded from either must suppress for both. WHO may read or write is
// decided by the routes (resolveCardRouteProject + cardRouteTenantRefusal)
// before any call here. `recorded_tenant_id` is audit only.
//
// ⛔ Permanent, not OPEN-scoped. Open-card dedupe (improvement-cards/dedup.ts)
// stops suppressing once the card reaches DONE; a row here does not.
//
// All statements are single autocommit statements on the module-level
// `queryClient` — pgbouncer-safe (no session state, no held connection).

import { queryClient } from '../../db/client';

export interface FindingSuppression {
  project_id: string;
  fingerprint: string;
  recorded_tenant_id: string;
  reason: string;
  card_id: string | null;
  decided_by: string;
  created_at: string;
  /** Migration 132. Caller-declared finding category, null when not given. */
  category: string | null;
}

export interface UpsertSuppressionInput {
  projectId: string;
  fingerprint: string;
  /** Active tenant of the recording caller — stored for audit, not a key. */
  recordedTenantId: string;
  reason: string;
  cardId?: string | null;
  decidedBy: string;
  /** Optional finding category (migration 132); recorded on the row and the event. */
  category?: string | null;
}

/**
 * Record a suppression. IDEMPOTENT: the first decision wins and is never
 * overwritten (ON CONFLICT DO NOTHING); a repeat — from ANY permitted caller,
 * under any tenant view of the project — returns the existing row with
 * `created: false`. Under N concurrent calls exactly one reports
 * `created: true`; the primary key is the arbiter.
 */
export async function upsertFindingSuppression(
  input: UpsertSuppressionInput,
): Promise<{ created: boolean; suppression: FindingSuppression }> {
  // ONE statement: the ledger INSERT and its 'suppress' event commit together
  // or not at all (a data-modifying CTE — pgbouncer-safe, no held
  // transaction). The event is written ONLY when this call created the row; a
  // repeat changes nothing, so it records nothing.
  const inserted = await queryClient<FindingSuppression[]>`
    WITH ins AS (
      INSERT INTO finding_suppressions
        (project_id, fingerprint, recorded_tenant_id, reason, card_id, decided_by,
         category)
      VALUES (
        ${input.projectId},
        ${input.fingerprint},
        ${input.recordedTenantId},
        ${input.reason},
        ${input.cardId ?? null},
        ${input.decidedBy},
        ${input.category ?? null}
      )
      ON CONFLICT (project_id, fingerprint) DO NOTHING
      RETURNING project_id, fingerprint, recorded_tenant_id, reason, card_id,
                decided_by, created_at, category
    ), ev AS (
      INSERT INTO finding_suppression_events
        (tenant_id, project_id, fingerprint, action, reason, category, actor)
      SELECT recorded_tenant_id, project_id, fingerprint, 'suppress', reason,
             category, decided_by
        FROM ins
    )
    SELECT * FROM ins
  `;
  if (inserted[0]) return { created: true, suppression: inserted[0] };

  const existing = await queryClient<FindingSuppression[]>`
    SELECT project_id, fingerprint, recorded_tenant_id, reason, card_id,
           decided_by, created_at, category
      FROM finding_suppressions
     WHERE project_id = ${input.projectId}
       AND fingerprint = ${input.fingerprint}
  `;
  if (!existing[0]) {
    // The conflict row vanished between the INSERT and the SELECT (deleted
    // concurrently). Loud rather than a fabricated answer.
    throw new Error(
      'finding_suppressions: conflicting row disappeared between insert and read',
    );
  }
  return { created: false, suppression: existing[0] };
}

/** Is this (project, fingerprint) suppressed? Caller tenant is NOT an input. */
export async function isFindingSuppressed(
  projectId: string,
  fingerprint: string,
): Promise<boolean> {
  const rows = await queryClient<{ hit: number }[]>`
    SELECT 1 AS hit
      FROM finding_suppressions
     WHERE project_id = ${projectId}
       AND fingerprint = ${fingerprint}
     LIMIT 1
  `;
  return rows.length === 1;
}

/** Every suppression for a project, newest first. */
export async function listFindingSuppressions(
  projectId: string,
): Promise<FindingSuppression[]> {
  return await queryClient<FindingSuppression[]>`
    SELECT project_id, fingerprint, recorded_tenant_id, reason, card_id,
           decided_by, created_at, category
      FROM finding_suppressions
     WHERE project_id = ${projectId}
     ORDER BY created_at DESC, fingerprint
  `;
}

export interface DeleteSuppressionInput {
  projectId: string;
  fingerprint: string;
  /** Active tenant of the deleting caller — stored on the event for audit. */
  actingTenantId: string;
  /** Why the suppression is withdrawn; required, recorded on the event. */
  reason: string;
  actor: string;
}

/**
 * Remove a suppression and record an 'unsuppress' event, in ONE statement
 * (data-modifying CTE): the row's removal and its event commit together.
 * Returns the removed row, or null when there was nothing to remove — the
 * route answers that with an explicit 404, so a second DELETE is never a
 * silent success, and no event is written for it.
 */
export async function deleteFindingSuppression(
  input: DeleteSuppressionInput,
): Promise<FindingSuppression | null> {
  const rows = await queryClient<FindingSuppression[]>`
    WITH del AS (
      DELETE FROM finding_suppressions
       WHERE project_id = ${input.projectId}
         AND fingerprint = ${input.fingerprint}
      RETURNING project_id, fingerprint, recorded_tenant_id, reason, card_id,
                decided_by, created_at, category
    ), ev AS (
      INSERT INTO finding_suppression_events
        (tenant_id, project_id, fingerprint, action, reason, category, actor)
      SELECT ${input.actingTenantId}::uuid, project_id, fingerprint, 'unsuppress',
             ${input.reason}::text, category, ${input.actor}::text
        FROM del
    )
    SELECT * FROM del
  `;
  return rows[0] ?? null;
}
