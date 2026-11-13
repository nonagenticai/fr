// src/routes/decomposition-split.ts
//
// ncn#1960 — the READYING split. POST /api/decompositions/split
//
// The n8n ready-prefetch split judge decides a card is too big for one DOING
// step; its child cards are created THROUGH fr (an fr record + the plan pin),
// never Planka-direct. Ruling: a card splits only at Readying (and QA/BLOCKED);
// DOING never splits.
//
// This is the per-card sibling of POST /api/decompositions/commit
// (routes/decomposition-commit.ts) and shares its front door, its transaction
// shape and its mint contract — imported from there, not copied:
//
//   AUTH / TENANCY   `validateAuth` + `ctxTenantId` + `resolveProjectForCaller`
//                    (404 for an invisible project, the EXEC pin 403). Like the
//                    commit route it deliberately skips `requireFamilyWriter`,
//                    so the n8n machine caller can drive it. The PARENT card
//                    must then be a card on that project's own board (Planka
//                    read through the SAME Planka client as the minter) — a card
//                    on any other board is the same 404 as a missing one, so a
//                    foreign card id leaks nothing. This check runs BEFORE any
//                    lookup keyed on the parent id (its stored depth), so no
//                    parent-specific answer is given for a card off the board.
//                    It must also sit on TODO or READY (409
//                    parent_not_splittable_in_list otherwise — DOING never
//                    splits through here), and the board must have the TODO
//                    list the minter will resolve (409 target_list_not_found,
//                    before anything is recorded). Both are decided by the
//                    minter's own `resolveProjectTargetList`. Its split depth is
//                    read from its own card_contracts row when it has one; a
//                    caller-sent parent_split_depth that disagrees is a 422.
//   RECORD           ONE short tx under the commit route's project advisory
//                    lock: one-family-per-parent check, insert the family
//                    (computed_by + reason), one card_contracts row per child
//                    (child_key `split:<decomposition_id>:<i>`, depth =
//                    parent_split_depth + 1, criteria from the child's
//                    acceptance_criteria, scope_hash = the child's identity),
//                    then the replay-identity check.
//   MINT             `createProjectCardFor` per child into TODO, asset_id =
//                    the child_key. `split:` dedupes across DONE (dedup.ts
//                    SPLIT_ASSET_PREFIX), so a replay after a child finished
//                    still answers with that child, never a fresh card.
//
// ⛔ NO TRANSACTION OR ADVISORY XACT LOCK IS HELD ACROSS A PLANKA CALL (fr#1314).
// The parent-card read happens BEFORE the tx; every mint happens AFTER commit.

import { createHash } from 'node:crypto';

import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';

import { db } from '../db/client';
import { cardContracts, decompositions } from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { jsonResponse } from '../utils/response';
import { PlankaError } from '../services/planka/errors';
import { SPLIT_ASSET_PREFIX } from '../services/improvement-cards/dedup';
import { projectCatalogueTenant } from '../services/catalogue/tenant-catalogue';
import {
  FINDING_FINGERPRINT_PATTERN,
  cardTypeCatalogueRefusal,
  createProjectCardFor,
  projectCardPlankaAgent,
  resolveProjectTargetList,
} from './cards/project';
import {
  CommitConflict,
  bindContractCard,
  classifyMintResponse,
  criteriaFromAcceptance,
  projectDecompositionLockKey,
  refusalResponse,
  resolveProjectForCaller,
  scenarioSkeleton,
} from './decomposition-commit';

/**
 * The deepest split generation. A card at `parent_split_depth` may be split
 * only when its children (depth + 1) stay within this. The SAME number as
 * ncn `ready-prefetch :: Build Split Prompt` MAX_SPLIT_DEPTH.
 */
export const MAX_SPLIT_DEPTH = 2;
export const MIN_SPLIT_CHILDREN = 2;
export const MAX_SPLIT_CHILDREN = 5;

/** The card asset id AND the contract child_key of split child `index`. */
export function splitChildKey(decompositionId: string, index: number): string {
  return `${SPLIT_ASSET_PREFIX}${decompositionId}:${index}`;
}

