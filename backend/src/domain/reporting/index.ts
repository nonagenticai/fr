// src/domain/reporting/index.ts
//
// Read-only reporting functions. Compose the Phase 3 adapters under
// src/integrations/* + the local approvals table. Never reach into upstream
// services directly from here — go through the adapters so future agent-over-
// Telegram / agent-over-Teams channels get the same access controls.
import { and, eq, desc } from 'drizzle-orm';
import { db, approvals, requiredApprovers, approvalDecisions, projects, departments } from '../../db/client';
import { NotFoundError } from '../../utils/errors';
import * as kanbanAdapter from '../../integrations/kanban';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import * as workersAdapter from '../../integrations/workers';
import type { WorkerActivityEvent } from '../../integrations/workers';
import * as requirementsAdapter from '../../integrations/requirements';
import * as decisionsAdapter from '../../integrations/decisions';
import * as principlesAdapter from '../../integrations/principles';
import { keycloak } from '../../services/keycloak';

export interface ApprovalSummary {
  id: string;
  project_id: string | null;
  description: string;
  status: string;
  created_at: Date;
  /** NULL = no deadline, ever (migration 105). Never compare it bare: `new Date(null)` is epoch 0. */
  expires_at: Date | null;
  role: string | null;
}

export interface ApprovalBacklog {
  pending: ApprovalSummary[];
  count: number;
}

/**
 * Approvals the user is required to decide on, still pending. Uses the local
 * required_approvers table as the filter — no upstream call. The `tenant_id`
 * predicate is defense-in-depth (a user only ever appears in their own tenant's
 * required_approvers rows) and keeps this query symmetric with the tenant-scoped
 * `handleListMyApprovals` (routes/approvals.ts, PR #77).
 */
export async function approvalBacklog(userId: string, tenantId: string): Promise<ApprovalBacklog> {
  const rows = await db.select({
    id: approvals.id,
    project_id: approvals.project_id,
    description: approvals.description,
    status: approvals.status,
    created_at: approvals.created_at,
    expires_at: approvals.expires_at,
    role: requiredApprovers.role,
  })
    .from(approvals)
    .innerJoin(requiredApprovers, eq(requiredApprovers.approval_id, approvals.id))
    .where(and(
      eq(approvals.tenant_id, tenantId),
      eq(requiredApprovers.user_id, userId),
      eq(approvals.status, 'pending'),
    ))
    .orderBy(desc(approvals.created_at));

  const pending: ApprovalSummary[] = rows.map((r) => ({
    id: r.id,
    project_id: r.project_id,
    description: r.description,
    status: r.status,
    created_at: r.created_at,
    expires_at: r.expires_at,
    role: r.role,
  }));
  return { pending, count: pending.length };
}

export interface ProjectStatus {
  project: unknown;
  openApprovals: ApprovalSummary[];
  recentDecisions: Array<{
    approval_id: string;
    approver_id: string;
    /** The approver's display name (or e-mail); null when unresolved. Additive. */
    approver_name: string | null;
    decision: string;
    decided_at: Date;
    comment: string | null;
    /** Migration 211 (R-CK1): human | triage_agent | rule. */
    decided_by_kind: string;
  }>;
  boardProgress: {
    lists: Array<{
      id: string;
      name: string;
      /**
       * ⛔ THREE STATES. Collapsing any two of them is the defect.
       *
       *   N  + `cardCountComplete: true`  — N cards, measured. Exact.
       *   N  + `cardCountComplete: false` — AT LEAST N. The list is longer than
       *        the count walk was budgeted to read (Planka pages at 50).
       *        Render "N+".
       *   null                            — the list could not be read at all.
       *        We know NOTHING. Render "—", never a number.
       *
       * The third state used to be `0`, indistinguishable from an empty list.
       * Folding it into `cardCountComplete: false` instead would be no better:
       * "0+" still asserts that we looked and found none.
       */
      cardCount: number | null;
      /** Meaningful only when `cardCount !== null`. See above. */
      cardCountComplete: boolean;
    }>;
  } | null;
}

/**
 * Compose FR approvals/decisions with the kanban adapter so reports can show
 * "project X: 3 open approvals, last week moved 5 cards to Done". If the
 * project has no planka_board_id we skip the kanban portion (boardProgress=null).
 *
 * Tenant-scoped: `projectId` is attacker-controlled, so we resolve the project's
 * tenant via the `dept → departments.workspace_id` chain (with the
 * `project_data.keycloak_tenant_id` fallback for dept-less projects — same chain
 * as migration 080 / execution-approvals.ts) and 404 on any cross-tenant or
 * un-attributable project. The 404 is identical to "not found" so a foreign id
 * cannot be distinguished from a non-existent one (no existence leak).
 */
