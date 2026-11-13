/**
 * E-5: Generic action-approval bus.
 *
 * Binds a write-action invocation (E-2 AG-UI registry) to the existing
 * approvals domain so a write action with a non-auto policy creates a
 * pending approval, broadcasts to required approvers via the existing
 * NotificationService.fanOutToUser machinery, and defers handler
 * execution until consensus is reached.
 *
 * On approval, the deferred handler runs under the original ActionContext
 * (correlationId, channel, initiator) but AS THE APPROVER (P1-TEAM-c, George
 * 2026-10-15: any tenant member may approve; the action runs under the approver's
 * user id, fresh membership and RBAC, never the requester's) inside an emitSpan wrap; the result
 * is recorded in engagement_deliveries (with action_id) and a result
 * message is delivered back through the originating channel via
 * NotificationChannel.sendMessage (E-6). On rejection, the handler is
 * NOT invoked and the originator is notified.
 *
 * This module registers itself as the registry's ApprovalBackend at import
 * time, so simply importing it (eg. from server.ts) wires invokeAction
 * for write actions.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { AppError } from '../../utils/errors';
import { projectTaggedForTenant } from '../../lib/project-access';
import { isUuidShape } from '../../lib/uuid-shape';
import { assertProjectNotArchived, PROJECT_ARCHIVED } from '../../lib/project-live-status';

import {
  db,
  approvals,
  approvalDecisions,
  requiredApprovers,
  engagementDeliveries,
  projects,
} from '../../db/client';
import {
  setApprovalBackend,
  getAction,
  type ApprovalBackend,
} from '../../agui/registry';
import type {
  AgentCallableAction,
  ActionContext,
  ApprovalPolicy,
} from '../../agui/types';
import { approvalNotificationCopy, notificationService } from './notifications';
import type { ChannelMessage } from './notifications';
import { getChannel, WEB_SESSION_CHANNELS } from '../../channels';
import { approverActionPrincipal, assertChannelTenantResolved } from '../../capabilities/principal';
import { assertRbac } from '../../agui/rbac';
import { fanOutApprovalToTenantMembers } from './tenant-member-fanout';
import { isAgentMemberId } from './agent-members';
import { emitSpan } from '../../telemetry/spans';
import { withRequestContext } from '../../integrations/_lib/context';
import {
  recordSyncUploadRow,
  estimateBase64DecodedBytes,
} from '../../services/kag-upload-record';

const DEFAULT_APPROVAL_TTL_SECONDS = 24 * 60 * 60;

/**
 * The KAG sync-upload action whose parked-then-approved execution durably writes
 * PHI (chunks/entities/Neo4j) to kag_graph. Its inline (human self-approved)
 * counterpart records an fr `documents` row in routes/tools/kag.ts; the parked
 * path executes HERE, so it must record the mirror row or the PHI is
 * un-purgeable (right-to-delete keys entirely off `documents` rows). The async
 * `kag.upload_document` action is intentionally NOT included: its inline path
 * records no row either, so recording it only on approval would be an asymmetric
 * change beyond this fix's scope (tracked separately).
 */
const KAG_SYNC_UPLOAD_ACTION = 'kag.upload_document_sync';

// ---------- Errors ----------
//
// ⚠️ All four extend AppError so `handleError` renders a real status. They used
// to extend bare `Error`, and they are reached from `routes/agui.ts` THROUGH the
// `setApprovalBackend` indirection -- which is exactly why no static analysis
// flags them and why they quietly returned `500 {"error":"Internal server
// error"}` for a missing projectId, an unknown project, and a caller who simply
// is not a member of any tenant. ⛔ Each re-sets `this.name` AFTER super():
// AppError's constructor sets it to 'AppError'.

export class ProjectOwnerRequiredError extends AppError {
  constructor(actionName: string) {
    // 400: the agent omitted a required argument. Its own message says so.
    super(
      400,
      `Action ${actionName} uses approval policy 'project-owner' but ctx.projectId is null. The agent must call this action with a projectId.`,
    );
    this.name = 'ProjectOwnerRequiredError'; // ⛔ after super() — see AppError
    this.code = 'PROJECT_ID_REQUIRED';
  }
}

export class AutoPolicyNotAllowedError extends AppError {
  constructor(actionName: string) {
    // Stays 500: its own message says "this is a defect" — a real server bug,
    // not the caller's fault. It gains a CODE so it is distinguishable from
    // the anonymous fallthrough it used to be indistinguishable from.
    super(
      500,
      `Action ${actionName} reached requestActionApproval with policy.type='auto'. write+auto must be rejected at registerAction; this is a defect.`,
    );
    this.name = 'AutoPolicyNotAllowedError'; // ⛔ after super() — see AppError
    this.code = 'AUTO_POLICY_NOT_ALLOWED';
  }
}

export class UnknownProjectError extends AppError {
  constructor(projectId: string) {
    // 404: the named project does not exist.
    super(404, `Unknown project ${projectId} for project-owner approval policy lookup.`);
    this.name = 'UnknownProjectError'; // ⛔ after super() — see AppError
    this.code = 'UNKNOWN_PROJECT';
  }
}

