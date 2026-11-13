// src/services/decomposition/family-decisions.ts
//
// The fr half of a split family's decision log (split-coherence-design.md §3.2,
// §4.2; migration 128). The decision CONTENT is authored in requirements_management
// (`decisions.createDecision`, stable_key `fam:<family_id>:<topic_slug>`); fr holds
// only the ordering + uniqueness index: which child claimed which topic, at which
// `seq`.
//
// ⭐ claimDecisionTopic IS AN ATOMIC CLAIM, not a check-then-insert. A SELECT
// "is this topic taken?" followed by an INSERT lets two concurrent children both
// read "free" and both write — the one-open-gate defect (fr#1000) in a new place.
// The claim is one statement:
//
//   INSERT … ON CONFLICT (family_id, topic_slug) WHERE superseded_by IS NULL
//   DO NOTHING RETURNING seq
//
// and the partial unique index `family_decisions_one_active_topic_idx` (declared
// in BOTH migration 128 and src/db/schema.ts) IS the atomicity — the same idiom
// as router_dedupe (migration 082). Exactly one concurrent caller gets a row
// back; every other caller gets the winner's decision_id and must conform or
// supersede (design §3.2).
//
// If that index is ever dropped, Postgres refuses the ON CONFLICT target with
// 42P10 ("no unique or exclusion constraint matching the ON CONFLICT
// specification"): every claim THROWS rather than silently double-writing, and
// tests/integration/decomposition/family-decisions-claim.integration.test.ts
// goes red.
//
// ⛔ SUPERSEDE IS NOT IMPLEMENTED HERE, deliberately. The design allows a loser
// to supersede "only if its own card owns the provider, which is checked against
// the contract" — but WHICH provider a decision governs is its `affects[]`, and
// that lives in the decision's lens_metadata in requirements_management, not in
// fr. A supersede path without that ownership check would let any sibling
// overwrite any sibling's decision. It needs the `affects` fact in fr (or a read
// of it) first; until then the route refuses a `supersedes` field (400) rather
// than ignoring it.

import { and, asc, eq, gt } from 'drizzle-orm';

import { db, queryClient } from '../../db/client';
import { decompositions, familyDecisions } from '../../db/schema';
import { isUuidShape } from '../../lib/uuid-shape';

/** design §3.4 I7: `new_topic_slug: ^[a-z0-9_]{3,40}$`. Same regex as the table CHECK. */
export const TOPIC_SLUG_RE = /^[a-z0-9_]{3,40}$/;

export interface ClaimDecisionTopicInput {
  familyId: string;
  topicSlug: string;
  decisionId: string;
  childKey: string;
}

export type ClaimDecisionTopicResult =
  /** This call inserted the active decision for the topic. */
  | { outcome: 'claimed'; seq: number; decision_id: string; child_key: string }
  /**
   * The active decision for the topic is ALREADY this caller's (same
   * decision_id and child_key) — a retry after a lost response. Reported as a
   * success so a retrying child does not read its own claim as a rival's.
   */
  | { outcome: 'replayed'; seq: number; decision_id: string; child_key: string }
  /** Another claim holds the topic. The caller must read that decision and conform or supersede. */
  | { outcome: 'conflict'; seq: number; decision_id: string; child_key: string };

/**
 * How many times to retry when the active row vanished between our INSERT and
 * our read of the winner (it was superseded in that window, so the topic may be
 * free again). Bounded so a pathological supersede storm cannot spin forever.
 */
const MAX_CLAIM_ATTEMPTS = 3;

export async function claimDecisionTopic(
  input: ClaimDecisionTopicInput,
): Promise<ClaimDecisionTopicResult> {
  const { familyId, topicSlug, decisionId, childKey } = input;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const inserted = await queryClient<{ seq: string }[]>`
      INSERT INTO family_decisions (family_id, topic_slug, decision_id, child_key)
      VALUES (${familyId}, ${topicSlug}, ${decisionId}, ${childKey})
      ON CONFLICT (family_id, topic_slug) WHERE superseded_by IS NULL DO NOTHING
      RETURNING seq
    `;
    if (inserted.length === 1) {
      return {
        outcome: 'claimed',
        seq: Number(inserted[0]!.seq),
        decision_id: decisionId,
        child_key: childKey,
      };
    }

    // Lost the claim. ON CONFLICT DO NOTHING waits for a conflicting in-flight
    // insert to commit before it reports the conflict, so under READ COMMITTED
    // this fresh statement sees the winner.
    const winner = await queryClient<{ seq: string; decision_id: string; child_key: string }[]>`
      SELECT seq, decision_id, child_key
      FROM family_decisions
      WHERE family_id = ${familyId}
        AND topic_slug = ${topicSlug}
        AND superseded_by IS NULL
    `;
    const w = winner[0];
    if (w) {
      const same = w.decision_id === decisionId && w.child_key === childKey;
      return {
        outcome: same ? 'replayed' : 'conflict',
        seq: Number(w.seq),
        decision_id: w.decision_id,
        child_key: w.child_key,
      };
    }
    // The winner was superseded between the two statements — retry the claim.
  }

  throw new Error(
    `claimDecisionTopic: topic ${topicSlug} in family ${familyId} changed hands ` +
      `${MAX_CLAIM_ATTEMPTS} times during one claim; refusing to guess a winner`,
  );
}

export interface FamilyDecisionRow {
  seq: number;
  topic_slug: string;
  decision_id: string;
  child_key: string;
  supersedes: string | null;
  superseded_by: string | null;
  created_at: Date;
}

/**
 * The family decision log strictly after `afterSeq`, oldest first. Includes
 * superseded rows (append-only log): a reader computing staleness needs to see
 * that a decision it read was later superseded.
 */
export async function listFamilyDecisions(
  familyId: string,
  afterSeq = 0,
): Promise<FamilyDecisionRow[]> {
  return db
    .select({
      seq: familyDecisions.seq,
      topic_slug: familyDecisions.topic_slug,
      decision_id: familyDecisions.decision_id,
      child_key: familyDecisions.child_key,
      supersedes: familyDecisions.supersedes,
      superseded_by: familyDecisions.superseded_by,
      created_at: familyDecisions.created_at,
    })
    .from(familyDecisions)
    .where(and(eq(familyDecisions.family_id, familyId), gt(familyDecisions.seq, afterSeq)))
    .orderBy(asc(familyDecisions.seq));
}

/**
 * The family row IF it exists AND belongs to `tenantId`; otherwise null. The two
 * cases are deliberately indistinguishable to the caller (don't-leak-existence:
 * a family in another tenant reads as absent). A non-uuid id or tenant cannot
 * name a row and returns null instead of raising 22P02.
 */
export async function findFamilyForTenant(
  familyId: string,
  tenantId: string,
): Promise<{ id: string; tenant_id: string; parent_card_id: string } | null> {
  if (!isUuidShape(familyId) || !isUuidShape(tenantId)) return null;
  const rows = await db
    .select({
      id: decompositions.id,
      tenant_id: decompositions.tenant_id,
      parent_card_id: decompositions.parent_card_id,
    })
    .from(decompositions)
    .where(and(eq(decompositions.id, familyId), eq(decompositions.tenant_id, tenantId)))
    .limit(1);
  return rows[0] ?? null;
}