const SplitChild = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(8000),
    acceptance_criteria: z.array(z.string().min(1)).min(1).max(20),
    // Checked against the PROJECT tenant's RM card types AFTER parsing so a
    // wrong type is a 422 card_type_not_in_catalogue with the tenant's list,
    // not a bare zod 400 (same as the commit route).
    card_type: z.string().min(1).max(200),
  })
  .strict();

export const SplitDecompositionBody = z
  .object({
    decomposition_id: z.string().uuid(),
    project_id: z.string().uuid(),
    parent_card_id: z
      .string()
      .regex(new RegExp(FINDING_FINGERPRINT_PATTERN), 'parent_card_id must be 1..200 printable ASCII'),
    parent_split_depth: z.number().int().min(0),
    children: z.array(SplitChild).min(MIN_SPLIT_CHILDREN).max(MAX_SPLIT_CHILDREN),
    computed_by: z.enum(['rule', 'invest_t']),
    reason: z.string().max(200),
  })
  .strict();
type SplitBody = z.infer<typeof SplitDecompositionBody>;
type SplitChildBody = z.infer<typeof SplitChild>;

/**
 * A child's identity — what a replay must match. Stored in
 * card_contracts.scope_hash. Includes the depth, so the same children under a
 * different parent_split_depth are a different family.
 */
export function splitChildHash(child: SplitChildBody, depth: number): string {
  return createHash('sha256')
    .update(
      JSON.stringify([child.title, child.description, child.acceptance_criteria, child.card_type, depth]),
    )
    .digest('hex');
}

const FENCE = '```';

/**
 * The child card's description: the caller's text, then (a) the ```json
 * card-inputs fence the hydrator reads, then (b) the decomposition provenance
 * block — BYTE-FOR-BYTE the shape ncn `subroutine-doing-split :: Emit Children`
 * writes (`\n\n<!-- aa:decomposition:start -->\n```decomposition\n<compact
 * JSON>\n```\n<!-- aa:decomposition:end -->`), which `ready-prefetch :: Build
 * Split Prompt` reads for its depth cap (`split_depth` from the fence first).
 */
export function buildSplitChildDescription(input: {
  description: string;
  projectId: string;
  parentCardId: string;
  splitDepth: number;
  acceptanceCriteria: string[];
}): string {
  const inputs =
    FENCE +
    'json\n' +
    JSON.stringify(
      {
        project_id: input.projectId,
        split_depth: input.splitDepth,
        acceptance_criteria: input.acceptanceCriteria,
        // G-25: the same deterministic scn_/crit_ skeleton the commit path
        // mints (mintedCardDescription) — derived from the AC text only, so it
        // is NOT part of splitChildHash and a replay is byte-identical.
        gherkin_scenarios: scenarioSkeleton(criteriaFromAcceptance(input.acceptanceCriteria)),
      },
      null,
      2,
    ) +
    '\n' +
    FENCE;
  const provenance =
    '\n\n<!-- aa:decomposition:start -->\n' +
    FENCE +
    'decomposition\n' +
    JSON.stringify({ parent_card: input.parentCardId, split_depth: input.splitDepth }) +
    '\n' +
    FENCE +
    '\n<!-- aa:decomposition:end -->';
  return (input.description.length > 0 ? `${input.description}\n\n` : '') + inputs + provenance;
}

interface SplitPlan {
  childKey: string;
  child: SplitChildBody;
  hash: string;
}

