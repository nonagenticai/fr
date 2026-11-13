/**
 * G8 / R313 (George-approved 2026-10-19) — promoting a PROJECT copy of a governed asset
 * (requirement / principle / decision) to the tenant: the `asset.promotion` approval.
 *
 *   request  a member of the copy's project (or a workspace-admin) asks for it
 *            → one pending `asset.promotion` per copy, metadata
 *              {asset_type, copy_id, original_id, project_id, diff}.
 *   decide   the tenant's `tenant_admin`s only (R208: approver rights are fr's). ONE roster
 *            obligation, role `tenant_admin`: any one tenant_admin discharges it (role arm of
 *            resolveDecideEligibility); the P1-TEAM-b member arm is closed for this kind
 *            (`isTenantAdminOnlyKind`), so a plain member is told but cannot decide.
 *   notify   the tenant_admins as approvers, and EVERY member of the tenant (George 10-15).
 *   approve  fr calls RM `POST /{kind}/{copy_id}/promote {approved_by}` (fr-delegated, the
 *            approval's tenant). The original takes the copy's content as a new version; the
 *            copy becomes SUPERSEDED upstream. The outcome is stamped on the approval's
 *            metadata (`promotion`), never thrown: a failed upstream call must not turn a
 *            human's decision into an error response.
 *   reject   nothing changes in RM — the copy stays project-scoped.
 *
 * ⛔ Not the same operation as `POST /api/asset-scope/:type/:id/promote` (routes/asset-scope/
 * promote.ts), which widens an fr OWNERSHIP edge to workspace/department with no approval and
 * does not touch RM. That route is unchanged.
 */
import { and, eq, sql } from 'drizzle-orm';

import { approvals, assetAssignments, db as defaultDb, requiredApprovers } from '../../db/client';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { ensureAnswerable } from '../../domain/approvals/one-open-gate';
import { findTenantScopedProject } from '../../lib/project-access';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import type { User } from '../../types/api';
import { AppError, ForbiddenError, NotFoundError, pgErrorCode } from '../../utils/errors';

export const ASSET_PROMOTION_KIND = 'asset.promotion' as const;
/** The one roster role of an `asset.promotion` (a Keycloak realm role, matched by the role arm). */
const ASSET_PROMOTION_APPROVER_ROLE = 'tenant_admin' as const;
const PROMOTABLE_KINDS = ['requirement', 'principle', 'decision'] as const;
export type PromotableKind = (typeof PROMOTABLE_KINDS)[number];

/**
 * Migration 201: at most ONE pending `asset.promotion` per (tenant, copy). Named so a 23505 on
 * any other constraint is never mistaken for a concurrent request of the same copy.
 */
const ONE_PENDING_PROMOTION_INDEX = 'approvals_one_pending_asset_promotion_per_copy_idx' as const;

/** True ONLY for a unique violation raised by migration 201's index (err or its drizzle `cause`). */
function isOnePendingPromotionViolation(err: unknown): boolean {
  if (pgErrorCode(err) !== '23505') return false;
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const e = candidate as { code?: unknown; constraint_name?: unknown } | null | undefined;
    if (e?.code === '23505' && e.constraint_name === ONE_PENDING_PROMOTION_INDEX) return true;
  }
  return false;
}

/** A promotion waits for a tenant_admin; 14 days, then the expiry worker closes it. */
const PROMOTION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** The content fields compared for the diff (the upstream create schema minus lifecycle). */
const CONTENT_FIELDS: Readonly<Record<PromotableKind, readonly string[]>> = {
  requirement: ['title', 'description', 'acceptance', 'confidence', 'effort', 'impact', 'reach', 'links', 'lens_metadata'],
  principle: ['title', 'statement', 'rationale', 'implications', 'tags', 'active'],
  decision: ['title', 'context', 'decision', 'alternatives', 'consequences', 'status', 'related_principles', 'lens_metadata'],
};

export type AssetRow = Record<string, unknown>;
type AssetDiff = Record<string, { from: unknown; to: unknown }>;

function isPromotableKind(k: unknown): k is PromotableKind {
  return typeof k === 'string' && (PROMOTABLE_KINDS as readonly string[]).includes(k);
}

/** True for the kinds whose decision is the tenant_admins' alone (no member widening). */
export function isTenantAdminOnlyKind(kind: unknown): boolean {
  return kind === ASSET_PROMOTION_KIND;
}

function canonical(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === 'object'
        ? Object.fromEntries(Object.keys(x as Record<string, unknown>).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]))
        : (x ?? null);
  return JSON.stringify(norm(v));
}

