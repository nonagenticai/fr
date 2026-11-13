// domain/bridge/caller-scope.ts
//
// ONE owner for "whose data may a bridge listing return".
//
// THE DEFECT THIS CLOSES. `bridge.list_outputs` takes a free-form `filters` bag
// and hands it to a producer. `codingOutputSource.listOutputs`
// (domain/bridge/sources/coding.ts) reads `params.user_id` from that bag and
// passes it to `getJob(job_id, user_id)` and `getFindings({ userId, jobId })`.
// Those are SCOPING FILTERS, not authorization checks — `getJob` is
// `and(eq(id, jobId), eq(user_id, userId))` (integrations/coding/adapter.ts),
// which returns the row when the ids match and null otherwise. So a caller who
// supplied someone else's `user_id` read that person's findings, and a caller
// who supplied a wrong one merely got a 404. Neither surface ever asked whether
// the caller was ENTITLED to that user_id, because a filter cannot ask that.
//
// Both entry points authenticate correctly and then failed to APPLY the result:
//   * AG-UI  `agui/actions/bridge.ts` passed `input.filters` through untouched,
//     even though every sibling action already reads from `ctxToBridge(ctx)`.
//   * REST   `routes/tools/bridge.ts` copied every query param and overrode only
//     `project_id`, leaving `user_id` caller-controlled.
//
// The REST comment already named the AG-UI half as the unfixed one. Rather than
// fix it twice — the "two implementations of one concern" shape that has caused
// several defects in this codebase — both now call this.
//
// ⚠️ Caller-supplied values are OVERWRITTEN, not merged and not validated.
// There is no legitimate on-behalf-of caller here: `BridgeCtx.user_id` comes
// from `validateAuth(req).id` (REST) or the agent session's `ctx.userId`
// (AG-UI), and an agent asking for another user's outputs is the thing being
// prevented. If a genuine delegation case ever appears it needs an explicit
// authorization check, not a filter — do not "fix" it by trusting the bag again.

import { and, eq } from 'drizzle-orm';

import { projects } from '../../db/schema';
import { IntegrationError } from '../../integrations/_lib/errors';
import { projectTaggedForTenant } from '../../lib/project-access';
import { isUuidShape } from '../../lib/uuid-shape';
import type { BridgeCtx, BridgeDb } from './types';

/** Identity-bearing filter keys. Never honoured from the caller. */
const CALLER_SCOPED_KEYS = ['user_id', 'project_id'] as const;

/**
 * The filters a producer may actually see: whatever the caller asked for, with
 * every identity-bearing key replaced by the authenticated context.
 *
 * Non-identity filters (`job_id`, `session_id`, …) pass through untouched —
 * they select WHICH item within a scope, not WHOSE.
 */
export function scopedFilters(
  requested: Record<string, string> | undefined,
  ctx: Pick<BridgeCtx, 'user_id' | 'project_id'>,
): Record<string, string> {
  return {
    ...(requested ?? {}),
    user_id: ctx.user_id,
    project_id: ctx.project_id,
  };
}

/** The keys `scopedFilters` refuses to take from the caller. Exported for tests. */
export const callerScopedKeys: readonly string[] = CALLER_SCOPED_KEYS;

/**
 * H5: the project a bridge call names must belong to the CALLER'S tenant.
 *
 * `project_id` is caller-supplied (query string, JSON body, or the agent
 * session), and drafts create/get/patch/reject filter on `project_id` alone —
 * so a shape check let a user of tenant B read and write tenant A's drafts by
 * naming A's project. Same tenant-scoped lookup submit/commit already use
 * (`projectTaggedForTenant`, fails closed on an untagged row). A miss is the
 * bridge's not-found 404, identical for "foreign" and "does not exist", so it
 * is not an existence oracle.
 */
export async function assertProjectInCallerTenant(
  db: BridgeDb,
  projectId: string,
  tenantId: string,
): Promise<void> {
  return tenantScopedProjectCheck(db, projectId, tenantId);
}

async function tenantScopedProjectCheck(
  db: BridgeDb,
  projectId: string,
  tenantId: string,
): Promise<void> {
  const notFound = () =>
    new IntegrationError({ code: 'draft_not_found', message: 'Project not found', service: 'bridge' });
  // A non-UUID would reach a uuid column as a Postgres 500; it names no project.
  if (!isUuidShape(projectId)) throw notFound();
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), projectTaggedForTenant(tenantId)))
    .limit(1);
  if (!row) throw notFound();
}