export async function projectStatus(projectId: string, tenantId: string): Promise<ProjectStatus> {
  const [row] = await db
    .select({ project: projects, deptTenant: departments.workspace_id })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, projectId));
  if (!row) {
    // NotFoundError (AppError → statusCode 404) so the server's error handler
    // maps it correctly. A plain Error with a `statusCode` prop falls through
    // to a 500 (handleError only honours AppError).
    throw new NotFoundError('Project not found');
  }
  const project = row.project;
  const resolvedTenant =
    row.deptTenant ??
    (project.project_data as { keycloak_tenant_id?: string } | null)?.keycloak_tenant_id ??
    null;
  if (resolvedTenant !== tenantId) {
    // Cross-tenant OR un-attributable project → same 404 as a missing project
    // (no existence leak: a foreign id is indistinguishable from a missing one).
    throw new NotFoundError('Project not found');
  }

  const openApprovalRows = await db.select()
    .from(approvals)
    .where(and(
      eq(approvals.project_id, projectId),
      eq(approvals.tenant_id, tenantId),
      eq(approvals.status, 'pending'),
    ))
    .orderBy(desc(approvals.created_at));

  const openApprovals: ApprovalSummary[] = openApprovalRows.map((a) => ({
    id: a.id,
    project_id: a.project_id,
    description: a.description,
    status: a.status,
    created_at: a.created_at,
    expires_at: a.expires_at,
    role: null,
  }));

  // Recent decisions across all approvals of this project, newest first.
  const recentDecisionRows = await db.select({
    approval_id: approvalDecisions.approval_id,
    approver_id: approvalDecisions.approver_id,
    decision: approvalDecisions.decision,
    decided_at: approvalDecisions.decided_at,
    comment: approvalDecisions.comment,
    decided_by_kind: approvalDecisions.decided_by_kind,
    project_id: approvals.project_id,
  })
    .from(approvalDecisions)
    .innerJoin(approvals, eq(approvals.id, approvalDecisions.approval_id))
    .where(and(eq(approvals.project_id, projectId), eq(approvals.tenant_id, tenantId)))
    .orderBy(desc(approvalDecisions.decided_at))
    .limit(25);

  // FR-9: the status report used to print each decision's raw approver UUID. Names
  // come from the same batched Keycloak resolve the approvals routes use.
  // ONE batched resolve for the ≤25 rows; a degraded Keycloak renders ids, never 5xx.
  let approverNames: Record<string, { name?: string | null; email?: string | null }> = {};
  try {
    approverNames = await keycloak.resolveUsers(
      recentDecisionRows.map((d) => d.approver_id).filter((id): id is string => Boolean(id)),
      25,
    );
  } catch (err) {
    console.error('[reporting] approver identity resolve failed:', err);
  }

  const recentDecisions = recentDecisionRows.map((d) => ({
    approval_id: d.approval_id,
    approver_id: d.approver_id,
    approver_name:
      approverNames[d.approver_id]?.name?.trim() || approverNames[d.approver_id]?.email || null,
    decision: d.decision,
    decided_at: d.decided_at,
    comment: d.comment,
    decided_by_kind: d.decided_by_kind,
  }));

  let boardProgress: ProjectStatus['boardProgress'] = null;
  const boardId = project.planka_board_id;
  if (boardId) {
    try {
      const board = await kanbanAdapter.getBoard(boardId);
      // Planka returns `{ item, included }` — `board.lists` does not exist, and
      // the `as any` cast that used to sit here is what stopped the compiler
      // from saying so. Measured against the live board 1854342361253938197:
      // top-level keys are ["item","included"], `board.lists` is `undefined`,
      // and the 8 lists are at `included.lists`. So the old expression yielded
      // `[]` on EVERY call and the loop below has never executed once —
      // `boardProgress.lists` has always been empty in production, which also
      // made the per-list cardCount defect unreachable rather than merely wrong.
      // `?? []` mirrors services/planka/lists.ts:63, the reader that had it right.
      const lists = board.included?.lists ?? [];
      const listProgress: NonNullable<ProjectStatus['boardProgress']>['lists'] = [];
      // Per-list tolerance is deliberate; reading NOTHING and calling it zero
      // is not. See the rethrow below the loop.
      let attempted = 0;
      let failed = 0;
      let firstReadError: unknown;
      for (const list of lists) {
        if (!list || typeof list.id !== 'string') continue;
        attempted++;
        // ⚠️ `countCardsByList`, NOT `listCardsByList(...).items.length`.
        // `GET /lists/:id/cards` is cursor-paginated at 50 (measured on the
        // running Planka pod, `Card.js:9`), so `items.length` capped this
        // rollup at 50 and presented it as the list's total. Eleven live lists
        // exceed 50; the largest holds 2,842. `cardCountComplete` now travels
        // with the number so the report can say "at least".
        //
        // (The earlier defect on this line was different and is fixed: it read
        // `Array.isArray(cards) ? cards.length : 0`, which is false on SUCCESS
        // too, so every list reported 0.)
        const cards = await kanbanAdapter
          .countCardsByList(list.id)
          .catch((err: unknown) => {
            // ⚠️ NOTHING IS BEING FIXED HERE. This site is already correct: the
            // aggregate below refuses to launder an outage — every list failing
            // rethrows `firstReadError`, so the caller gets the upstream's own
            // status instead of a confident 200 whose every cardCount is 0, and a
            // partial failure warns with the `failed/attempted` ratio. What that
            // aggregate cannot carry is WHICH list failed and why; that per-list
            // cause is the only thing added.
            failed++;
            firstReadError ??= err;
            reportSwallowedFailure(err, {
              service: 'kanban',
              degradedTo: `list ${list.id} reports cardCount null (unread) in the board rollup`,
            });
            return null;
          });
        listProgress.push({
          id: list.id,
          name: typeof list.name === 'string' ? list.name : '',
          // ⛔ `null`, never 0. A 0 that means "we could not look" is
          // indistinguishable from "this list is empty", and the aggregate
          // rethrow below only covers TOTAL failure — a SINGLE failed list used
          // to vanish into a confident zero right here.
          cardCount: cards ? cards.count : null,
          cardCountComplete: cards ? cards.complete : false,
        });
      }
      // Every list unreadable is an outage, not a board of empty lists. The
      // captured cause is rethrown so the status is the upstream's own
      // (UPSTREAM_UNAUTHORIZED -> 502, UPSTREAM_TIMEOUT -> 504) rather than a
      // confident 200 whose every cardCount is 0.
      if (attempted > 0 && failed === attempted) throw firstReadError;
      if (failed > 0) {
        console.warn(
          `[reporting] partial board read on ${boardId}: ${failed}/${attempted} card reads failed`,
        );
      }
      boardProgress = { lists: listProgress };
    } catch (err) {
      // Surface upstream failures rather than silently returning empty data —
      // the route will translate IntegrationError via normal error handling.
      throw err;
    }
  }

  return { project, openApprovals, recentDecisions, boardProgress };
}