/** Field-level diff original → copy over the kind's content fields. Pure. */
function diffAsset(kind: PromotableKind, original: AssetRow, copy: AssetRow): AssetDiff {
  const out: AssetDiff = {};
  for (const f of CONTENT_FIELDS[kind]) {
    if (canonical(original[f]) !== canonical(copy[f])) out[f] = { from: original[f] ?? null, to: copy[f] ?? null };
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

async function getAsset(kind: PromotableKind, id: string): Promise<AssetRow> {
  if (kind === 'requirement') return (await (await import('../../integrations/requirements')).getRequirement(id)) as unknown as AssetRow;
  if (kind === 'principle') return (await (await import('../../integrations/principles')).getPrinciple(id)) as unknown as AssetRow;
  return (await (await import('../../integrations/decisions')).getDecision(id)) as unknown as AssetRow;
}

async function promote(kind: PromotableKind, copyId: string, approvedBy: string, tenantId: string): Promise<AssetRow> {
  const body = { approved_by: approvedBy };
  if (kind === 'requirement') return (await (await import('../../integrations/requirements')).promoteRequirement(copyId, body, tenantId)) as unknown as AssetRow;
  if (kind === 'principle') return (await (await import('../../integrations/principles')).promotePrinciple(copyId, body, tenantId)) as unknown as AssetRow;
  return (await (await import('../../integrations/decisions')).promoteDecision(copyId, body, tenantId)) as unknown as AssetRow;
}

/** The tenant's tenant_admins: `user_roles` workspace-admins ∪ Keycloak realm `tenant_admin` holders. */
async function listTenantAdmins(tenantId: string): Promise<string[]> {
  const { listWorkspaceAdminRecipients } = await import('../workspace-admin-recipients');
  return (await listWorkspaceAdminRecipients(tenantId)).userIds;
}

async function isWorkspaceAdmin(user: User, tenantId: string): Promise<boolean> {
  const { userRolesService } = await import('../user-roles');
  return userRolesService.isWorkspaceAdminVia(user, tenantId, userRolesService.hasRole);
}

async function isProjectMember(user: User, projectId: string): Promise<boolean> {
  return (await findTenantScopedProject(defaultDb, user, projectId)) !== undefined;
}

/** The original this copy overrides, from fr's own OQ-16 override edge (`project_assets.edit` writes it). */
async function originalFromOverride(tenantId: string, kind: PromotableKind, copyId: string): Promise<string | null> {
  const rows = await defaultDb
    .select({ overrides_id: assetAssignments.overrides_id })
    .from(assetAssignments)
    .where(
      and(
        eq(assetAssignments.workspace_id, tenantId),
        eq(assetAssignments.asset_type, kind),
        eq(assetAssignments.asset_id, copyId),
        eq(assetAssignments.link_kind, 'override'),
      ),
    );
  const parentId = rows.find((r) => r.overrides_id !== null)?.overrides_id ?? null;
  if (parentId === null) return null;
  const [parent] = await defaultDb
    .select({ asset_id: assetAssignments.asset_id })
    .from(assetAssignments)
    .where(eq(assetAssignments.id, parentId));
  return parent?.asset_id ?? null;
}

async function notify(approval: typeof approvals.$inferSelect, tenantId: string, approverIds: string[]): Promise<void> {
  const [{ notificationService }, { fanOutApprovalToTenantMembers }] = await Promise.all([
    import('../../domain/engagement/notifications'),
    import('../../domain/engagement/tenant-member-fanout'),
  ]);
  const a = { ...approval, metadata: approval.metadata ?? null };
  for (const id of approverIds) {
    notificationService
      .fanOutToUser(a, id, 'approval')
      .catch((err: unknown) => reportSwallowedFailure(err, { service: 'fr', method: 'asset-promotion.notify_approver', degradedTo: 'approver not told (row stays pending, visible in the queue)' }));
  }
  // George 10-15: every member of the tenant is told (told, not enrolled). Never throws.
  void fanOutApprovalToTenantMembers({ approval: a, tenantId, alreadyNotified: approverIds, context: 'asset-promotion' });
}

interface RequestPromotionInput {
  user: User;
  tenantId: string;
  kind: PromotableKind;
  copyId: string;
  /** Optional: the original's id when the caller knows it; else read from the override edge. */
  originalId?: string;
  note?: string;
}

interface RequestPromotionResult {
  approval_id: string;
  status: string;
  deduplicated: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Raise (or return the open) `asset.promotion` for a project copy. Refuses:
 *   404 the copy does not exist for this tenant (upstream 404 propagates);
 *   409 `not_a_project_copy` (not origin_kind=project, or no `supersedes`);
 *   409 `asset_superseded` (already promoted/merged);
 *   403 `promotion_requires_project_member` (not a member of the copy's project, not an admin);
 *   409 `promotion_original_unknown` (no override edge and no original_id given, or the
 *       original's slug is not the copy's `supersedes`);
 *   409 `promotion_no_approver` (the tenant has no tenant_admin — never a row nobody can answer).
 */
export async function requestAssetPromotion(input: RequestPromotionInput): Promise<RequestPromotionResult> {
  const { user, tenantId, kind, copyId } = input;
  const copy = await getAsset(kind, copyId);
  const projectId = copy.origin_kind === 'project' ? str(copy.origin_project_id) : null;
  const supersedes = str(copy.supersedes);
  if (projectId === null || supersedes === null) {
    throw new AppError(409, `this ${kind} is not a project copy of a workspace ${kind}; there is nothing to promote`).withCode('not_a_project_copy');
  }
  if (str(copy.version_status)?.toUpperCase() === 'SUPERSEDED' || str(copy.superseded_by) !== null) {
    throw new AppError(409, `this ${kind} copy was already promoted`).withCode('asset_superseded');
  }
  const admin = isSuperAdmin(user) || (await isWorkspaceAdmin(user, tenantId));
  if (!admin && !(await isProjectMember(user, projectId.toLowerCase()))) {
    throw new ForbiddenError('only a member of the project this copy belongs to may ask for it to be promoted').withCode('promotion_requires_project_member');
  }

  const originalId = str(input.originalId) ?? (await originalFromOverride(tenantId, kind, copyId));
  if (originalId === null) {
    throw new AppError(409, `the workspace ${kind} this copy replaces could not be found; pass original_id`).withCode('promotion_original_unknown');
  }
  const original = await getAsset(kind, originalId);
  if (str(original.slug) !== supersedes) {
    throw new AppError(409, `the given original is not the ${kind} this copy was made from`).withCode('promotion_original_unknown');
  }
  const diff = diffAsset(kind, original, copy);

  // One open promotion per copy: a second request returns the pending one. A decided
  // (approved / rejected), expired or voided one does not block a fresh request.
  const pendingFor = async () => {
    const [row] = await defaultDb
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.tenant_id, tenantId),
          eq(approvals.kind, ASSET_PROMOTION_KIND),
          eq(approvals.status, 'pending'),
          sql`${approvals.metadata}->>'copy_id' = ${copyId}`,
        ),
      )
      .limit(1);
    return row;
  };
  const dedupe = (row: typeof approvals.$inferSelect): RequestPromotionResult => ({
    approval_id: row.id,
    status: row.status,
    deduplicated: true,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  });
  const open = await pendingFor();
  if (open) return dedupe(open);

  // WHO decides: the tenant's tenant_admins. Refuse rather than mint a row nobody can answer
  // (scripts/check-approval-mint-guard.ts).
  const approvers = await listTenantAdmins(tenantId);
  const firstApprover = approvers[0];
  if (approvers.length === 0 || firstApprover === undefined) {
    throw new AppError(409, 'this workspace has no administrator who could approve a promotion').withCode('promotion_no_approver');
  }

  const title = str(copy.title) ?? copyId;
  const metadata: Record<string, unknown> = {
    asset_type: kind,
    copy_id: copyId,
    original_id: originalId,
    project_id: projectId,
    diff,
    ...(str(input.note) ? { note: str(input.note) } : {}),
  };
  const fields = Object.keys(diff);
  // The answerability chokepoint (domain/approvals/one-open-gate.ts): write the values IT returns.
  const values = await ensureAnswerable({
    tenantId,
    cardId: null,
    values: {
      tenant_id: tenantId,
      project_id: null,
      requester_id: user.id,
      status: 'pending',
      kind: ASSET_PROMOTION_KIND,
      description: `Promote the project version of ${kind} "${title}" to the whole workspace`,
      change_summary: fields.length > 0 ? `Changed fields: ${fields.join(', ')}` : 'No content change against the workspace version',
      source: 'web',
      metadata,
      approver_user_id: firstApprover,
      expires_at: new Date(Date.now() + PROMOTION_TTL_MS),
    },
  });
  let approval: typeof approvals.$inferSelect;
  try {
    approval = await defaultDb.transaction(async (tx) => {
      const [row] = await tx
        .insert(approvals)
        .values(values)
        .returning();
      if (!row) throw new AppError(500, 'the promotion approval was not written').withCode('promotion_not_written');
      // ONE obligation, held by the role: any tenant_admin discharges it (1-of-N, not N-of-N).
      await tx.insert(requiredApprovers).values({
        tenant_id: tenantId,
        approval_id: row.id,
        user_id: firstApprover,
        role: ASSET_PROMOTION_APPROVER_ROLE,
      });
      return row;
    });
  } catch (err) {
    // A concurrent request for the same copy won the race on migration 201's index: answer
    // with ITS row, exactly as the pre-check above would have. Nothing of ours was written.
    if (!isOnePendingPromotionViolation(err)) throw err;
    const winner = await pendingFor();
    if (!winner) throw err;
    return dedupe(winner);
  }
  await notify(approval, tenantId, approvers);
  return { approval_id: approval.id, status: approval.status, deduplicated: false, metadata };
}

/**
 * The OPEN (pending) promotion of one copy in this tenant, or the most recent decided one —
 * what the UI shows next to a project copy. Tenant-pinned; null when none was ever raised.
 */
export async function findAssetPromotion(
  tenantId: string,
  copyId: string,
): Promise<{ approval_id: string; status: string; promotion: unknown } | null> {
  const rows = await defaultDb
    .select({ id: approvals.id, status: approvals.status, metadata: approvals.metadata, created_at: approvals.created_at })
    .from(approvals)
    .where(
      and(
        eq(approvals.tenant_id, tenantId),
        eq(approvals.kind, ASSET_PROMOTION_KIND),
        sql`${approvals.metadata}->>'copy_id' = ${copyId}`,
      ),
    )
    .orderBy(sql`${approvals.created_at} DESC`)
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { approval_id: r.id, status: r.status, promotion: (r.metadata as Record<string, unknown> | null)?.promotion ?? null };
}

/**
 * The decided `asset.promotion`: approve ⇒ RM promote; reject ⇒ nothing upstream.
 * NEVER throws. The outcome is stamped on `metadata.promotion`.
 */
export async function onAssetPromotionDecided(input: {
  approval: { id: string; tenant_id: string; kind: string | null; metadata: Record<string, unknown> | null };
  status: string;
  decidedBy: string;
}): Promise<{ outcome: 'promoted' | 'not_promoted' | 'failed'; error?: string }> {
  const { approval, status, decidedBy } = input;
  if (approval.kind !== ASSET_PROMOTION_KIND) return { outcome: 'not_promoted' };
  const meta = approval.metadata ?? {};
  const stamp = async (promotion: Record<string, unknown>): Promise<void> => {
    try {
      await defaultDb
        .update(approvals)
        .set({ metadata: { ...meta, promotion } })
        .where(eq(approvals.id, approval.id));
    } catch (err) {
      reportSwallowedFailure(err, { service: 'fr', method: 'asset-promotion.stamp', degradedTo: 'promotion outcome not stamped on the approval' });
    }
  };
  if (status !== 'approved') {
    await stamp({ outcome: 'not_promoted', status, at: new Date().toISOString() });
    return { outcome: 'not_promoted' };
  }
  const kind = meta.asset_type;
  const copyId = str(meta.copy_id);
  if (!isPromotableKind(kind) || copyId === null) {
    await stamp({ outcome: 'failed', error: 'metadata carries no asset_type/copy_id', at: new Date().toISOString() });
    return { outcome: 'failed', error: 'metadata carries no asset_type/copy_id' };
  }
  try {
    const promoted = await promote(kind, copyId, decidedBy, approval.tenant_id);
    await stamp({ outcome: 'promoted', original_id: promoted.id ?? meta.original_id ?? null, version: promoted.version ?? null, at: new Date().toISOString() });
    return { outcome: 'promoted' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    reportSwallowedFailure(err, { service: 'requirements_management', method: 'POST', path: `/${kind}s/${copyId}/promote`, degradedTo: 'approval stays approved; promotion recorded as failed on its metadata' });
    await stamp({ outcome: 'failed', error, at: new Date().toISOString() });
    return { outcome: 'failed', error };
  }
}

/** Exposed for the route + agent action: 404 shape for an unknown kind. */
export function parsePromotableKind(raw: string): PromotableKind {
  if (!isPromotableKind(raw)) throw new NotFoundError(`${raw} cannot be promoted (requirement, principle or decision only)`);
  return raw;
}