/** The ONE transaction. Contains no Planka/HTTP call. */
async function recordSplit(input: {
  decompositionId: string;
  tenantId: string;
  projectId: string;
  parentCardId: string;
  depth: number;
  computedBy: SplitBody['computed_by'];
  reason: string;
  plan: SplitPlan[];
}): Promise<Map<string, string | null>> {
  return await db.transaction(async (tx) => {
    // The commit route's project key: a commit and a split on the same project
    // serialise, and so do two splits racing on one parent card (the parent
    // was verified to be on this project's board, so it is the same project).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${projectDecompositionLockKey(input.projectId)}))`,
    );

    // ONE family per parent card. Any family — a split or a C1-58 commit —
    // already rooted at this card means it has been decomposed; a second,
    // different decomposition_id is refused with the existing one named so the
    // caller can replay it instead.
    const [existing] = await tx
      .select({ id: decompositions.id })
      .from(decompositions)
      .where(
        and(
          eq(decompositions.parent_card_id, input.parentCardId),
          ne(decompositions.id, input.decompositionId),
        ),
      )
      .limit(1);
    if (existing) {
      throw new CommitConflict({
        error: 'parent_already_split',
        message: 'parent card already has a decomposition; nothing was recorded or minted. Re-send with that decomposition_id to replay it.',
        decomposition_id: existing.id,
        parent_card_id: input.parentCardId,
      });
    }

    await tx
      .insert(decompositions)
      .values({
        id: input.decompositionId,
        tenant_id: input.tenantId,
        parent_card_id: input.parentCardId,
        computed_by: input.computedBy,
        reason: input.reason,
      })
      .onConflictDoNothing();
    const [family] = await tx
      .select()
      .from(decompositions)
      .where(eq(decompositions.id, input.decompositionId));
    if (
      !family ||
      family.tenant_id !== input.tenantId ||
      family.parent_card_id !== input.parentCardId ||
      family.computed_by === null
    ) {
      throw new CommitConflict({
        error: 'decomposition_id_conflict',
        message: 'decomposition_id is already recorded for a different tenant, parent card or kind of decomposition',
        decomposition_id: input.decompositionId,
      });
    }

    // A replay (or a racing first call — serialised by the lock above) with the
    // same id must describe the SAME children: same keys, same per-child
    // identity hash, same depth. Compared BEFORE inserting: child keys are
    // positional (`split:<id>:<i>`), so an insert-then-compare would let a
    // longer child list add its extra index and then read back as "the same".
    const readRecorded = () =>
      tx
        .select({
          child_key: cardContracts.child_key,
          card_id: cardContracts.card_id,
          scope_hash: cardContracts.scope_hash,
          depth: cardContracts.depth,
        })
        .from(cardContracts)
        .where(eq(cardContracts.family_id, input.decompositionId));
    let recorded = await readRecorded();
    if (recorded.length === 0) {
      await tx
        .insert(cardContracts)
        .values(
          input.plan.map((p) => ({
            tenant_id: input.tenantId,
            family_id: input.decompositionId,
            child_key: p.childKey,
            depth: input.depth,
            scope_hash: p.hash,
            criteria: criteriaFromAcceptance(p.child.acceptance_criteria),
          })),
        )
        .onConflictDoNothing({ target: [cardContracts.family_id, cardContracts.child_key] });
      recorded = await readRecorded();
    }
    const recordedByKey = new Map(recorded.map((r) => [r.child_key as string, r]));
    const same =
      recorded.length === input.plan.length &&
      input.plan.every((p) => {
        const r = recordedByKey.get(p.childKey);
        return r !== undefined && r.scope_hash === p.hash && r.depth === input.depth;
      });
    if (!same) {
      throw new CommitConflict({
        error: 'decomposition_id_conflict',
        message: `decomposition_id is already recorded with a different set of ${recorded.length} children`,
        decomposition_id: input.decompositionId,
      });
    }
    return new Map(recorded.map((r) => [r.child_key as string, r.card_id]));
  });
}

type ParentCheck = { ok: true } | { ok: false; response: Response };

/**
 * The lists a card may be split FROM through this route — the Readying lists.
 * ⛔ DOING NEVER SPLITS (RULINGS 09-30 item 2). QA/BLOCKED splits go through
 * their own paths, not this route. Resolved by `resolveProjectTargetList` — the
 * SAME function `createProjectCardFor` resolves its `target_list` with (exact
 * name) — never by list id, which differs per board, and never by a looser
 * match the minter would not honour.
 */
export const SPLITTABLE_PARENT_LISTS: readonly string[] = ['TODO', 'READY'];

/** The list every split child is minted into (`createProjectCardFor` target_list). */
export const SPLIT_CHILD_TARGET_LIST = 'TODO';

function planka502(error: string, err: PlankaError, parentCardId: string): ParentCheck {
  return {
    ok: false,
    response: refusalResponse({ error, message: err.message, parent_card_id: parentCardId }, 502),
  };
}

/**
 * The parent card must be a card on THIS project's board — else 404 — and it
 * must sit on a Readying list (TODO/READY) — else 409
 * parent_not_splittable_in_list. A list we cannot name is refused too: the
 * licence is a POSITIVE match, never "not DOING". Finally the board must have
 * the list the minter will resolve as TODO — else 409 target_list_not_found —
 * so a family is never recorded for children that cannot be minted.
 */
