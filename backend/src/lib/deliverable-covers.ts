// src/lib/deliverable-covers.ts
//
// THE attachment of a card to one approved-scope deliverable
// (`project_deliverables` row): a `card_contracts` row whose `covers` names the
// row id. `lib/plan-phase-exit.ts` (the plan read model) reads exactly this
// link to show which cards belong to a deliverable (and so whether a deferred deliverable is
// complete — `lib/deliverable-complete.ts`).
//
// ONE shape, two writers:
//   * POST /api/decompositions/commit (`recordDecomposition`) — the family row
//     of each fixed deliverable, card bound later;
//   * POST /api/cards/project with `deliverable_id` — the deferred minters
//     (ncn bug-hunt-mint per_finding, bug-gate-fanout per_approved_bug).
// Both spread `deliverableCoversLink`, so the covers shape cannot drift.

import { createHash } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { cardContracts, projectDeliverables } from '../db/schema';
import { isUuidShape } from './uuid-shape';

/** card_contracts.criteria shape: [{id: 'crit_<sha1(text)[0:8]>', text}] (schema.ts). */
export function criteriaFromAcceptance(
  acceptance: unknown,
): Array<{ id: string; text: string }> {
  if (!Array.isArray(acceptance)) return [];
  return acceptance
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map((text) => ({
      id: `crit_${createHash('sha1').update(text).digest('hex').slice(0, 8)}`,
      text,
    }));
}

/** The covers link of a card (or family row) to ONE deliverable row. */
export function deliverableCoversLink(d: { id: string; acceptance_criteria: unknown }): {
  covers: string[];
  criteria: Array<{ id: string; text: string }>;
} {
  return { covers: [d.id], criteria: criteriaFromAcceptance(d.acceptance_criteria) };
}

/** pm Deliverable.id slug (= project_deliverables_plan_deliverable_id_check). Disjoint from a uuid (no '-'). */
export const PLAN_DELIVERABLE_SLUG = /^[a-z][a-z0-9_]*$/;

export function isDeliverableRef(v: string): boolean {
  return isUuidShape(v) || PLAN_DELIVERABLE_SLUG.test(v);
}

export interface MintDeliverableRow {
  id: string;
  plan_deliverable_id: string | null;
  deferred: boolean;
  minted_at: Date | null;
  minted_count: number | null;
  acceptance_criteria: unknown;
}

export type DeliverableAttachRefusal = {
  status: 404 | 409 | 422;
  body: { error: string; message: string; deliverable_id: string; [k: string]: unknown };
};

/** Cards already attached to a deliverable row (bound card_contracts whose covers names it). */
async function attachedCount(
  executor: Pick<typeof db, 'select'>,
  rowId: string,
): Promise<number> {
  const [r] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(cardContracts)
    .where(and(isNotNull(cardContracts.card_id), sql`${cardContracts.covers} @> ARRAY[${rowId}]::text[]`));
  return r?.n ?? 0;
}

/** A minted deliverable is CLOSED once its attached cards reached the reported count: a new card would exceed it. */
function closedRefusal(ref: string, row: MintDeliverableRow, attached: number): DeliverableAttachRefusal | null {
  if (row.minted_at === null || row.minted_count === null || attached < row.minted_count) return null;
  return {
    status: 409,
    body: {
      error: 'deliverable_mint_closed',
      message: `the minter already reported ${row.minted_count} card(s) for this deliverable and ${attached} are attached; another card would exceed the count`,
      deliverable_id: ref,
      minted_count: row.minted_count,
      attached,
    },
  };
}

/**
 * Resolve a minter's `deliverable_id` (plan slug or row uuid) ON THIS PROJECT
 * and refuse what it may not attach to. Read-only; before any card is created.
 * `closed` is the refusal for a NEW card (minted_count reported and reached);
 * the caller applies it only on its create path, so a retry that dedupes onto
 * an already-attached card still succeeds.
 */
