// src/routes/deliverable-minted.ts
//
// U-PS-COMMIT (fr half) — POST /api/projects/:id/deliverables/:did/minted {count}
//
// A DEFERRED deliverable's minter (ncn `scripts/lib/bug-hunt-mint.mjs`, incl. the
// zero-findings HUNT_ZERO branch; `bug-gate-fanout.mjs`) calls this after its
// LAST create, saying how many cards it minted. fr stamps `minted_at` +
// `minted_count` exactly once; `lib/deliverable-complete.ts` then treats the
// deliverable as complete when every attached card is DONE (count 0 ⇒ complete
// at once — a 0-finding hunt lets its phase exit).
//
// AUTH / TENANCY — the SAME front door as the minters' own create path and the
// decomposition commit (`resolveProjectForCaller`): validateAuth, 404 for an
// invisible project, and the EXEC pin (403 `project_cards_only_on_exec_tenant`)
// with the aa-orchestrator / super-admin cross-tenant service view. So only a
// platform caller — the EXEC tenant, or the orchestrator identity acting for a
// project's owner — can stamp; a customer tenant cannot.
//
// IDEMPOTENT, ONE STATEMENT, NO LOCK: the first stamp is a conditional UPDATE
// (`deferred AND minted_at IS NULL`); a loser of a race reads the row and gets
// the replay/conflict answer, never a second stamp.
//
//   201 {minted_at, minted_count, replayed:false}  first stamp
//   200 {..., replayed:true}                       same count again (no-op)
//   400 validation_failed                          body/ids malformed
//   404 project_not_found | deliverable_not_found
//   403 project_cards_only_on_exec_tenant          non-platform caller
//   409 project_archived                           the project is ARCHIVED (fr#1499); nothing stamped
//   409 minted_count_conflict                      already stamped with another count
//   422 deliverable_not_deferred                   a fixed deliverable is minted at commit

import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../db/client';
import { projectDeliverables } from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { isUuidShape } from '../lib/uuid-shape';
import { assertProjectNotArchived } from '../lib/project-live-status';
import { refusalResponse, resolveProjectForCaller } from './decomposition-commit';
import { jsonResponse } from '../utils/response';

/** Upper bound on one minter's report — far above any cap (D5 caps are per size class). */
export const MAX_MINTED_COUNT = 10_000;

export const DeliverableMintedBody = z
  .object({ count: z.number().int().min(0).max(MAX_MINTED_COUNT) })
  .strict();

/** The decision for an existing row whose conditional stamp matched nothing. Pure. */
export function mintedReplayDecision(
  row: { deferred: boolean; minted_at: Date | null; minted_count: number | null },
  count: number,
): 'not_deferred' | 'replay' | 'conflict' | 'race_unstamped' {
  if (!row.deferred) return 'not_deferred';
  if (row.minted_at === null || row.minted_count === null) return 'race_unstamped';
  return row.minted_count === count ? 'replay' : 'conflict';
}

export type MintedStampOutcome =
  | { kind: 'stamped' | 'replay'; minted_at: Date | null; minted_count: number | null }
  | { kind: 'not_found' | 'not_deferred' | 'race_unstamped' }
  | { kind: 'conflict'; minted_count: number | null };

/**
 * The stamp itself, IN-PROCESS (the route below and POST /api/approvals/:id/mint-design-units
 * both call it). The caller owns auth/tenancy and the project lookup; `projectId` must already
 * be a project the caller may stamp. Idempotent exactly as the header says.
 */
export async function stampDeliverableMinted(
  projectId: string,
  deliverableId: string,
  count: number,
): Promise<MintedStampOutcome> {
  const scope = and(
    eq(projectDeliverables.id, deliverableId),
    eq(projectDeliverables.project_id, projectId),
  );
  const [stamped] = await db
    .update(projectDeliverables)
    .set({ minted_at: new Date(), minted_count: count })
    .where(and(scope, eq(projectDeliverables.deferred, true), isNull(projectDeliverables.minted_at)))
    .returning({
      minted_at: projectDeliverables.minted_at,
      minted_count: projectDeliverables.minted_count,
    });
  if (stamped) return { kind: 'stamped', ...stamped };

  const [row] = await db
    .select({
      deferred: projectDeliverables.deferred,
      minted_at: projectDeliverables.minted_at,
      minted_count: projectDeliverables.minted_count,
    })
    .from(projectDeliverables)
    .where(scope);
  if (!row) return { kind: 'not_found' };
  const decision = mintedReplayDecision(row, count);
  if (decision === 'replay') return { kind: 'replay', minted_at: row.minted_at, minted_count: row.minted_count };
  if (decision === 'conflict') return { kind: 'conflict', minted_count: row.minted_count };
  return { kind: decision };
}

export async function handleDeliverableMinted(
  req: Request,
  projectId: string,
  deliverableId: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const activeTenantId = ctxTenantId(user.tenantId);

  const r = await resolveProjectForCaller(user, activeTenantId, projectId);
  if ('refusal' in r) return r.refusal;
  // fr#1499: a stamp on an ARCHIVED project is a write nobody can see — 409
  // `project_archived` before any write (AFTER the scoped lookup + pin, so a
  // foreign id is still the 404 and a non-platform caller still the 403).
  assertProjectNotArchived(r.project);

  let body: z.infer<typeof DeliverableMintedBody>;
  try {
    body = DeliverableMintedBody.parse(await req.json());
  } catch (e) {
    const issues = e instanceof z.ZodError ? e.issues : [{ message: String(e) }];
    return refusalResponse({ error: 'validation_failed', issues }, 400);
  }
  if (!isUuidShape(deliverableId)) {
    return refusalResponse(
      { error: 'deliverable_not_found', message: 'deliverable id is not a uuid', deliverable_id: deliverableId },
      404,
    );
  }

  const out = await stampDeliverableMinted(r.project.id, deliverableId, body.count);
  switch (out.kind) {
    case 'stamped':
      return jsonResponse(
        {
          project_id: r.project.id,
          deliverable_id: deliverableId,
          minted_at: out.minted_at,
          minted_count: out.minted_count,
          replayed: false,
        },
        201,
      );
    case 'not_found':
      return refusalResponse(
        {
          error: 'deliverable_not_found',
          message: 'no such deliverable on this project',
          deliverable_id: deliverableId,
        },
        404,
      );
    case 'not_deferred':
      return refusalResponse(
        {
          error: 'deliverable_not_deferred',
          message: 'this deliverable is minted at decomposition commit; only a deferred deliverable is reported minted',
          deliverable_id: deliverableId,
        },
        422,
      );
    case 'replay':
      return jsonResponse(
        {
          project_id: r.project.id,
          deliverable_id: deliverableId,
          minted_at: out.minted_at,
          minted_count: out.minted_count,
          replayed: true,
        },
        200,
      );
    case 'conflict':
      return refusalResponse(
        {
          error: 'minted_count_conflict',
          message: `already reported minted with count ${out.minted_count}; a different count (${body.count}) is refused`,
          deliverable_id: deliverableId,
          minted_count: out.minted_count,
          requested_count: body.count,
        },
        409,
      );
    case 'race_unstamped':
      // Deferred, unstamped, yet the conditional UPDATE matched nothing: only
      // possible if the row changed between the two statements. Retryable.
      return refusalResponse(
        { error: 'minted_retry', message: 'the deliverable changed concurrently; retry', deliverable_id: deliverableId },
        409,
      );
  }
}