async function verifyParentOnBoard(boardId: string | null, parentCardId: string): Promise<ParentCheck> {
  const notFound: ParentCheck = {
    ok: false,
    response: refusalResponse(
      { error: 'parent_card_not_found', message: 'parent card not found on this project\'s board' },
      404,
    ),
  };
  if (!boardId) return notFound;
  const agent = projectCardPlankaAgent();
  let card: { boardId?: string | null; listId?: string | null } | undefined;
  try {
    card = (await agent.cards.get(parentCardId)).item as typeof card;
  } catch (err) {
    if (err instanceof PlankaError && (err.status === 404 || err.status === 403)) return notFound;
    if (err instanceof PlankaError) return planka502('planka_parent_card_fetch_failed', err, parentCardId);
    throw err;
  }
  if (String(card?.boardId ?? '') !== String(boardId)) return notFound;

  let lists: Awaited<ReturnType<typeof agent.lists.listByBoard>>;
  try {
    lists = await agent.lists.listByBoard(boardId);
  } catch (err) {
    if (err instanceof PlankaError) return planka502('planka_list_fetch_failed', err, parentCardId);
    throw err;
  }
  const parentListId = String(card?.listId ?? '');
  const listName = lists.find((l) => String(l.id) === parentListId)?.name ?? null;
  const splittable = SPLITTABLE_PARENT_LISTS.some(
    (name) => String(resolveProjectTargetList(lists, name)?.id ?? '') === parentListId,
  );
  if (listName === null || !splittable) {
    return {
      ok: false,
      response: refusalResponse(
        {
          error: 'parent_not_splittable_in_list',
          message: `a card splits only from ${[...SPLITTABLE_PARENT_LISTS].join('/')}; the parent is in ${
            listName ?? 'an unknown list'
          } (DOING never splits; QA/BLOCKED splits take other paths)`,
          list: listName,
          parent_card_id: parentCardId,
        },
        409,
      ),
    };
  }
  if (!resolveProjectTargetList(lists, SPLIT_CHILD_TARGET_LIST)) {
    return {
      ok: false,
      response: refusalResponse(
        {
          error: 'target_list_not_found',
          message: `the project's board has no list named exactly ${SPLIT_CHILD_TARGET_LIST}; split children cannot be minted`,
          list: SPLIT_CHILD_TARGET_LIST,
          parent_card_id: parentCardId,
        },
        409,
      ),
    };
  }
  return { ok: true };
}

/**
 * The parent's AUTHORITATIVE split depth. A parent that is itself a
 * decomposition child has a card_contracts row (bound to its card id) whose
 * `depth` was written by fr when it was minted; that wins over the caller.
 * A root card (no row) takes the caller's value.
 */
async function storedParentDepth(tenantId: string, parentCardId: string): Promise<number | null> {
  const [row] = await db
    .select({ depth: cardContracts.depth })
    .from(cardContracts)
    .where(and(eq(cardContracts.card_id, parentCardId), eq(cardContracts.tenant_id, tenantId)))
    .limit(1);
  return row ? row.depth : null;
}

/**
 * 201 {decomposition_id, child_card_ids, replayed:false} — at least one child
 *     card was created this call.
 * 200 {…, replayed:true} — every child already existed; same card ids.
 * 400 validation_failed. 403 project_cards_only_on_exec_tenant.
 * 404 project_not_found | parent_card_not_found.
 * 422 split_depth_exceeded | parent_split_depth_mismatch {stored, sent} |
 *     card_type_not_allowed (nothing recorded) | mint_refused (recorded; not
 *     retryable as-is).
 * 409 parent_not_splittable_in_list {list} (parent not in TODO/READY) |
 *     target_list_not_found (board has no exact TODO list; nothing recorded) |
 *     parent_already_split {decomposition_id: the existing one} |
 *     decomposition_id_conflict (nothing recorded) | mint_incomplete (retry).
 * 502 planka_parent_card_fetch_failed | planka_list_fetch_failed (nothing
 *     recorded) | mint_failed
 *     (recorded; retry the same call, it converges).
 * Every refusal carries `code` === `error`.
 */