export async function resolveMintDeliverable(
  projectId: string,
  ref: string,
): Promise<{ ok: true; row: MintDeliverableRow; closed: DeliverableAttachRefusal | null } | { ok: false; refusal: DeliverableAttachRefusal }> {
  const byRef = isUuidShape(ref)
    ? eq(projectDeliverables.id, ref)
    : eq(projectDeliverables.plan_deliverable_id, ref);
  const [row] = await db
    .select({
      id: projectDeliverables.id,
      plan_deliverable_id: projectDeliverables.plan_deliverable_id,
      deferred: projectDeliverables.deferred,
      minted_at: projectDeliverables.minted_at,
      minted_count: projectDeliverables.minted_count,
      acceptance_criteria: projectDeliverables.acceptance_criteria,
    })
    .from(projectDeliverables)
    .where(and(byRef, eq(projectDeliverables.project_id, projectId)));
  if (!row) {
    return {
      ok: false,
      refusal: {
        status: 404,
        body: { error: 'deliverable_not_found', message: 'no such deliverable on this project', deliverable_id: ref },
      },
    };
  }
  if (!row.deferred) {
    return {
      ok: false,
      refusal: {
        status: 422,
        body: {
          error: 'deliverable_not_deferred',
          message: 'this deliverable is minted at decomposition commit; only a deferred deliverable takes minter cards',
          deliverable_id: ref,
        },
      },
    };
  }
  return { ok: true, row, closed: closedRefusal(ref, row, await attachedCount(db, row.id)) };
}

export type AttachOutcome =
  | { ok: true; result: 'attached' | 'already' }
  | { ok: false; refusal: DeliverableAttachRefusal };

/**
 * Attach `cardId` to deliverable row `rowId` — ONE transaction holding the
 * row's lock, so two racing minters cannot both slip under `minted_count`.
 * Idempotent: a card already covering the row answers `already` (one link).
 * A card already contracted to something else is refused (card_id is UNIQUE).
 */
export async function attachCardToDeliverable(input: {
  tenantId: string;
  cardId: string;
  rowId: string;
  ref: string;
}): Promise<AttachOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: projectDeliverables.id,
        plan_deliverable_id: projectDeliverables.plan_deliverable_id,
        deferred: projectDeliverables.deferred,
        minted_at: projectDeliverables.minted_at,
        minted_count: projectDeliverables.minted_count,
        acceptance_criteria: projectDeliverables.acceptance_criteria,
      })
      .from(projectDeliverables)
      .where(eq(projectDeliverables.id, input.rowId))
      .for('update');
    if (!row || !row.deferred) {
      return {
        ok: false as const,
        refusal: {
          status: 409 as const,
          body: { error: 'deliverable_changed', message: 'the deliverable changed concurrently; retry', deliverable_id: input.ref },
        },
      };
    }
    const [existing] = await tx
      .select({ covers: cardContracts.covers })
      .from(cardContracts)
      .where(eq(cardContracts.card_id, input.cardId));
    if (existing) {
      if (existing.covers.includes(row.id)) return { ok: true as const, result: 'already' as const };
      return {
        ok: false as const,
        refusal: {
          status: 409 as const,
          body: {
            error: 'card_already_contracted',
            message: `card ${input.cardId} already carries a contract that does not cover this deliverable`,
            deliverable_id: input.ref,
            card_id: input.cardId,
          },
        },
      };
    }
    const closed = closedRefusal(input.ref, row, await attachedCount(tx, row.id));
    if (closed) return { ok: false as const, refusal: closed };
    await tx
      .insert(cardContracts)
      .values({ tenant_id: input.tenantId, card_id: input.cardId, ...deliverableCoversLink(row) })
      .onConflictDoNothing({ target: cardContracts.card_id });
    return { ok: true as const, result: 'attached' as const };
  });
}

/** Undo THIS request's link (the card it named was rolled back). */
export async function detachCardFromDeliverable(cardId: string, rowId: string): Promise<void> {
  await db
    .delete(cardContracts)
    .where(
      and(
        eq(cardContracts.card_id, cardId),
        sql`${cardContracts.family_id} IS NULL`,
        sql`${cardContracts.covers} = ARRAY[${rowId}]::text[]`,
      ),
    );
}