/**
 * Migration 042 made `approvals.tenant_id` and `required_approvers.tenant_id`
 * NOT NULL. Action approvals route through the AG-UI registry, which
 * populates `ctx.tenantId` at the invoke layer (see routes/agui.ts). If a
 * caller reaches `requestActionApproval` with `ctx.tenantId === undefined`
 * the user has no `user_roles` row — meaning they're not actually a member
 * of any tenant — and no approval should be created on their behalf.
 */
export class TenantContextRequiredError extends AppError {
  constructor(actionName: string) {
    // 403, not 500: the docstring above says the caller "has no user_roles row
    // — meaning they're not actually a member of any tenant". That is an
    // authorization outcome, and it must not read as an fr crash.
    super(
      403,
      `Action ${actionName} requires a tenant-scoped ctx.tenantId to create an approval. Caller has no resolvable tenant (no user_roles row).`,
    );
    this.name = 'TenantContextRequiredError'; // ⛔ after super() — see AppError
    this.code = 'TENANT_CONTEXT_REQUIRED';
  }
}

// ---------- Public types ----------

export interface PendingActionRecord {
  actionId: string;
  actionName: string;
  userId: string;
  projectId: string | null;
  input: unknown;
  approvalId: string;
  correlationId: string;
  channel: string;
  createdAt: Date;
}

// ---------- Helpers ----------