export async function handleSplitDecomposition(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  let body: SplitBody;
  try {
    body = SplitDecompositionBody.parse(await req.json());
  } catch (e) {
    const issues = e instanceof z.ZodError ? e.issues : [{ message: String(e) }];
    return refusalResponse({ error: 'validation_failed', issues }, 400);
  }

  const r = await resolveProjectForCaller(user, activeTenantId, body.project_id);
  if ('refusal' in r) return r.refusal;
  const project = r.project;

  // ⛔ THE PARENT IS VERIFIED ON THIS BOARD FIRST — before any lookup keyed on
  // its id — so a card id from another project (even one with a stored depth)
  // gets the same 404 as one that does not exist, never a 422 echoing its depth.
  const parent = await verifyParentOnBoard(project.planka_board_id, body.parent_card_id);
  if (!parent.ok) return parent.response;

  // ⛔ DEPTH IS NOT TRUSTED FROM THE CALLER when fr recorded it: a parent that
  // is itself a split child carries its depth in card_contracts, and a caller
  // disagreeing with it is refused rather than silently corrected.
  const stored = await storedParentDepth(activeTenantId, body.parent_card_id);
  if (stored !== null && stored !== body.parent_split_depth) {
    return refusalResponse(
      {
        error: 'parent_split_depth_mismatch',
        message: `parent_split_depth ${body.parent_split_depth} disagrees with the parent's recorded split depth ${stored}`,
        stored,
        sent: body.parent_split_depth,
      },
      422,
    );
  }
  const parentDepth = stored ?? body.parent_split_depth;
  const depth = parentDepth + 1;
  if (depth > MAX_SPLIT_DEPTH) {
    return refusalResponse(
      {
        error: 'split_depth_exceeded',
        message: `children would be at split depth ${depth}; the maximum is ${MAX_SPLIT_DEPTH}`,
        parent_split_depth: parentDepth,
        max_split_depth: MAX_SPLIT_DEPTH,
      },
      422,
    );
  }

  const typeRefusal = await cardTypeCatalogueRefusal(
    projectCatalogueTenant(project),
    body.children.map((c) => c.card_type),
  );
  if (typeRefusal) return refusalResponse(typeRefusal.body, typeRefusal.status);

  const plan: SplitPlan[] = body.children.map((child, i) => ({
    childKey: splitChildKey(body.decomposition_id, i),
    child,
    hash: splitChildHash(child, depth),
  }));

  let bound: Map<string, string | null>;
  try {
    bound = await recordSplit({
      decompositionId: body.decomposition_id,
      tenantId: activeTenantId,
      projectId: project.id,
      parentCardId: body.parent_card_id,
      depth,
      computedBy: body.computed_by,
      reason: body.reason,
      plan,
    });
  } catch (err) {
    if (err instanceof CommitConflict) return refusalResponse(err.body, 409);
    throw err;
  }

  // ── mint (no tx, no lock held) ──
  const minted: Array<{ child_key: string; card_type: string; card_id: string; created: boolean }> = [];
  for (const p of plan) {
    const res = await createProjectCardFor(user, activeTenantId, {
      project_id: project.id,
      card_type: p.child.card_type,
      card_name: p.child.title,
      description: buildSplitChildDescription({
        description: p.child.description,
        projectId: project.id,
        parentCardId: body.parent_card_id,
        splitDepth: depth,
        acceptanceCriteria: p.child.acceptance_criteria,
      }),
      parent_card_id: body.parent_card_id,
      target_list: SPLIT_CHILD_TARGET_LIST,
      asset_id: p.childKey,
    });
    const outcome = await classifyMintResponse(res, {
      decompositionId: body.decomposition_id,
      childKey: p.childKey,
      cards: minted,
    });
    if (!outcome.ok) return outcome.response;
    if (bound.get(p.childKey) !== outcome.cardId) {
      await bindContractCard(body.decomposition_id, p.childKey, outcome.cardId);
    }
    minted.push({
      child_key: p.childKey,
      card_type: p.child.card_type,
      card_id: outcome.cardId,
      created: outcome.created,
    });
  }

  const createdCount = minted.filter((m) => m.created).length;
  return jsonResponse(
    {
      decomposition_id: body.decomposition_id,
      child_card_ids: minted.map((m) => m.card_id),
      replayed: createdCount === 0,
    },
    createdCount > 0 ? 201 : 200,
  );
}
