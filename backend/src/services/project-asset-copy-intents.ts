// src/services/project-asset-copy-intents.ts
//
// fr-agui SPEC §13 P2 / OQ-16 — the claim + journal of ONE in-progress
// project-asset copy-on-write (`agui/actions/project-asset-edit.ts`), table
// `project_asset_copy_intents` (migration 196).
//
// WHY A CLAIM ROW AND NOT AN ADVISORY LOCK: the copy-on-write is a chain of UI
// route calls (upstream create, bind, override, unbind), each running through
// the GLOBAL db pool. An `_xact_` advisory lock would pin one pgbouncer server
// connection for the whole chain while every step needs a second one — with a
// pool of 2 (+1 reserve) per replica, three concurrent edits deadlock the
// replica (the measured hazard in services/workspace-admin-revoke-lock.ts, "WHY
// ONE CONNECTION PER REVOKE"). A primary-key claim needs no held connection:
// every statement here is a single autocommit statement.
//
// Protocol (keyed (project_id, asset_kind, original_id)):
//   claim     INSERT … ON CONFLICT DO UPDATE … WHERE the existing claim is free
//             (`claim_token IS NULL`: released by a thrown failure) or stale
//             (older than the lease: a crashed holder). Returns the row and a
//             fresh token, or null when a LIVE claim holds it (→ 409, retry).
//             Postgres serialises the two concurrent upserts on the row, so
//             exactly one of two simultaneous claimers gets it.
//   creating  stamp `copy_create_started_at` just before the upstream create;
//             `createSettled` clears it when the create definitely did not
//             happen (a 4xx refusal). Still set on a later claim = the create's
//             answer was lost (a POSSIBLE orphan upstream; the upstream create
//             takes no idempotency key, so fr can detect this, not close it).
//   record    journal the copy the moment it exists — guarded by the token, so
//             a holder whose lease was taken over cannot write.
//   release   clear the token on a thrown failure: the next attempt resumes at
//             once, with the journalled copy.
//   complete  delete the row when the copy-on-write is done (the override row
//             is then the record of it).

import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb, projectAssetCopyIntents } from '../db/client';

/** A claim older than this is a crashed holder's and may be taken over. */
export const COPY_INTENT_LEASE_SECONDS = 300;

export type CopyIntentRow = typeof projectAssetCopyIntents.$inferSelect;
export type CopyIntentKind = CopyIntentRow['asset_kind'];

export interface CopyIntentKey {
  projectId: string;
  kind: CopyIntentKind;
  originalId: string;
}

export interface CopyIntentClaim {
  token: string;
  intent: CopyIntentRow;
}

type IntentsDb = typeof defaultDb;

const keyWhere = (k: CopyIntentKey) =>
  and(
    eq(projectAssetCopyIntents.project_id, k.projectId),
    eq(projectAssetCopyIntents.asset_kind, k.kind),
    eq(projectAssetCopyIntents.original_id, k.originalId),
  );

/** Claim the copy-on-write of `k`. null = another edit holds a live claim. */
export async function claimCopyIntent(
  k: CopyIntentKey,
  init: { workspaceId: string; by: string },
  db: IntentsDb = defaultDb,
): Promise<CopyIntentClaim | null> {
  const token = crypto.randomUUID();
  const t = projectAssetCopyIntents;
  const rows = await db
    .insert(t)
    .values({
      project_id: k.projectId,
      asset_kind: k.kind,
      original_id: k.originalId,
      workspace_id: init.workspaceId,
      claim_token: token,
      claimed_by: init.by,
    })
    .onConflictDoUpdate({
      target: [t.project_id, t.asset_kind, t.original_id],
      set: { claim_token: token, claimed_by: init.by, claimed_at: sql`now()` },
      setWhere: sql`${t.claim_token} IS NULL OR ${t.claimed_at} < now() - make_interval(secs => ${COPY_INTENT_LEASE_SECONDS})`,
    })
    .returning();
  const intent = rows[0];
  return intent ? { token, intent } : null;
}

/** Stamp that the upstream create is about to run (token-guarded). */
export async function markCopyIntentCreating(k: CopyIntentKey, token: string, db: IntentsDb = defaultDb): Promise<void> {
  const rows = await db
    .update(projectAssetCopyIntents)
    .set({ copy_create_started_at: sql`now()` })
    .where(and(keyWhere(k), eq(projectAssetCopyIntents.claim_token, token)))
    .returning({ id: projectAssetCopyIntents.original_id });
  if (rows.length === 0) throw new Error(`project asset copy intent ${k.kind}:${k.originalId} lost its claim`);
}

/** The upstream create definitely did not happen: clear the stamp. */
export async function clearCopyIntentCreating(k: CopyIntentKey, token: string, db: IntentsDb = defaultDb): Promise<void> {
  await db
    .update(projectAssetCopyIntents)
    .set({ copy_create_started_at: null })
    .where(and(keyWhere(k), eq(projectAssetCopyIntents.claim_token, token)));
}

/** Journal the copy the claim created. Throws when the claim was taken over (lease lost). */
export async function recordCopyIntentCopy(
  k: CopyIntentKey,
  token: string,
  copy: { copyId: string; copyRef: string; changesKey: string },
  db: IntentsDb = defaultDb,
): Promise<void> {
  const rows = await db
    .update(projectAssetCopyIntents)
    .set({ copy_id: copy.copyId, copy_ref: copy.copyRef, copy_changes_key: copy.changesKey, copy_create_started_at: null })
    .where(and(keyWhere(k), eq(projectAssetCopyIntents.claim_token, token)))
    .returning({ id: projectAssetCopyIntents.original_id });
  if (rows.length === 0) throw new Error(`project asset copy intent ${k.kind}:${k.originalId} lost its claim`);
}

/** Release the claim (a thrown failure): the next attempt resumes at once. */
export async function releaseCopyIntent(k: CopyIntentKey, token: string, db: IntentsDb = defaultDb): Promise<void> {
  await db
    .update(projectAssetCopyIntents)
    .set({ claim_token: null })
    .where(and(keyWhere(k), eq(projectAssetCopyIntents.claim_token, token)));
}

/** The copy-on-write is complete: drop the claim row (only the holder can). */
export async function completeCopyIntent(k: CopyIntentKey, token: string, db: IntentsDb = defaultDb): Promise<void> {
  await db.delete(projectAssetCopyIntents).where(and(keyWhere(k), eq(projectAssetCopyIntents.claim_token, token)));
}