export interface WorkerActivity {
  worker: unknown;
  since?: string;
  events: WorkerActivityEvent[];
}

/**
 * Project the workers service state stream as an activity stream. Until the
 * upstream exposes a dedicated activity endpoint, the adapter
 * (`listWorkerActivity`) derives events from `/workers/{name}/states`.
 */
export async function workerActivity(
  workerId: string,
  since?: string,
): Promise<WorkerActivity> {
  const [worker, events] = await Promise.all([
    workersAdapter.getWorker(workerId),
    workersAdapter.listWorkerActivity(workerId, since),
  ]);
  return { worker, since, events };
}

export type AssetType = 'requirements' | 'decisions' | 'principles';

export interface AssetChange {
  id?: string;
  version?: number | string;
  updated_at?: string;
  raw: unknown;
}

export interface AssetChangeHistory {
  changes: AssetChange[];
  assetType: AssetType;
  since?: string;
  note?: string;
}

/**
 * Dispatch to the right integration's listVersions endpoint. `requirements`
 * has no versions endpoint upstream — return an explicit note so callers see
 * the gap instead of empty data.
 *
 * When `since` is provided we best-effort filter by any `updated_at` / `created_at`
 * string field on the raw entry.
 */
export async function assetChangeHistory(
  assetType: AssetType,
  since?: string,
  assetId?: string,
): Promise<AssetChangeHistory> {
  const cutoff = since ? Date.parse(since) : NaN;

  const filter = (rows: unknown[]): AssetChange[] => {
    const mapped: AssetChange[] = rows.map((r) => {
      const rec = (r as Record<string, unknown>) ?? {};
      return {
        id: typeof rec.id === 'string' ? rec.id : undefined,
        version: (rec.version as number | string | undefined) ?? undefined,
        updated_at: typeof rec.updated_at === 'string'
          ? rec.updated_at
          : (typeof rec.created_at === 'string' ? rec.created_at : undefined),
        raw: r,
      };
    });
    if (!Number.isFinite(cutoff)) return mapped;
    return mapped.filter((c) => {
      if (!c.updated_at) return true;
      const ts = Date.parse(c.updated_at);
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
  };

  switch (assetType) {
    case 'decisions': {
      if (!assetId) {
        return {
          changes: [],
          assetType,
          since,
          note: 'decisions requires assetId (decision id) to list versions',
        };
      }
      const versions = await decisionsAdapter.listDecisionVersions(assetId);
      return { changes: filter(versions as unknown[]), assetType, since };
    }
    case 'principles': {
      if (!assetId) {
        return {
          changes: [],
          assetType,
          since,
          note: 'principles requires assetId (principle id) to list versions',
        };
      }
      const versions = await principlesAdapter.listPrincipleVersions(assetId);
      return { changes: filter(versions as unknown[]), assetType, since };
    }
    case 'requirements': {
      if (!assetId) {
        return {
          changes: [],
          assetType,
          since,
          note: 'requirements requires assetId (requirement id) to list versions',
        };
      }
      const versions = await requirementsAdapter.listRequirementVersions(assetId);
      return { changes: filter(versions as unknown[]), assetType, since };
    }
  }
}