async function resolveRequiredApprovers(
  policy: ApprovalPolicy,
  action: AgentCallableAction,
  ctx: ActionContext,
): Promise<{ approvers: string[]; minRequired: number }> {
  switch (policy.type) {
    case 'auto':
      throw new AutoPolicyNotAllowedError(action.name);
    case 'single-approver': {
      let approverId: string;
      if (policy.approver === 'initiator') {
        approverId = ctx.userId;
      } else if (policy.approver === 'project-owner') {
        if (!ctx.projectId) throw new ProjectOwnerRequiredError(action.name);
        const [project] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, ctx.projectId));
        if (!project) throw new UnknownProjectError(ctx.projectId);
        approverId = project.owner_id;
      } else {
        approverId = policy.approver;
      }
      return { approvers: [approverId], minRequired: 1 };
    }
    case 'consensus':
      return { approvers: [...policy.approvers], minRequired: policy.min };
    case 'n-of-m':
      return { approvers: [...policy.approvers], minRequired: policy.n };
    default: {
      // Exhaustiveness — TS will warn if a new policy variant is added.
      const _exhaustive: never = policy;
      throw new Error(`Unhandled approval policy: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function buildDescription(action: AgentCallableAction, ctx: ActionContext): string {
  const projectPart = ctx.projectId ? ` (project ${ctx.projectId})` : '';
  return `${action.description} — action ${action.name}${projectPart}`;
}

// ---------- Public API ----------

/**
 * Create an approvals row tied to a pending action invocation, fan-out
 * approval-request notifications to the required approvers, and return a
 * pending descriptor that surfaces via invokeAction to the caller.
 *
 * Defers the actual handler execution until consensus flips terminal —
 * see {@link resolvePendingAction}, which the approvals decision route
 * is wired to call.
 */
/**
 * True when `ctx` names an EXTERNAL inbound channel adapter (Telegram,
 * Teams, email, …) — the contexts whose principal is a §6.5 channel principal.
 * fr's own web chat-box channels (`WEB_SESSION_CHANNELS`: 'web', 'inapp') are
 * excluded: their tenant is the web session's, not a membership pick.
 */
export function isChannelDispatchedContext(ctx: Pick<ActionContext, 'channel'>): boolean {
  return !WEB_SESSION_CHANNELS.has(ctx.channel) && getChannel(ctx.channel) !== undefined;
}

export async function requestActionApproval(
  action: AgentCallableAction,
  input: unknown,
  ctx: ActionContext,
): Promise<{ status: 'pending'; actionId: string; approvalId: string }> {
  const policy = action.approval;
  const { approvers, minRequired } = await resolveRequiredApprovers(policy, action, ctx);

  // Migration 042 — every approval row must carry a tenant_id. The AG-UI
  // invoke layer (routes/agui.ts) resolves ctx.tenantId from the agent
  // session; unauthenticated/unaffiliated callers hit this branch and we
  // refuse to create the approval rather than silently dropping the
  // tenant scope.
  if (!ctx.tenantId) {
    throw new TenantContextRequiredError(action.name);
  }
  const tenantId = ctx.tenantId;

  // fr-agui SPEC §6.5 rule 2, layer 2: a write parked from an inbound CHANNEL
  // (a registered channel adapter other than 'web', whose tenant comes from the
  // agent session) must be parked in the sender's ONE membership tenant. The
  // channel dispatcher already derives it with `resolveChannelTenant`; this
  // re-derives it here so a path that skipped the dispatcher, or took its tenant
  // from anywhere else, parks nothing for a multi-workspace sender.
  if (isChannelDispatchedContext(ctx)) {
    await assertChannelTenantResolved(ctx);
  }

  // fr#1500: refuse a mint on an ARCHIVED project (409 `project_archived`).
  // ctx.projectId comes from the signed AG-UI agent token, which can predate
  // the archive, so it is re-checked here. The approvals project lane hides
  // archived projects, so an approval minted on one would be invisible
  // forever. Tenant-scoped by the project's own tag (fails closed on an
  // untagged row); a miss is this module's existing not-found answer
  // (`UnknownProjectError`, 404 UNKNOWN_PROJECT) — identical for a foreign
  // and a nonexistent id, so no existence oracle. `archived` ONLY.
  if (ctx.projectId) {
    // A non-UUID can never name a row; answer it as the miss it is rather than
    // letting the uuid cast escape as a 500.
    if (!isUuidShape(ctx.projectId)) throw new UnknownProjectError(ctx.projectId);
    const [project] = await db
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(and(eq(projects.id, ctx.projectId), projectTaggedForTenant(tenantId)))
      .limit(1);
    if (!project) throw new UnknownProjectError(ctx.projectId);
    assertProjectNotArchived(project);
  }

  const ttlSeconds = action.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const actionId = crypto.randomUUID();

  const metadata: Record<string, unknown> = {
    kind: 'action',
    action_name: action.name,
    initiator: ctx.initiator,
    min_required: minRequired,
    // The workspace the requester's channel link is pinned to (dispatcher-set,
    // migration 216). Restored when the action runs, so the handler's own rule-2
    // re-check resolves a pinned multi-workspace requester as the park step did.
    ...(ctx.channelLinkedTenantId ? { channel_linked_tenant_id: ctx.channelLinkedTenantId } : {}),
    // fr #1683: a request through the agent member (requester_id is the agent itself, or the
    // staff member it relayed): which agent member and job it came through.
    ...(ctx.decisionVia ? { via: ctx.decisionVia } : {}),
  };

  // Wrap the approvals row + required_approvers inserts in a single
  // transaction so a failure in step (b) doesn't leave an orphaned pending
  // approval with zero required approvers. Fan-out (network I/O,
  // fire-and-forget) intentionally stays OUTSIDE the transaction.
  const approval = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(approvals)
      .values({
        tenant_id: tenantId,
        project_id: ctx.projectId ?? null,
        requester_id: ctx.userId,
        status: 'pending',
        description: buildDescription(action, ctx),
        source: ctx.channel,
        callback_path: null,
        metadata,
        expires_at: expiresAt,
        action_id: actionId,
        action_name: action.name,
        action_input_json: input as never,
        action_correlation_id: ctx.correlationId,
        action_channel: ctx.channel,
      })
      .returning();

    if (!created) {
      throw new Error('Failed to create action approval row');
    }

    if (approvers.length > 0) {
      await tx.insert(requiredApprovers).values(
        approvers.map((userId) => ({
          tenant_id: tenantId,
          approval_id: created.id,
          user_id: userId,
          role: 'action_approver',
        })),
      );
    }

    return created;
  });

  // Fan-out to each required approver via stored channel preferences.
  const approvalForFanOut = approvalNotificationCopy(approval);

  for (const approverId of approvers) {
    notificationService
      .fanOutToUser(approvalForFanOut, approverId, 'approval', actionId)
      .catch((err) =>
        console.error(
          `[action-approvals] fanOutToUser(${approverId}) for action ${action.name} failed:`,
          err,
        ),
      );
  }
  // P1-TEAM-c (George 2026-10-15): "any member may approve" an agent action — so every
  // member is TOLD, exactly like every other approval (P1-TEAM-b). Told, not enrolled:
  // the roster above stays the one obligation, and the action runs as whoever approves
  // it (`resolvePendingAction`). Never throws; fire-and-forget like the loop above.
  void fanOutApprovalToTenantMembers({
    approval: approvalForFanOut,
    tenantId,
    alreadyNotified: approvers,
    actionId,
    context: 'action-approvals',
  });

  // `approvalId` is the id a human names in `approve <id>` (fr-agui SPEC §5.2 P).
  return { status: 'pending', actionId, approvalId: approval.id };
}

/**
 * Terminal refusal of a claimed (status `executing`) deferred action WITHOUT
 * running its handler: mark the row `failed`, record a `failed` delivery
 * carrying `error`, and notify the originator with an `action-error`. Shared by
 * the not-registered path and the archived-project refusal (fr#1502). The row
 * ends `failed`, so a re-emit never reaches the handler (non-retriable).
 */
async function failClaimedAction(p: {
  approval: typeof approvals.$inferSelect;
  actionId: string;
  actionName: string;
  channelName: string;
  userId: string;
  correlationId: string;
  error: string;
  text: string;
  meta: Record<string, unknown>;
}): Promise<void> {
  const { approval, actionId, actionName, channelName, userId, correlationId, error, text, meta } = p;
  // ⚠️ A swallowed WRITE, which is not the same defect as a swallowed read.
  // If this UPDATE fails the row stays `status:'executing'` FOREVER, while the
  // code below still inserts a `failed` delivery and notifies the originator —
  // so the person is told it failed and every reaper and dashboard sees an
  // action permanently in flight. Nothing consumed the result, so nothing
  // noticed.
  // The swallow is KEPT (the notify path must still run) but it is now
  // recorded, and `.returning` lets a zero-row match be seen: an UPDATE that
  // matched nothing "succeeds" just as quietly as one that threw.
  const failedUpdate = await db
    .update(approvals)
    .set({ status: 'failed' })
    .where(eq(approvals.id, approval.id))
    .returning({ id: approvals.id })
    .catch((err) => {
      reportSwallowedFailure(err, {
        service: 'fr-db',
        degradedTo: `approval ${approval.id} left in status:executing while the originator is told it failed`,
      });
      // ⛔ NOT `[]`. An empty array would also satisfy the zero-row test
      // below, emitting a SECOND report asserting the UPDATE "matched 0 rows"
      // — a cause that did not happen (it THREW; it never matched anything),
      // double-counting ONE failure in the ranking `alreadyReported` protects.
      // `null` is the sentinel for "never resolved", so the zero-row check is
      // reachable only when the UPDATE actually RESOLVED.
      return null;
    });
  if (failedUpdate !== null && failedUpdate.length === 0) {
    reportSwallowedFailure(
      new Error(`approvals UPDATE matched 0 rows for ${approval.id}`),
      {
        service: 'fr-db',
        degradedTo: `approval ${approval.id} not marked failed (0 rows matched)`,
      },
    );
  }
  await db
    .insert(engagementDeliveries)
    .values({
      engagement_id: approval.id,
      engagement_type: 'action',
      channel: channelName,
      recipient_user_id: userId,
      recipient_address: '',
      status: 'failed',
      error,
      action_id: actionId,
    })
    .catch((err) => {
      // ⚠️ A swallowed WRITE. Both sibling UPDATE swallows in this file are
      // already instrumented; this delivery insert was missed. The originator
      // IS told the action failed immediately below, so losing this row makes
      // the audit trail contradict the message the person actually received.
      reportSwallowedFailure(err, {
        service: 'fr-db',
        degradedTo: `approval ${approval.id} reads as never notified on ${channelName} that action ${actionName} failed (${error}), although the originator was told it failed`,
      });
    });
  await notifyOriginator(
    channelName,
    userId,
    {
      kind: 'action-error',
      correlationId,
      text,
      meta: { actionId, actionName, ...meta },
    },
    {
      approvalId: approval.id,
      actionId,
      actionName,
      correlationId,
      isApprovedExecuted: false,
      tenantId: approval.tenant_id,
    },
  );
}

/**
 * Called by the approvals domain when consensus flips terminal
 * (`approved` or `rejected`) for an approval row that has `action_id`
 * set. Approved → run handler under original ctx, log to
 * engagement_deliveries, notify originating channel. Rejected → notify
 * originating channel, do NOT run handler.
 *
 * Idempotent: if the approval row's action_id is null, or the action is
 * not registered, it warns and returns without throwing — the route
 * handler that calls this should not have its decision flow disrupted.
 *
 * State machine:
 *
 *   pending → approved → executing → done       (handler returned)
 *                                  → failed     (handler threw)
 *   pending → rejected                          (handler not invoked)
 *
 * The `approved → executing` transition is performed atomically via a
 * conditional UPDATE inside this function. If the UPDATE returns zero
 * rows, the transition has already been taken by a concurrent or prior
 * call — the handler is NOT invoked again. This guards against double
 * execution on operational replay, queue retries, and manual re-emits;
 * the route-layer optimistic lock only protects the `pending → approved`
 * transition.
 */
export interface ResolvePendingActionOptions {
  /**
   * P1-TEAM-c: the decider whose decision completed the approval — every decide seat
   * passes the id it just recorded. Absent (a re-emit / operator replay), it is read
   * from the approval's latest `approved` decision; when there is none the action is
   * refused, never run as the requester.
   */
  approverId?: string | null;
}

/** P1-TEAM-c refusal codes on the deferred path (carried on the failed delivery + metadata). */
export const APPROVER_UNRESOLVED = 'approver_unresolved';
export const APPROVER_NOT_PERMITTED = 'approver_not_permitted';

/**
 * WHO approved this action — the identity it runs as (P1-TEAM-c). The seat's own id
 * when given; otherwise the most recent `approved` decision on the row (ties broken by
 * id, so the answer never depends on heap order). `null` when nobody can be named.
 */
async function resolveExecutingApprover(
  approvalId: string,
  given: string | null | undefined,
): Promise<string | null> {
  if (typeof given === 'string' && given.length > 0) return given;
  const [latest] = await db
    .select({ approver_id: approvalDecisions.approver_id })
    .from(approvalDecisions)
    .where(and(eq(approvalDecisions.approval_id, approvalId), eq(approvalDecisions.decision, 'approved')))
    .orderBy(desc(approvalDecisions.decided_at), desc(approvalDecisions.id))
    .limit(1);
  return latest?.approver_id ?? null;
}

export async function resolvePendingAction(
  actionId: string,
  opts: ResolvePendingActionOptions = {},
): Promise<void> {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.action_id, actionId));

  if (!approval) {
    console.warn(`[action-approvals] resolvePendingAction: no approval row for action_id=${actionId}`);
    return;
  }

  const actionName = approval.action_name;
  const status = approval.status;
  const channelName = approval.action_channel ?? approval.source ?? 'web';
  const correlationId = approval.action_correlation_id ?? '';
  const projectId = approval.project_id;
  // The ORIGINATOR: the person whose agent asked. They are told the outcome on the
  // channel they asked on. They are NOT who the action runs as (P1-TEAM-c, below).
  const userId = approval.requester_id ?? '';
  const input = approval.action_input_json as unknown;

  const md = (approval.metadata as Record<string, unknown> | null) ?? {};
  const initiator =
    (md.initiator as ActionContext['initiator'] | undefined) ?? 'agent';
  const channelLinkedTenantId =
    typeof md.channel_linked_tenant_id === 'string' && md.channel_linked_tenant_id
      ? md.channel_linked_tenant_id
      : undefined;

  if (!actionName) {
    console.warn(`[action-approvals] approval ${approval.id} has action_id but no action_name`);
    return;
  }

  if (status === 'rejected') {
    await notifyOriginator(
      channelName,
      userId,
      {
        kind: 'action-result',
        correlationId,
        text: `Action ${actionName} was rejected`,
        meta: { actionId, actionName, outcome: 'rejected' },
      },
      {
        approvalId: approval.id,
        actionId,
        actionName,
        correlationId,
        isApprovedExecuted: false,
        tenantId: approval.tenant_id,
      },
    );
    return;
  }

  if (status !== 'approved') {
    console.warn(
      `[action-approvals] resolvePendingAction called for approval ${approval.id} but status=${status}; skipping`,
    );
    return;
  }

  // fr#1502: the project may have been ARCHIVED after this approval was minted
  // (requestActionApproval refuses the mint on an archived project, fr#1500,
  // but archive can land while the approval is pending). Re-read it with the
  // same tenant-scoped lookup the mint used. Read BEFORE the claim below so a
  // lookup error leaves the row `approved` and a re-emit can retry; the
  // refusal itself is applied only after the claim is won, so it is reported
  // exactly once. `archived` ONLY, mirroring assertProjectNotArchived.
  let archivedProjectError: AppError | null = null;
  if (projectId && isUuidShape(projectId)) {
    const [project] = await db
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(and(eq(projects.id, projectId), projectTaggedForTenant(approval.tenant_id)))
      .limit(1);
    if (project) {
      try {
        assertProjectNotArchived(project);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        archivedProjectError = err;
      }
    }
  }

  // ⭐ P1-TEAM-c (George 2026-10-15): "any member may approve, but the action then runs
  // under the APPROVER's identity, not the requester's". Read BEFORE the claim (like the
  // archive read above) so a lookup error leaves the row `approved` for a retry.
  const executorId = await resolveExecutingApprover(approval.id, opts.approverId);

  // Atomic guard against double execution: only proceed if we win the
  // approved → executing transition. A second invocation finds status
  // already 'executing' (or 'done'/'failed') and the UPDATE matches zero
  // rows, so we return without re-running the handler.
  const claimed = await db
    .update(approvals)
    .set({ status: 'executing' })
    .where(and(eq(approvals.id, approval.id), eq(approvals.status, 'approved')))
    .returning({ id: approvals.id });
  if (claimed.length === 0) {
    console.debug(
      `[action-approvals] resolvePendingAction: approval ${approval.id} already past 'approved' (likely re-emit); skipping handler`,
    );
    return;
  }

  const failClaimed = (error: string, text: string, meta: Record<string, unknown> = {}) =>
    failClaimedAction({ approval, actionId, actionName, channelName, userId, correlationId, error, text, meta });

  // Audit: who the action runs as, and who asked — on the approval row itself, so the
  // attribution survives whatever the handler does. Best-effort (reported), never
  // blocking: the decision rows already name the approver durably.
  const stampExecution = async (extra: Record<string, unknown> = {}) => {
    const stamp = {
      execution: {
        executed_as: executorId,
        requested_by: approval.requester_id ?? null,
        approved_by_requester: executorId !== null && executorId === approval.requester_id,
        ...extra,
      },
    };
    await db
      .update(approvals)
      .set({ metadata: sql`coalesce(${approvals.metadata}, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb` })
      .where(eq(approvals.id, approval.id))
      .catch((err) => {
        reportSwallowedFailure(err, {
          service: 'fr-db',
          degradedTo: `approval ${approval.id} carries no execution stamp (executed_as ${executorId})`,
        });
      });
  };

  if (archivedProjectError) {
    // Terminal and NON-retriable: the row goes executing → failed, so a
    // re-emit finds it past 'approved' and never reaches the handler.
    console.warn(
      `[action-approvals] approval ${approval.id}: project ${projectId} was archived after the mint; handler for ${actionName} NOT run`,
    );
    await failClaimed(
      archivedProjectError.message,
      `Action ${actionName} was not executed: its project was archived after approval was requested`,
      { outcome: PROJECT_ARCHIVED, retriable: false },
    );
    return;
  }

  const action = getAction(actionName);
  if (!action) {
    console.error(
      `[action-approvals] action ${actionName} no longer registered; cannot run deferred handler for approval ${approval.id}`,
    );
    await failClaimed(
      `action ${actionName} not registered at resolution time`,
      `Action ${actionName} could not be executed: not registered`,
    );
    return;
  }

  // ── P1-TEAM-c: THE ACTION RUNS AS THE APPROVER ────────────────────────────────────
  //
  // ⛔ FAIL CLOSED, NO FALLBACK. Nobody nameable approved it ⇒ nothing runs (a row
  // flipped to `approved` with no decision has no approver to run as, and running it as
  // the requester is exactly what the ruling forbids).
  if (!executorId) {
    await stampExecution({ refused: APPROVER_UNRESOLVED });
    await failClaimed(
      `${APPROVER_UNRESOLVED}: no approver could be named for this approval`,
      `Action ${actionName} was not executed: no approver could be identified, and it never runs as the requester`,
      { outcome: APPROVER_UNRESOLVED, retriable: false },
    );
    return;
  }

  const approvedByRequester = executorId === approval.requester_id;
  let executorRoles: string[] | undefined;
  // The approver's FRESH Keycloak home tenant (`approverActionPrincipal`): what the realm
  // `tenant_admin` arm of `workspace-admin` pins to, so a realm tenant_admin of THIS
  // tenant is admitted without a `user_roles` row, and one of another tenant is not.
  let executorTenantClaim: string | undefined;
  if (!approvedByRequester) {
    // A DIFFERENT member approved: their authority was never evaluated for this action
    // (the requester's was, at invoke time). Evaluate it now, fresh:
    //   1. current member of the approval's tenant AND homed in it (machine accounts are
    //      full members) — `approverActionPrincipal`, never the 60s list cache;
    //   2. THEIR rbac for this action (`assertRbac`, in the frame they will run in).
    // Either refusal fails the action with a clear reason. ⛔ It never falls back to
    // running as the requester.
    try {
      const principal = await approverActionPrincipal(executorId, approval.tenant_id);
      executorRoles = principal.roles;
      executorTenantClaim = principal.tenantClaim;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stampExecution({ refused: 'approver_not_tenant_member' });
      await failClaimed(
        message,
        `Action ${actionName} was not executed: the approver is not a current member of this workspace`,
        { outcome: 'approver_not_tenant_member', retriable: false, approverId: executorId },
      );
      return;
    }
  }

  const ctx: ActionContext = {
    // ⭐ The APPROVER (P1-TEAM-c). Equal to the requester for a self-approval, so that
    // path runs exactly as before.
    userId: executorId,
    requesterId: approval.requester_id ?? undefined,
    projectId,
    correlationId,
    initiator,
    channel: channelName,
    // The approval's own tenant (NOT NULL, migration 042): the tenant the
    // action was requested — and approved — in.
    tenantId: approval.tenant_id,
    ...(executorRoles ? { tenantRoles: executorRoles } : {}),
    ...(executorTenantClaim ? { tenantClaim: executorTenantClaim } : {}),
    ...(channelLinkedTenantId ? { channelLinkedTenantId } : {}),
  };

  const frame = {
    correlationId,
    initiator,
    channel: channelName,
    tenantId: approval.tenant_id,
    userId: executorId,
  };

  if (!approvedByRequester) {
    try {
      await withRequestContext(frame, () => assertRbac(action, ctx, input));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stampExecution({ refused: APPROVER_NOT_PERMITTED });
      await failClaimed(
        `${APPROVER_NOT_PERMITTED}: ${message}`,
        `Action ${actionName} was not executed: the approver is not permitted to perform it (${message})`,
        { outcome: APPROVER_NOT_PERMITTED, retriable: false, approverId: executorId },
      );
      return;
    }
  }
  await stampExecution();

  const spanAttrs = {
    kind: 'write' as const,
    initiator: ctx.initiator,
    channel: ctx.channel,
    projectId: ctx.projectId ?? undefined,
    userId: ctx.userId,
    requesterId: approval.requester_id ?? undefined,
    correlationId: ctx.correlationId,
    deferred: true,
    action_id: actionId,
  };

  let outputJson: Record<string, unknown> | null = null;
  let handlerResult: unknown = null;
  let runError: Error | null = null;
  try {
    // fr#1376: the deferred handler runs in a frame naming the APPROVAL's
    // tenant. Its callers (teams / telegram webhooks) authenticate
    // with a secret, so their request frame carries no tenant (Telegram
    // attributes one, Teams does not), and http-client reads the
    // outbound `X-Tenant-Id` from THIS frame — without it a deferred
    // procedures write went out tenantless.
    // P1-TEAM-c: the frame names the APPROVER as the acting user.
    const out = await withRequestContext(
      frame,
      () =>
        emitSpan(action.name, spanAttrs, async () => {
          return action.handler(input, ctx);
        }),
    );
    handlerResult = out;
    outputJson =
      out && typeof out === 'object'
        ? (out as Record<string, unknown>)
        : { value: out as unknown };
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
  }

  // Right-to-delete: a parked KAG sync-upload that just durably persisted PHI
  // to kag_graph must leave an fr `documents` row so the purge path can reach
  // it. P1-TEAM-c: the upload ran AS THE APPROVER, so the row is the APPROVER's
  // (the person the ingest was performed as — identical to the requester for a
  // self-approval); the ingest tenant is the approval's. Best-effort: a record
  // failure is logged, not raised — the handler already succeeded (the PHI is
  // written) and marking the action failed here would neither undo the ingest
  // nor create the row.
  if (!runError) {
    await maybeRecordParkedKagUpload(approval, actionName, input, handlerResult, executorId);
  }

  // Terminal transition: executing → done | failed.
  await db
    .update(approvals)
    .set({ status: runError ? 'failed' : 'done' })
    .where(eq(approvals.id, approval.id))
    .catch((err) => {
      // ⚠️ INSTRUMENTED 2026-09-07. This was a bare console.error and therefore a
      // SILENT swallow by this repo's definition: an outage here and a clean
      // terminal transition produced indistinguishable telemetry. Its twin ~100
      // lines above (the executing -> failed UPDATE) was already instrumented;
      // this one was missed.
      reportSwallowedFailure(err, {
        service: 'fr-db',
        degradedTo: `approval ${approval.id} left in status:executing after the handler reached its terminal ${runError ? 'failed' : 'done'} state`,
      });
      return [];
    });

  await db
    .insert(engagementDeliveries)
    .values({
      engagement_id: approval.id,
      engagement_type: 'action',
      channel: channelName,
      recipient_user_id: userId,
      recipient_address: '',
      status: runError ? 'failed' : 'sent',
      error: runError?.message,
      metadata_json: runError ? null : outputJson,
      action_id: actionId,
    })
    .catch((err) => {
      console.error(
        `[action-approvals] engagement_deliveries insert failed for action ${actionId}:`,
        err,
      );
    });

  const outcomeContext = {
    approvalId: approval.id,
    actionId,
    actionName,
    correlationId,
    isApprovedExecuted: !runError,
    tenantId: approval.tenant_id,
  };

  if (runError) {
    await notifyOriginator(
      channelName,
      userId,
      {
        kind: 'action-error',
        correlationId,
        text: `Action ${actionName} failed: ${runError.message}`,
        meta: { actionId, actionName, error: runError.message },
      },
      outcomeContext,
    );
  } else {
    await notifyOriginator(
      channelName,
      userId,
      {
        kind: 'action-result',
        correlationId,
        text: `Action ${actionName} completed`,
        meta: { actionId, actionName, outcome: 'approved', result: outputJson },
      },
      outcomeContext,
    );
  }
}

/**
 * Record the fr `documents` row for a parked KAG sync-upload that resolved
 * successfully — the parked twin of the inline recording in routes/tools/kag.ts
 * (`handleUploadDocumentSync`). Reads the uploader id + ingest tenant off the
 * approval row (both persisted at request time) and the filename / mime / size
 * + purge keys off the parked input and the handler result. No-op for any other
 * action, for `send_to_kag=false` (parse-only, no durable PHI), or for a
 * response carrying no purge key. Best-effort — never throws into the resolver.
 */
async function maybeRecordParkedKagUpload(
  approval: typeof approvals.$inferSelect,
  actionName: string,
  input: unknown,
  result: unknown,
  executorId: string,
): Promise<void> {
  if (actionName !== KAG_SYNC_UPLOAD_ACTION) return;
  const inp = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >;
  // Parse-only upload → no durable KAG footprint to purge.
  if (inp.send_to_kag === false) return;

  // The uploader — the identity the upload RAN AS (P1-TEAM-c: the approver, a real
  // fr user), so the delete path (scoped by user_id) can reach the row. Without it
  // we cannot attribute ownership; skip rather than mint an un-ownable row.
  const uploaderId = executorId;
  if (!uploaderId) {
    console.warn(
      `[action-approvals] parked KAG upload (approval ${approval.id}) has no executing user; cannot record a purgeable documents row`,
    );
    return;
  }

  const filename =
    typeof inp.filename === 'string' && inp.filename.length > 0
      ? inp.filename
      : 'document';
  const fileB64 = typeof inp.file_b64 === 'string' ? inp.file_b64 : '';
  const mimeType = typeof inp.content_type === 'string' ? inp.content_type : null;

  try {
    await recordSyncUploadRow({
      userId: uploaderId,
      // The ingest tenant, persisted NOT NULL on the approval (migration 042).
      tenantId: approval.tenant_id,
      filename,
      // The parked input carries only the base64 payload (the http handler's
      // exact byte_size was stripped by the action's zod schema), so estimate
      // the decoded size.
      fileSize: estimateBase64DecodedBytes(fileB64),
      mimeType,
      result,
    });
  } catch (err) {
    console.error(
      `[action-approvals] failed to record documents row for parked KAG upload (approval ${approval.id}, action ${actionName}):`,
      err,
    );
  }
}

interface OriginatorContext {
  approvalId: string;
  actionId: string;
  actionName: string;
  correlationId: string;
  /** True when delivery is the success notification for an approved action
   * that successfully executed. Drops here are operationally significant
   * and must be logged at error level. */
  isApprovedExecuted: boolean;
  /** The approval's tenant: a link pinned to another workspace is not replied to. */
  tenantId?: string | null;
}

async function recordDroppedDelivery(
  channelName: string,
  userId: string,
  ctxRec: OriginatorContext,
  reason: string,
): Promise<void> {
  await db
    .insert(engagementDeliveries)
    .values({
      engagement_id: ctxRec.approvalId,
      engagement_type: 'action',
      channel: channelName,
      recipient_user_id: userId,
      recipient_address: '',
      status: 'dropped',
      error: reason,
      action_id: ctxRec.actionId,
    })
    .catch((err) => {
      console.error(
        `[action-approvals] dropped engagement_deliveries insert failed for action ${ctxRec.actionId}:`,
        err,
      );
    });
}

async function notifyOriginator(
  channelName: string,
  userId: string,
  message: ChannelMessage,
  ctxRec: OriginatorContext,
): Promise<void> {
  const channel = notificationService.getChannel(channelName);
  if (!channel) {
    const reason = `originating channel ${channelName} not deliverable`;
    if (ctxRec.isApprovedExecuted) {
      console.error(
        `[action-approvals] APPROVED+EXECUTED action ${ctxRec.actionName} could not be delivered: channel '${channelName}' not registered (user ${userId})`,
      );
    } else {
      console.warn(
        `[action-approvals] originating channel '${channelName}' not registered; cannot deliver action outcome to user ${userId}`,
      );
    }
    await recordDroppedDelivery(channelName, userId, ctxRec, reason);
    return;
  }
  // We don't have a stable per-user address for channel `channelName` here —
  // the originating channel address is the user-facing identifier the
  // inbound webhook captured at request time. Until E-7 (inbound channels)
  // lands a thread/address registry, fall back to the user's first matching
  // pref for that channel; if none, deliver as user-id (websocket) or skip.
  let address = '';
  try {
    const { resolveRecipients } = await import('./channel-prefs');
    const recipients = await resolveRecipients(userId, ctxRec.tenantId);
    const match = recipients.find((r) => r.channel === channelName);
    if (match) address = match.address;
  } catch (err) {
    console.error('[action-approvals] resolveRecipients failed:', err);
  }
  if (!address) {
    // websocket manager broadcasts on user_id; other channels need address
    if (channelName === 'websocket') {
      address = userId;
    } else {
      const reason = `originating channel ${channelName} not deliverable`;
      if (ctxRec.isApprovedExecuted) {
        console.error(
          `[action-approvals] APPROVED+EXECUTED action ${ctxRec.actionName} could not be delivered: no address for user ${userId} on channel ${channelName}`,
        );
      } else {
        console.warn(
          `[action-approvals] no address for user ${userId} on channel ${channelName}; outcome dropped`,
        );
      }
      await recordDroppedDelivery(channelName, userId, ctxRec, reason);
      return;
    }
  }
  try {
    await channel.sendMessage(address, message);
  } catch (err) {
    console.error(
      `[action-approvals] channel.sendMessage failed for ${channelName}/${userId}:`,
      err,
    );
  }
}

// ---------- Stale-executing reaper ----------

export const STALE_EXECUTING_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Find approvals stuck in `status='executing'` past the threshold and mark
 * them `failed`. Runs on a startup interval — see server.ts. Protects against
 * Bun process kills mid-handler that would otherwise leave rows wedged.
 *
 * `resolvePendingAction` performs an atomic `approved → executing` claim and
 * then runs the registered handler. If the process is killed between the
 * claim and the terminal `executing → done|failed` transition, the row stays
 * `executing` forever and the originator is never notified. This reaper
 * is the recovery path: it detects rows whose `updated_at` is older than the
 * threshold (default 5 minutes) and flips them to `failed` with an error
 * message that records the cause (process restart).
 */
export async function reapStaleExecutingActions(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_EXECUTING_THRESHOLD_MS);
  const stale = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.status, 'executing'), lt(approvals.updated_at, cutoff)),
    );
  for (const row of stale) {
    // Defensive re-check: the SELECT WHERE filters at the DB, but a row
    // could in theory have been touched between scan and update. Skip
    // anything that isn't actually older than the threshold.
    const rowUpdatedAt =
      row.updated_at instanceof Date
        ? row.updated_at
        : new Date(row.updated_at as string | number);
    if (rowUpdatedAt >= cutoff) continue;
    await db
      .update(approvals)
      .set({
        status: 'failed',
        error_message:
          'reaped: stuck in executing past threshold (likely process restart)',
        updated_at: new Date(),
      })
      .where(eq(approvals.id, row.id));
    console.warn(
      `[action-approvals] reaped stale executing approval ${row.id} (action ${row.action_name})`,
    );
  }
}

// ---------- Self-approve (human self-service writes) ----------

/**
 * Should this write execute inline instead of parking for approval?
 *
 * True only for an action that opts in via `autoApproveForInitiator`, when a
 * HUMAN invokes it directly and is themselves the sole required approver. A
 * person performing their own self-service action (e.g. uploading a document
 * into KAG, running a scrape) has no one else to gate on — the approval would
 * only be them approving themselves, which is friction with zero governance
 * value. This resolves the documented `single-approver:initiator` "immediate
 * self-approve" intent for these actions.
 *
 * Deliberately narrow:
 *   - action did not opt in → false (every other write parks exactly as before;
 *     n8n / coding / channels / agui are untouched).
 *   - `initiator !== 'human'` → false. An agent / n8n / cron proposal still
 *     parks for human review — that is where the approval carries real value
 *     (e.g. an n8n workflow ingesting a document a human should vet first).
 *   - the sole approver is anyone other than the requester → false (a real
 *     multi-party gate stands).
 */
export async function shouldSelfApprove(
  action: AgentCallableAction,
  ctx: ActionContext,
): Promise<boolean> {
  if (ctx.initiator !== 'human') return false;
  // fr #1683: an agent member (fr's autonomous user over mcp) runs its own writes directly
  // when the policy names the initiator — there is no person behind it to confirm. A
  // policy naming anyone else still parks for them.
  if (!action.autoApproveForInitiator && !isAgentMemberId(ctx.userId)) return false;
  const { approvers, minRequired } = await resolveRequiredApprovers(
    action.approval,
    action,
    ctx,
  );
  return minRequired === 1 && approvers.length === 1 && approvers[0] === ctx.userId;
}

// ---------- Backend registration ----------

const backend: ApprovalBackend = {
  requestApproval: requestActionApproval,
  shouldSelfApprove,
};

setApprovalBackend(backend);
