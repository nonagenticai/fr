// src/routes/webhooks.ts
// Webhook receiver endpoints for n8n callbacks
import { assertProjectNotArchived } from '../lib/project-live-status';
import { db, queryClient, approvals, requiredApprovers, projects, departments, streams, workspaces } from '../db/client';
import { attributeRequestTo } from '../integrations/_lib/context';
import { tryCtxTenantId } from '../middleware/request-context';
import { DEBLOCK_ACTIONS } from '../domain/engagement/deblock-actions';
import { eq } from 'drizzle-orm';
import { jsonResponse, createdResponse } from '../utils/response';
import { BadRequestError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors';
import { assertCallbackUrlAllowed, attachApprovalCallbackUrl } from '../lib/approval-callback-url';
import {
  artifactRefBodyField,
  assertArtifactRefDedupeCompatible,
  assertArtifactRefInProject,
  parseArtifactRef,
} from '../lib/approval-artifact-ref';
import { z } from 'zod';
import {
  gateForPhase as catalogueGateForPhase,
  phases as cataloguePhases,
} from '../services/catalogue/tenant-catalogue';
import { notificationService, type ExecutionEvent } from '../domain/engagement/notifications';
import { fanOutApprovalToTenantMembers } from '../domain/engagement/tenant-member-fanout';
import { executionEventRecipients } from '../domain/engagement/tenant-member-event-recipients';
import {
  ExecutionEventTypeSchema,
  SeveritySchema,
  defaultSeverity,
} from '../domain/engagement/event-types';
import { validateWebhookSecret } from '../utils/webhook-secret';
import {
  licenceFieldForbidden,
  licenceParentBoard,
  licenceTenantMismatch,
  sameTenant,
  licenceOnly,
  assertLicencePrOnProjectRepo,
  type LicenceDoor,
} from '../lib/licence-door';
import {
  confirmPushDelivery,
  resolveApprover,
  resolveTriageVerdict,
  triageApproval,
} from '../domain/engagement/approval-routing';
import { canonicalTenantName } from '../middleware/internal-tenant-only';
import {
  classifyCardApprovalTenant,
  isRefusedCardApprovalTenant,
  recordCardApprovalTenantCheck,
} from '../lib/card-approval-tenant-check';
import { reportConveyorRefusal } from '../lib/conveyor-refusal-metrics';
import { isFixtureOrigin, SIGNOFF_BLOCK_REASONS } from '../lib/execution-signoff';
import { deadlineFromHours } from '../lib/approval-deadline';
import {
  describeSuppression,
  findOpenGateForCard,
  mintOneOpenGate,
} from '../domain/approvals/one-open-gate';
import { classifyUndecidableReason,
  rationaleOrAbsence, RATIONALE_PRODUCERS } from '../lib/approval-rationale';
import {
  classifyDeblockExit,
  deblockActionRequiredMessage,
  deblockDualExitMessage,
  irreconcilableDualExit,
} from '../domain/engagement/deblock-actions';
import { recordDeblockAction, recordDeblockDualExit } from '../lib/deblock-action-metrics';
import { handleGetAndonInternal } from './andon';
import { isUuidShape } from '../lib/uuid-shape';
import {
  BUG_FIX_AUTHORIZATION_MARKER,
  assertU3DedupeCompatible,
  resolveBugFixAuthorizationMint,
  resolveU3Mint,
} from '../services/approvals/u3-gates';
import { assertSameBugFixRequest, mintGateOnePerBugCard } from '../services/approvals/bug-fix-uniqueness';
// ⭐ fr#1208: the halt/proceed decision is NOT made in this file. It is made by
// `andonPermitsWork` in lib/global-andon-gate.ts, which is where
// ANDON_GATE_POLICY is stated once for every gate. This file owns only the wire
// codes it answers with.
import {
  andonPermitsWork,
  andonVerdictFromInterlockAnswer,
} from '../lib/global-andon-gate';
import {
  publishAndonStateForMetrics,
  reportAndonBrakeDecision,
  type AndonHaltOutcome,
} from '../lib/andon-halt-metrics';

// The shared-secret check now lives in utils/webhook-secret.ts (single
// fail-closed implementation for every receiver — an unset N8N_WEBHOOK_SECRET
// is a 401 in production, not a bypass). Re-exported here because
// routes/projects.ts and routes/execution-approvals.ts have always imported it
// from this module; keeping the name bound means no caller had to change.
export { validateWebhookSecret };

// Validation schemas for incoming n8n webhooks
export const N8nApprovalRequestSchema = z.object({
  fr_project_id: z.string().uuid(),
  card_id: z.string(),
  card_name: z.string(),
  reason: z.string(),
  /**
   * The concrete conditions this gate is asking about — the EVIDENCE an
   * approver answers against, not prose.
   *
   * ⚠️ fr was the blocker here, not the producer. Until now this schema had no
   * field for it at all, so n8n could not send `gate_terms` even if it wanted
   * to, AND the mint below hardcoded `metadata` to `{ card_name }`, so anything
   * sent would have been dropped. Meanwhile `workers/approval-redelivery.ts`
   * (#921) READS `metadata->'gate_terms'` to build its digest breakdown and
   * therefore always reports "(no gate_terms recorded)".
   *
   * MEASURED 2026-09-05: a full triage of the 274 approvals expiring 09-09/10
   * scored ALL 274 `insufficient_evidence` — zero decidable — precisely because
   * this key is absent. That is not missing data; it was unreachable by
   * construction.
   *
   * Optional on purpose: producers that do not send it keep working exactly as
   * before. This removes fr as the obstacle; it does not pretend the evidence
   * exists.
   */
  gate_terms: z.array(z.string().min(1)).optional(),
  callback_path: z.string(),
  required_approvers: z.array(z.object({
    user_id: z.string().uuid(),
    role: z.string().optional(),
  })).min(1),
  // ⛔ NO `.default(24)`. This one default is the whole origin of the 435 terminal expiries:
  // blocked-escalate.json :: Call FR never sent a deadline at all, so zod invented one for
  // every card-blocking approval n8n ever raised. Absent now means absent.
  deadline_hours: z.number().optional(),
});

/**
 * POST /api/webhooks/n8n/approval-request
 * n8n calls this when a card is moved to BLOCKED and needs approval.
 * Creates an approval record in FR and triggers notification fan-out.
 */
export async function handleN8nApprovalRequest(req: Request): Promise<Response> {
  validateWebhookSecret(req);
  const body = await req.json();
  const validated = N8nApprovalRequestSchema.parse(body);

  // Verify project exists and resolve its tenant via the project →
  // department → workspace chain. workspaces.id IS the tenant_id.
  const projectRows = await db
    .select({
      id: projects.id,
      owner_id: projects.owner_id,
      dept_id: projects.dept_id,
      tenant_id: departments.workspace_id,
      status: projects.status,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, validated.fr_project_id));
  const project = projectRows[0];

  if (!project) {
    throw new NotFoundError(`Project ${validated.fr_project_id} not found`);
  }
  // fr#1499: an approval on an ARCHIVED project is invisible (the approvals
  // project lane hides archived projects) — 409 project_archived, nothing minted.
  assertProjectNotArchived(project);

  if (!project.tenant_id) {
    // Migration 043 requires every approval row to carry tenant_id. A
    // project with no department (or whose department has no workspace)
    // cannot be tenant-scoped — fail loud rather than write a NULL.
    throw new ValidationError(
      `Project ${validated.fr_project_id} is not assigned to a department; cannot create tenant-scoped approval.`,
    );
  }

  // null unless the caller explicitly asked for a TTL — see lib/approval-deadline.ts.
  const expiresAt = deadlineFromHours(validated.deadline_hours);

  // ⚠️ THE THIRD DOOR. fr#1000 named two minters; this endpoint
  // (POST /api/webhooks/n8n/approval-request) is a third, and it never had the
  // one-open-gate rule at all — it read nothing and inserted unconditionally.
  // Migration 114's unique index makes that a 23505 rather than a duplicate, so
  // leaving it alone would have traded silent double-paging for a 500 on this
  // path. It goes through the same arbiter as its two siblings.
  const gateValues: typeof approvals.$inferInsert = {
    tenant_id: project.tenant_id,
    project_id: validated.fr_project_id,
    requester_id: project.owner_id,
    description: `[n8n] ${validated.card_name}: ${validated.reason}`,
    callback_path: validated.callback_path,
    card_id: validated.card_id,
    source: 'n8n',
    metadata: {
      card_name: validated.card_name,
      // Persist the gate's terms when the producer sends them. Spread so an
      // absent value leaves metadata byte-identical to before — the digest in
      // `workers/approval-redelivery.ts` already handles the empty case and
      // must keep doing so for the rows minted before this landed.
      ...(validated.gate_terms?.length ? { gate_terms: validated.gate_terms } : {}),
    },
    status: 'pending',
    expires_at: expiresAt,
  };

  const { gate: approval, deduplicated: gateWasDeduplicated } = await mintOneOpenGate({
    tenantId: project.tenant_id,
    cardId: validated.card_id,
    values: gateValues,
  });
  if (gateWasDeduplicated && validated.card_id) {
    // This door mints no G-12 kind: it may never be handed an open G-12 gate as its own.
    assertU3DedupeCompatible(null, approval);
    // 200, not 201: nothing was created. Keeps THIS route's envelope (the created
    // path answers approval_id/project_id/status/expires_at) so a caller reading
    // any of those keeps working, with `deduplicated` beside it to tell them apart.
    console.warn(describeSuppression('webhooks', validated.card_id, approval));
    return jsonResponse({
      approval_id: approval.id,
      project_id: validated.fr_project_id,
      status: approval.status,
      expires_at: approval.expires_at?.toISOString() ?? null,
      deduplicated: true,
    });
  }

  if (!approval) {
    throw new Error('Failed to create approval');
  }

  // Add required approvers
  await db.insert(requiredApprovers).values(
    validated.required_approvers.map(approver => ({
      tenant_id: project.tenant_id as string,
      approval_id: approval.id,
      user_id: approver.user_id,
      role: approver.role,
    }))
  );

  // Fan-out: ws broadcast for live badges + per-user resolution for each approver
  notificationService
    .fanOut({ ...approval, metadata: null }, [{ channel: 'websocket', address: 'broadcast' }])
    .catch((err) => console.error('[webhooks] ws fan-out error:', err));

  for (const approver of validated.required_approvers) {
    notificationService
      .fanOutToUser({ ...approval, metadata: null }, approver.user_id, 'approval')
      .catch((err) => console.error('[webhooks] per-user fan-out error:', err));
  }

  // P1-TEAM-b (George 2026-10-15): every member of the approval's tenant is told —
  // told, not enrolled; the roster above stays the quorum. Never throws.
  await fanOutApprovalToTenantMembers({
    approval: { ...approval, metadata: null },
    tenantId: project.tenant_id,
    alreadyNotified: validated.required_approvers.map((a) => a.user_id),
    context: 'webhooks',
  });

  console.log(`[webhooks] Created approval ${approval.id} from n8n for project ${validated.fr_project_id}`);

  return createdResponse({
    approval_id: approval.id,
    project_id: validated.fr_project_id,
    status: 'pending',
    // null is the honest answer for a card-blocking approval, not an error.
    expires_at: expiresAt?.toISOString() ?? null,
  });
}

// WS1 Phase 1A — non-approval project-execution events (card lifecycle, PR
// activity, outcome signals). The n8n AA pipeline POSTs one of these at each
// lifecycle point; fr writes a durable inbox row per recipient and fans out to
// each user's chosen external channels per the (event_type × channel) matrix.
// Approvals keep their own endpoint — this path never creates approvals.
const N8nExecutionEventSchema = z.object({
  event_type: ExecutionEventTypeSchema,
  project_id: z.string().uuid(),
  // Optional explicit tenant; otherwise derived from the project's department.
  tenant_id: z.string().uuid().optional(),
  card_id: z.string().optional(),
  execution_id: z.string().optional(),
  title: z.string().min(1).max(512),
  message: z.string().max(4000).optional(),
  severity: SeveritySchema.optional(),
  link: z.string().max(2048).optional(),
  correlation_id: z.string().optional(),
  // Explicit recipients — ADDED to every member of the project's tenant (P1-TEAM-b);
  // an id that is not a member of that tenant is dropped, never notified.
  recipient_user_ids: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * POST /api/webhooks/n8n/execution-event
 * The AA pipeline reports a non-approval lifecycle/outcome event. Resolves the
 * project's tenant (project → department → workspace) and recipients (EVERY member
 * of that tenant plus explicitly named members — P1-TEAM-b; never the owner alone,
 * never a non-member), writes a durable inbox row per recipient, and
 * fans out to their configured channels. Notification delivery is telemetry —
 * the dispatch never throws — but the inbox row is awaited so the row exists by
 * the time we respond.
 */
export async function handleN8nExecutionEvent(req: Request): Promise<Response> {
  validateWebhookSecret(req);
  const body = await req.json();
  const v = N8nExecutionEventSchema.parse(body);

  const projectRows = await db
    .select({
      owner_id: projects.owner_id,
      tenant_id: departments.workspace_id,
      project_data: projects.project_data,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, v.project_id));
  const project = projectRows[0];
  if (!project) {
    // ⭐ THE REFUSAL IS CORRECT AND THE REFUSAL WAS INVISIBLE. Both halves.
    //
    // This lookup is NOT tenant-scoped — `where(eq(projects.id, …))` and nothing
    // else — so a miss here is not a scoping mismatch and not a race with a
    // committed row's visibility: there is no such `projects` row, under any
    // tenant. fr is right to refuse.
    //
    // MEASURED 2026-09-10 in the prod pod log: the ids being refused include
    // `0195f48b-d000-7000-8000-000000000004`, which is not a missing project at
    // all — it is the `prompt-improvement` WORKSPACE id (migration 062;
    // middleware/internal-tenant-only.ts). A workspace id can never match a
    // `projects` row, so this event was structurally unanswerable and would have
    // 404'd forever. `canonicalTenantName` makes the refusal SAY that, because
    // "Project <uuid> not found" reads as a deleted row and sent four separate
    // readers looking for one.
    //
    // ⛔ The producer fix is NOT here. n8n is naming the wrong entity kind (or
    // has no project to name, for a stream-scoped improvement card — this schema
    // makes `project_id` REQUIRED, so such an event cannot be expressed without
    // putting something untrue in the field). Papering over it by resolving a
    // tenant id to "some project in that tenant" would invent an association fr
    // was never given. The refusal stands; it is now diagnosable and counted.
    const tenantName = canonicalTenantName(v.project_id);
    reportConveyorRefusal({
      surface: 'n8n_execution_event',
      reason: tenantName ? 'project_id_is_tenant_id' : 'project_not_found',
      subject_id: v.project_id,
      detail: {
        event_type: v.event_type,
        card_id: v.card_id ?? null,
        execution_id: v.execution_id ?? null,
        correlation_id: v.correlation_id ?? null,
        ...(tenantName ? { tenant_name: tenantName } : {}),
      },
    });
    throw new NotFoundError(
      tenantName
        ? `Project ${v.project_id} not found: that id is the '${tenantName}' TENANT (workspace), not a project. Send the fr project id in project_id.`
        : `Project ${v.project_id} not found`,
    );
  }

  // This used to claim it mirrored the approval path while implementing only
  // the two steps that always fail. It now actually shares that path's rule —
  // see `tenantFromProjectRow`. departments = 0 estate-wide, so the department
  // arm resolved nothing and every execution-event from n8n was refused; 228 of
  // 246 projects carry the stamped tenant this now reads.
  const tenantId =
    v.tenant_id ?? tenantFromProjectRow(project.tenant_id, project.project_data);
  // Publish it to the request context so the metering span carries it — see
  // `meterToResolvedTenant`. Before the `if (!tenantId)` guard on purpose: the
  // guard THROWS, and a thrown request is still metered (usage-spans catches,
  // records, re-throws). A refusal we can attribute is worth more than one we
  // cannot.
  meterToResolvedTenant(tenantId);
  if (!tenantId) {
    // Still fails loud, deliberately. n8n has no tenant in scope to send, so if
    // neither the department nor the stamped tenant resolves there is nothing
    // truthful to attribute this to — and a tenantless notification would be
    // routed to whoever the nil tenant happens to reach.
    throw new ValidationError(
      `Project ${v.project_id} has no resolvable tenant (no department, no stamped keycloak_tenant_id); cannot route a tenant-scoped notification.`,
    );
  }

  // P1-TEAM-b (George 2026-10-15): "all notifications … are sent to all members". This
  // used to be the explicit list, else the project OWNER only. Now: every member of the
  // project's tenant, plus any explicitly named id that IS a member. ⛔ An explicit id
  // outside the tenant is DROPPED (and reported) — the webhook secret is shared by every
  // n8n producer, so a named recipient is an assertion, not a fact, and nothing may
  // reach another tenant's members.
  const { recipientIds } = await executionEventRecipients({
    tenantId,
    explicitUserIds: v.recipient_user_ids ?? [],
    context: `execution-event ${v.event_type} project ${v.project_id}`,
  });

  const event: ExecutionEvent = {
    event_type: v.event_type,
    tenant_id: tenantId,
    severity: v.severity ?? defaultSeverity(v.event_type),
    title: v.title,
    body: v.message ?? null,
    link: v.link ?? null,
    project_id: v.project_id,
    card_id: v.card_id ?? null,
    execution_id: v.execution_id ?? null,
    source: 'n8n',
    correlation_id: v.correlation_id ?? null,
    metadata: v.metadata ?? null,
  };

  // Await so the inbox rows exist on return; each call is internally
  // fail-safe (never throws), so one bad recipient can't sink the rest.
  await Promise.allSettled(
    recipientIds.map((uid) => notificationService.fanOutEventToUser(event, uid)),
  );

  console.log(
    `[webhooks] execution-event ${v.event_type} for project ${v.project_id} → ${recipientIds.length} recipient(s)`,
  );

  // ⛔ No phase write here (George 2026-10-13): n8n is the ONLY writer of a
  // project's phase, via PATCH /api/projects/:id/phase. card.done only notifies.

  return createdResponse({ notified: recipientIds.length });
}

// Simpler schema for n8n card-approval — no fr_project_id or required_approvers needed.
// Migration 043 made tenant_id NOT NULL on approvals, so we now require enough
// information to resolve a tenant: either an explicit `tenant_id`, or a
// `boardId` that maps to a known project's planka_board_id (project chain) or
// a stream's planka_board_id (improvement-stream boards).
export const N8nCardApprovalSchema = z.object({
  card_id: z.string(),
  card_name: z.string(),
  reason: z.string(),
  callback_path: z.string().default('kanban/approval-callback'),
  /**
   * D17 — the n8n Wait node's `$execution.resumeUrl`. Optional. Validated against
   * N8N_CALLBACK_ORIGINS (422 `callback_url_not_allowed`, lib/approval-callback-url.ts);
   * when present the decision is POSTed to it exactly as given and the row stores
   * `callback_path` NULL. ⛔ A capability — never logged in full.
   */
  callback_url: z.string().optional(),
  /**
   * D13 — the ONE artifact this approval is about: `{artifact_id: uuid, version?: int >= 1}`
   * or null. 422 `artifact_ref_invalid` when malformed, 422 `artifact_ref_not_found` when it
   * is not an artifact of the approval's resolved project (lib/approval-artifact-ref.ts).
   */
  artifact_ref: artifactRefBodyField,
  recipient: z.string().optional(),          // producer metadata: phone override (stored, no transport)
  doingListId: z.string().optional(),
  todoListId: z.string().optional(),
  boardId: z.string().optional(),
  /**
   * Explicit tenant id from n8n. Optional — if absent, the handler tries
   * to derive the tenant from `boardId` via the planka_board_id chain.
   */
  tenant_id: z.string().uuid().optional(),
  /**
   * Explicit fr project id. Optional — if absent, the handler resolves it from
   * `boardId` via `projects.planka_board_id`. Persisting it links the approval
   * to its project so it surfaces in `GET /api/projects/:id/approvals`
   * (previously these n8n card-approvals were stored project_id-null and never
   * appeared in the project's list).
   */
  project_id: z.string().uuid().optional(),
  /**
   * Legacy phase marker. Approving NO LONGER advances any phase from it
   * (deleted, fr#1481; n8n is the only phase writer, George 2026-10-13).
   * Still accepted so the deblock classifier can put the row in its
   * `phase_advance` lane and refuse a dual exit. Validated against the phase
   * spine at the boundary; a garbage value is dropped.
   */
  advance_phase_on_approve: z.string().optional(),
  /**
   * Hours until the approval expires. OMITTED OR NULL MEANS NO DEADLINE, which is the
   * correct default for a card-blocking approval: BLOCKED is the human-input gate, so the
   * card waits until a human answers. The previous `.default(24)` was the entire provenance
   * of 435 expiries — `blocked-escalate.json :: Call FR` never sent this field at all, and
   * no AA specification document mentions expiry. A caller that genuinely wants a deadline
   * still gets one by sending a number.
   */
  deadline_hours: z.number().nullable().optional(),
  /**
   * The human this approval is addressed to. Optional: when absent fr resolves one
   * (workspace-admin, then project owner) and REFUSES to create the approval if no
   * reachable human exists. This is also the field a future triage worker writes
   * through once it decides who should see a request.
   */
  approver_user_id: z.string().optional(),
  /**
   * BLOCKED-exit proposition (2026-08-24). `AA Pattern - Blocked Escalate` classifies the
   * block AT BLOCK TIME — the only moment the evidence still exists, since `phase_journey`
   * records only from/to lists and timestamps — and proposes what should happen to the card.
   * The human approves or rejects the PROPOSITION; the callback then executes the action.
   *
   * Both this schema and `buildCallbackPayload` are closed allowlists, so a key must be
   * added in BOTH places or it is silently dropped on the way back out. Precedent:
   * canary_action, list, additional_minutes.
   */
  deblock_action: z
    .enum(DEBLOCK_ACTIONS)
    .optional(),
  /**
   * The improvement card this block was converted into — the LEARNING half of the
   * proposition. Carried through so the callback can relate the two cards rather than
   * re-deriving the link from prose.
   */
  learning_card_id: z.string().max(256).optional(),
  /**
   * The pull request a MERGE proposition is about (2026-08-31).
   *
   * ⛔ WITHOUT THIS, A MERGE APPROVAL IS UNANSWERABLE. "Should this be merged?" is not a
   * question anyone can answer without knowing WHAT — and the alternative, re-deriving the PR
   * from the card at decision time, is exactly the shape that made 108 of 151 approvals
   * `do_not_decide`: a proposition whose evidence lives somewhere else and may have moved.
   *
   * It rides in the existing free-form `metadata` jsonb, so this needs no migration — the same
   * way boardId and learning_card_id already do. Bounded because a card custom field is capped
   * at ~460 characters upstream and an over-long value fails the whole write.
   */
  pr_url: z.string().max(512).optional(),
  pr_repo_owner: z.string().max(128).optional(),
  pr_repo_name: z.string().max(128).optional(),
  pr_number: z.number().int().positive().optional(),
  /**
   * ⛔ THE APPROVER-FACING RATIONALE. Measured on prod 2026-09-03 06:52 UTC:
   * of 971 PENDING `generic` approvals, 970 carried an empty `change_summary` and
   * 971 an empty `impact_analysis`. 970 of those 971 are `source='n8n'`, minted by
   * THIS route.
   *
   * NOT 971 of 971, and the exception matters: `aa11a001-0000-7aa1-8aa1-
   * 000000000a01` is `source='web'` from the human path in `routes/approvals.ts`
   * and carries real prose. An earlier version of this comment said "961 of 961,
   * every one minted by this route" — a universal that is false and that would
   * have stopped the next reader from looking for the row that breaks it.
   *
   * The cause was not an emitter that stayed quiet. It was that this schema is a
   * closed `z.object()` which never listed these two keys, and the insert below
   * never wrote them: a producer that DID send a rationale got a 201 and fr threw
   * it away, because `z.object()` strips unknown keys silently. The columns have
   * existed and been nullable the whole time. Same shape, same route family, as
   * the 262-of-262 defect the sibling `POST /api/execution/approvals` already
   * closed (see `createExecutionApprovalSchema`) — and the caps match it, so a
   * producer cannot get a rationale through one door and rejected at the other.
   *
   * Over-long is REJECTED, never truncated: a summary cut mid-sentence still reads
   * as complete reasoning to the human deciding on it.
   *
   * The 4000 cap is deliberately LEFT AS IT IS. It matches the named sibling
   * (`createExecutionApprovalSchema`), and it is nowhere near binding: measured
   * 2026-09-03 06:52 UTC, the longest `change_summary` in the whole prod table is
   * 911 characters and the longest `impact_analysis` is 926, across 301 and 300
   * non-empty rows respectively. Nothing has ever come close, so the cap costs a
   * producer nothing today and reject-not-truncate is the right failure direction
   * if one ever does.
   */
  change_summary: z.string().max(4000).optional(),
  impact_analysis: z.string().max(4000).optional(),
  /**
   * ⛔ ADDED 2026-09-04 — WITHOUT THIS, THE CONTRACT GATE COULD NEVER ADVANCE.
   *
   * `n8n-callback.ts` reads the card type off approval metadata in two places:
   *   (deleted, fr#1481) the approval-completion phase advance read `meta.card_type`
   *   `buildCallbackPayload:98`       — emits `card_type: str(metadata.card_type)`
   * This schema had no such field and the insert below did not write one, so every
   * approval minted through THIS route carried `card_type: undefined`: the gate
   * advance was unreachable and the outbound callback shipped the key as undefined.
   *
   * The producer has always had the value — `workflows/patterns/blocked-escalate.json`
   * derives it in `Build Notification` (`input.card_type || 'unknown'`) and uses it in
   * six places in `Build Proposition` — but `Call FR`'s jsonBody never sent it, because
   * there was nothing here to send it to. A contract cannot be satisfied by a producer
   * when the consumer declares no field for it.
   *
   * The sibling route already does this correctly and is the model followed here:
   * `execution-approvals.ts:162-168` declares `card_type: z.string().optional()`.
   *
   * ⚠️ Deliberately an explicit optional field rather than making the metadata
   * `.passthrough()`. This route's insert is a documented allowlist ("Spread
   * individually rather than as one object: an absent field must be ABSENT from the
   * jsonb"), and passthrough would accept arbitrary unvalidated keys — a loosening of
   * validation, not a fix for a missing one.
   */
  card_type: z.string().max(200).optional(),
  /**
   * ⛔ ADDED 2026-09-06 — WITHOUT THIS, 83% OF THE PENDING QUEUE IS UNANSWERABLE.
   *
   * `claude-fleet/scripts/lib/approvals-predicate.py` classifies a pending approval
   * from `metadata.gate_terms` and NOTHING ELSE at its first branch: a row with no
   * terms returns `insufficient_evidence` before card_type, deblock_action or the
   * description are ever read. MEASURED 2026-09-06: 1,281 pending, only 14 genuinely
   * awaiting a human, and 1,058 (83%) minted through THIS route with no terms at all.
   * `workers/approval-redelivery.ts` reads the same key for its digest breakdown and
   * therefore prints "(no gate_terms recorded)" for every one of them.
   *
   * ⚠️ fr was HALF the blocker, exactly as with `card_type` and the rationale pair
   * above. The producer had the value — `blocked-escalate.json :: Build Proposition`
   * has computed `block_reason_class` since it landed — but this closed `z.object()`
   * declared no field for it, so a producer that sent terms would have got a 201 and
   * had them silently stripped. Both halves land together: the n8n side now derives
   * `gate_terms` from that class and `Call FR` sends it.
   *
   * The SIBLING DOOR already does exactly this — `N8nApprovalRequestSchema` above
   * declares `gate_terms: z.array(z.string().min(1)).optional()` and spreads it into
   * metadata the same way. Mirrored verbatim, caps included (i.e. none), so a producer
   * cannot get terms through one door and be rejected at the other — the same
   * cross-door argument the `change_summary` cap makes.
   *
   * fr does NOT validate the term VOCABULARY. The closed set lives in the predicate
   * (DEFECT_TERMS / BENIGN_TERM / open_questions) and an enum here would be a third
   * hand-maintained copy of it that fails on the wrong side of the wire: a producer
   * emitting a term fr has not heard of should reach the predicate and be reported as
   * "unrecognised", not 400 at the door and strand the card in BLOCKED with no gate.
   */
  gate_terms: z.array(z.string().min(1)).optional(),
  /**
   * ⛔ ADDED 2026-09-10 — THE QUESTION ITSELF NEVER ARRIVED, SO NOBODY COULD ANSWER IT.
   *
   * MEASURED 2026-09-10: of 99 live `open_questions` approvals, 84 appear to carry an
   * EMPTY question array. ⚠️ They do not. The array is not empty — THE KEY IS ABSENT,
   * and those are two different findings that a reader of the row cannot tell apart.
   * `grep -r open_questions backend/src/` returned exactly ONE hit before this change,
   * and it was a COMMENT (the note on `gate_terms` above, listing the predicate's own
   * vocabulary). fr declared no field, so a producer that sent the questions got a 201
   * and had them silently stripped by `z.object()` — the identical shape as the
   * `card_type`, `gate_terms` and rationale-pair defects documented above, and the
   * fourth recurrence of it on this one schema.
   *
   * ⛔ AND THE CONSEQUENCE IS A CARD HELD FOREVER, NOT A COSMETIC GAP. With no question
   * stated, neither a human nor a Claude approval seat can answer the row; an approved
   * QUESTION carrying no answer text is DELIBERATELY held in BLOCKED by `AA Pattern -
   * Approval Callback :: Resolve Target List` (`questionAnswered` requires non-empty
   * comment text), and the approval is then SPENT — fr accepts no second decision on a
   * decided row — so the card can never be released through it. The de-block worker's
   * `hold_acknowledged` terminal (migration 119) makes that hold VISIBLE; this field is
   * the half that makes it ANSWERABLE.
   *
   * ⚠️ BOTH BOUNDS ARE DELIBERATE AND THEY BOUND DIFFERENT THINGS. The per-string 4000
   * matches `change_summary` / `impact_analysis` above, for that comment's own
   * cross-door argument. The ARRAY length is capped separately because an unbounded
   * array from a workflow is a payload-size problem no per-element cap can express: 200
   * questions of 4000 characters is a 780 KB metadata jsonb on a row the approvals page
   * renders. 50 is far above anything observed (the largest live question set is a
   * single-digit count) and far below anything that hurts.
   *
   * ⛔ NOT `.passthrough()`, FOR THE REASON THE `card_type` NOTE GIVES. The closed
   * `z.object()` is a documented security property — the insert below is an explicit
   * allowlist — and opening it would accept arbitrary unvalidated keys. Two named
   * fields respect that; passthrough replaces a missing validation with none.
   *
   * ⛔ NO VOCABULARY VALIDATION, same argument as `gate_terms`: these are free-form
   * human questions, and the only correct failure direction for an unexpected one is
   * "reaches the decider and reads oddly", never "400 at the door and the card stays
   * blocked with no question at all".
   */
  open_questions: z.array(z.string().min(1).max(4000)).max(50).optional(),
  /**
   * The WHY behind the ask, in the producer's own words. Same defect, same door, same
   * idiom, and it travels with `open_questions` because a question without its reasoning
   * is answerable only by someone who already knows the context — which is precisely the
   * class of row that sits unanswered.
   *
   * ⚠️ THIS USED TO SAY "DISTINCT FROM `triage_rationale`, WHICH IS fr's OWN … written by
   * this route's triage step". As of 2026-09-23 there is no longer anything to be distinct
   * FROM: the four `triage_*` columns were write-only and this route stopped writing them
   * (see the block at the `gateValues` insert). The rule the sentence protected still binds
   * and is now unconditional — this field is the PRODUCER's reasoning for raising the ask,
   * and fr must never put its own routing note here, because a note in this field is read by
   * an approver as the requester's justification.
   */
  rationale: z.string().max(4000).optional(),
  /**
   * ⚠️ ADDED 2026-10-01 for the ncn#1956 coordinator tripwire, which counts PENDING
   * approvals by block class after the conveyor relift. ncn's `AA Pattern - Blocked
   * Escalate :: Build Proposition` already computes `block_reason_class` (a closed,
   * lowercase snake_case set: `upstream_run_failure`, `infrastructure`, `open_questions`,
   * …, with an honest `unknown_*`), but fr declared no field for it — so even a producer
   * that sent it would get a 201 and have it stripped by `z.object()`: the fifth
   * recurrence of the `card_type` / `gate_terms` / rationale-pair defect on this schema.
   *
   * ⚠️ AS OF ncn origin/main 2026-10-01 `Call FR` does NOT send it as a body key — the
   * class reaches fr only inside the `impact_analysis` FALLBACK string ("BLOCK CLASS: …"),
   * which Build Proposition's own impact_analysis normally overrides. This field is the fr
   * half; it stays inert until `Call FR` adds `block_reason_class: $json.block_reason_class`.
   *
   * ⛔ NOT `.passthrough()`, for the reason the `card_type` note gives. ⛔ NO VOCABULARY
   * VALIDATION, for the reason the `gate_terms` note gives: an unheard-of class must reach
   * the tripwire and be counted, never 400 at the door and strand the card with no gate.
   * The value is NORMALISED (trimmed, lowercased) rather than shape-refused for the same
   * failure-direction reason; an all-whitespace value collapses to absent at the insert.
   */
  block_reason_class: z.string().trim().toLowerCase().max(100).optional(),
  /**
   * COVERAGE (George BDD ruling 2026-10-01). ncn's `Call FR` sends R3's coverage request as
   * `metadata: { coverage_request }` (AA-TRACE §6.14). Without this key `z.object()` strips it
   * and every COVERAGE row is undecidable (`coverage_request_missing`). Only `coverage_request`
   * is read from `metadata` — this is not a passthrough. ⚠️ `.catch(undefined)`: a malformed
   * request is DROPPED rather than 400ing the mint, for the `gate_terms` failure-direction
   * reason; the decide seam then refuses the row loudly instead of stranding the card here.
   */
  metadata: z
    .object({
      coverage_request: z
        .object({
          criteria: z
            .array(
              z.object({
                criterion_id: z.string().min(1).max(200),
                text: z.string().max(4000).nullish(),
                scenario_id: z.string().max(200).nullish(),
                scenario_gherkin: z.string().max(20000).nullish(),
                computed: z.unknown().optional(),
                reason_not_computed: z.string().max(2000).nullish(),
              }),
            )
            .min(1)
            .max(200),
          artifacts: z
            .array(
              z.object({
                kind: z.string().max(100).nullish(),
                ref: z.string().max(2000),
                sha: z.string().max(100).nullish(),
              }),
            )
            .max(50)
            .nullish(),
          card_id: z.string().max(256).nullish(),
          card_type: z.string().max(200).nullish(),
          qa_head_sha: z.string().max(100).nullish(),
          commit_sha: z.string().max(100).nullish(),
          pr_url: z.string().max(2000).nullish(),
          test_summary: z.unknown().optional(),
        })
        .optional()
        .catch(undefined),
      /**
       * The bug-fix authorization gate marker (`'bug_fix_authorization'`). Blocked-escalate
       * rows minted on a `decision_development` card are the live bug-fix gate (measured
       * 2026-10-01: in 30d the only human rows on those cards were these generic rows), and
       * `isBugFixAuthorizationRow` (deblock-actions) keys the web-only refusal on this key —
       * so it must be PERSISTED, not stripped by `z.object()`. Normalised and bounded; a
       * malformed value is dropped (`.catch`), never a 400 that strands the card.
       */
      approval_kind: z.string().trim().min(1).max(100).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/**
 * Resolve the tenant for a card-approval webhook.
 *
 * Priority:
 *   1. Explicit `tenant_id` supplied by n8n.
 *   2. `boardId` → projects.planka_board_id → departments.workspace_id
 *      (project-scoped Planka boards).
 *   3. `boardId` → streams.planka_board_id → streams.tenant_id
 *      (improvement-stream Planka boards — internal tenants).
 *
 * Returns null when no tenant can be resolved; the caller fails loud
 * instead of writing a tenantless approval (migration 043 requires
 * approvals.tenant_id NOT NULL). Mirrors migration 043 Pass B + Pass C.
 */
/**
 * Derive a project's tenant: department first, then the tenant stamped on the
 * row at create time.
 *
 * ONE OWNER for a rule that was previously implemented once and *documented* as
 * mirrored twice more. `routes/projects.ts` (~:426) states it: projects are not
 * department-assigned (`dept_id` stays null), so the dept -> workspace chain
 * cannot recover tenant scope downstream, and `project_data.keycloak_tenant_id`
 * is the authoritative tenant. `resolveCardApprovalTenant` was fixed to honour
 * that; `handleN8nExecutionEvent` was not — its comment even claimed to "mirror
 * the approval path" while implementing only the two steps that always fail.
 *
 * MEASURED on prod 2026-09-04: departments = 0, projects = 246, projects with a
 * non-null dept_id = 0. So the department arm resolves NOTHING, estate-wide.
 * 228 of those 246 carry `project_data.keycloak_tenant_id`, and all 228 join to
 * a real `workspaces.id`.
 *
 * Fails closed: a project with neither returns null and the caller refuses,
 * rather than inventing a default tenant. n8n cannot supply one — neither active
 * workflow that posts execution-events has a tenant anywhere in scope — so the
 * resolution has to happen here or not at all.
 */
export function tenantFromProjectRow(
  departmentTenantId: string | null | undefined,
  projectData: unknown,
): string | null {
  if (departmentTenantId) return departmentTenantId;
  const stamped = (
    projectData as { keycloak_tenant_id?: string } | null | undefined
  )?.keycloak_tenant_id;
  // `|| null`, not `?? null`: an empty string is not a tenant, and returning ''
  // would satisfy a caller testing `!== null` while being unusable. Callers here
  // happen to use a falsy check, but the contract says null and must mean it.
  return stamped || null;
}

/**
 * fr row 14d-2 — the REFERENCE tenant an explicit card-approval `tenant_id` is
 * compared against: the project's tag (`project_data->>'keycloak_tenant_id'`),
 * else the board's tenant (`resolveCardApprovalTenant(undefined, boardId)` —
 * board → project dept/tag, else stream), else none. The project is the one
 * `resolveCardApprovalProjectRef` resolved (explicit project_id, else the
 * board's project). An untagged project falls through to the board.
 */
async function resolveCardApprovalReferenceTenant(
  projectId: string | null,
  boardId: string | undefined,
): Promise<{ tenant: string | null; source: 'project_tag' | 'board' | 'none' }> {
  if (projectId) {
    const [row] = await db
      .select({ project_data: projects.project_data })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const tag = (row?.project_data as { keycloak_tenant_id?: string } | null | undefined)
      ?.keycloak_tenant_id;
    if (tag) return { tenant: tag, source: 'project_tag' };
  }
  if (boardId) {
    const boardTenant = await resolveCardApprovalTenant(undefined, boardId);
    if (boardTenant) return { tenant: boardTenant, source: 'board' };
  }
  return { tenant: null, source: 'none' };
}

export async function resolveCardApprovalTenant(
  explicitTenantId: string | undefined,
  boardId: string | undefined,
): Promise<string | null> {
  if (explicitTenantId) return explicitTenantId;
  if (!boardId) return null;
  const [projectRow] = await db
    .select({
      tenant_id: departments.workspace_id,
      project_data: projects.project_data,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.planka_board_id, boardId))
    .limit(1);
  const fromProject = tenantFromProjectRow(
    projectRow?.tenant_id,
    projectRow?.project_data,
  );
  if (fromProject) return fromProject;
  // ⛔ THE DEPT CHAIN IS STRUCTURALLY DEAD FOR PROJECT BOARDS — fall back to the
  // tenant stamped on the row at create time, exactly as the sibling route does.
  //
  // `routes/projects.ts` (~:426) says it outright: "Projects are not
  // department-assigned (dept_id stays null), so the dept→workspace chain can't
  // recover tenant scope downstream; POST /api/execution/approvals reads
  // project_data.keycloak_tenant_id as the authoritative tenant."
  // `routes/execution-approvals.ts` (~:224) was fixed to do that. THIS resolver
  // was not, so it kept walking the chain that is documented as always null.
  //
  // Measured on prod 2026-08-27: of 214 projects carrying a planka_board_id,
  // dept_id is NULL on 214 — every single one — while 201 carry
  // project_data.keycloak_tenant_id. So the project branch resolved 0 of 214 and
  // every card-approval raised on a PROJECT board 400'd. 28 rejections in 7 days,
  // 25 distinct cards, 7 still sitting in BLOCKED. It looked survivable only
  // because the improvement loops ride STREAM boards, which resolve on the next
  // lookup and were therefore unaffected.
  //
  // Fails closed exactly as before: a project with neither a department nor a
  // stamped tenant still falls through to the stream lookup and then to null.
  const [streamRow] = await db
    .select({ tenant_id: streams.tenant_id })
    .from(streams)
    .where(eq(streams.planka_board_id, boardId))
    .limit(1);
  return streamRow?.tenant_id ?? null;
}

// ── METERING ATTRIBUTION FOR THE n8n WEBHOOK RECEIVERS ───────────────────────
//
// THE DEFECT. Every one of these receivers authenticates with the
// `X-Webhook-Secret` shared secret, not a bearer token, so
// `buildRequestContext` finds nothing to verify and the request runs with
// `ctx.tenantId === undefined` from first line to last. `middleware/usage-spans`
// reads that field to tag the metering span, so every webhook request emitted a
// billing event with an EMPTY tenant. billing does not reject those: it logs
// `tenant_id_unattributed` and writes the row to the nil tenant anyway
// (`billing_service/src/services/event_flusher.py:143-172`). Silent on both
// ends.
//
// MEASURED in `billing_metering_events` on worker4 over 3h on 2026-09-04, all
// with `source_ip=fr-backend`, `tenant_name=unknown`, `license_id=NULL`:
//     POST /api/webhooks/n8n/router-dedupe    335
//     POST /api/webhooks/n8n/card-approval     48
//     POST /api/webhooks/n8n/execution-event     1
// ≈114/h ≈ 2,733/day.
//
// THE TENANT IS NOT UNKNOWABLE HERE, which is the whole point. Two of the three
// handlers already resolve a real tenant and REFUSE to do their work without
// one (`resolveCardApprovalTenant`; `tenantFromProjectRow` on the execution
// path) — the value was computed and then simply never left the function. The
// third, `router-dedupe`, carries a Planka scope id that resolves through the
// same board chain: measured on prod fr on 2026-09-04, all 99 live
// `router_dedupe` rows carry ONE scope id, `1813235616851167013`, which joins
// `streams.planka_board_id` and yields tenant
// `0195f48b-d000-7000-8000-000000000001` (workspace `system`). 0 of 99 matched
// a project board; 18 of 18 streams-with-a-board carry a tenant.
//
// ⛔ WHAT THIS DOES NOT DO. It never substitutes a fallback tenant. When the
// chain resolves nothing the span still goes out tenantless — and is now
// COUNTED as such (`fr_metering_spans_total{attributed="no"}`). Defaulting to a
// real tenant would bill one customer for another's traffic, which is strictly
// worse than an honest nil.

/**
 * Publish a handler-resolved tenant onto the live request context so the
 * metering span emitted after the handler returns carries it.
 *
 * `attributeRequestTo` is FILL-IF-EMPTY and no-ops outside a request frame, so
 * this can never displace a tenant derived from a verified bearer token and is
 * safe to call from a direct unit-test invocation. `userId` is deliberately
 * omitted: a webhook has a tenant but no end user, and inventing one would be
 * the same class of fabrication this whole change exists to remove.
 *
 * Null/undefined in is a no-op: no tenant resolved, nothing published,
 * `usage-spans` counts the omission.
 */
function meterToResolvedTenant(tenantId: string | null | undefined): void {
  if (!tenantId) return;
  attributeRequestTo({ tenantId });
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the tenant behind a `router-dedupe` claim's scope id.
 *
 * The router sends `String(ev.keycloak_tenant_id || ev.boardId)` (see the
 * `N8nRouterDedupeSchema` note), so the field is one of two things and the
 * shape is what tells them apart:
 *
 *   * UUID-shaped -> it claims to be a Keycloak tenant. VERIFIED against
 *     `workspaces` before it is believed. An unverified uuid off the wire
 *     becoming a billing tenant is exactly the leak class this change closes,
 *     just pointed the other way, so an id that matches no workspace resolves
 *     to null rather than being trusted.
 *   * anything else -> a Planka board id, resolved through the SAME chain the
 *     card-approval receiver uses (`resolveCardApprovalTenant`), so there is
 *     one owner for "which tenant does this Planka board belong to" rather than
 *     a second copy that can drift.
 *
 * Returns null when neither answers. Attribution-only: this never gates the
 * dedupe claim, which is why the caller runs it AFTER the atomic INSERT.
 */
async function resolveRouterDedupeTenant(
  plankaScopeId: string,
): Promise<string | null> {
  if (UUID_SHAPE.test(plankaScopeId)) {
    const [ws] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, plankaScopeId))
      .limit(1);
    return ws?.id ?? null;
  }
  return resolveCardApprovalTenant(undefined, plankaScopeId);
}

/**
 * How a card-approval's `project_id` was decided. Four of the five values mean
 * the column is NULL, and they are NOT the same finding — see the resolver.
 */
type CardApprovalProjectSource =
  | 'explicit'
  | 'board_project'
  | 'stream_only'
  | 'board_unknown'
  | 'no_board';

interface CardApprovalProjectRef {
  project_id: string | null;
  source: CardApprovalProjectSource;
}

/**
 * Resolve the fr project id for a card-approval webhook: an explicit
 * `project_id` wins, else the `boardId → projects.planka_board_id` chain.
 * Returns a null `project_id` for board-less, stream-only or unknown boards —
 * those approvals stay project_id-null.
 *
 * ── ⛔ THE ORIGINAL DOCSTRING'S CLAIM IS TRUE. DO NOT "FIX" THE NULL. ─────────────
 * It said stream-only boards "belong to no project", and that is a STRUCTURAL fact,
 * not an omission. Re-measured on prod `fr` (worker4) 2026-09-07T13:53Z, SELECT-only:
 *
 *   `streams` has NO `project_id` column and no FK to `projects` (19 columns; the
 *   only project-shaped ones are `planka_project_id` and `planka_board_id`, both
 *   Planka ids, plus a nullable `owner_dept_id`).
 *
 *   Both candidate join paths resolve to ZERO, for all 18 streams:
 *     streams.planka_project_id → projects.planka_project_id   0/18 match
 *     streams.planka_board_id   → projects.planka_board_id     0/18 match
 *   NEGATIVE CONTROL, so that zero is not an empty column reading as agreement:
 *   241 of 246 projects DO carry a `planka_project_id` and 241 carry a
 *   `planka_board_id`. The columns are populated; the two hierarchies are disjoint.
 *   `owner_dept_id` is NULL on all 18, and dept→project is many-valued anyway.
 *
 * Streams are a PARALLEL hierarchy (asset-authoring: decision / principle /
 * requirement / procedure / prompt / workflow). Back-filling `projects.id` onto a
 * stream-only approval would be INVENTING a project, and `project_id` is read as a
 * scoping fact, not a label. So the value stays null. This change alters no
 * `project_id` on any row, present or future.
 *
 * ── ⭐ WHAT WAS ACTUALLY WRONG: the null could not say WHICH null it was. ─────────
 * MEASURED same run, buckets summing to their denominator (1,285 pending approvals
 * with `project_id IS NULL`, all `source='n8n'`, `card_id` non-null on 1,345/1,345):
 *
 *   boardId present, `jsonb_typeof` = string        1285 / 1285   (0 absent)
 *   ├─ board matches a project                         0
 *   ├─ board matches a project AND a stream            0
 *   ├─ board matches a stream only                  1282   <- CORRECT null
 *   └─ board matches NEITHER                           3   <- a DATA DEFECT
 *   (no boardId at all)                                0
 *
 * Those last 3 are boards fr has never heard of. They are a real problem — and until
 * now they were byte-for-byte indistinguishable from the 1,282 correct ones, because
 * both states were spelled `project_id = NULL` and nothing recorded which. That is
 * the whole defect: a null meaning "correctly has no project" and a null meaning
 * "the board resolved to nothing" collapsed into one value.
 *
 * The fix is the one the sibling field already got, one column over. See
 * `requester_source` at the insert below: "says HOW the requester was derived, so a
 * NULL requester_id reads as 'no project to attribute this to' rather than as the
 * old 'this route never set the field' — the two used to be the same row."
 * `project_source` is that sentence for `project_id`.
 *
 * ⛔ IT REFUSES RATHER THAN GUESSES. `board_unknown` is reported as its own value
 * and is never silently folded into `stream_only`; a caller that wants those 3 rows
 * chased can now select them. Ordering is projects-first so a board registered in
 * BOTH tables still resolves to its project — that was the prior behaviour and this
 * change preserves it exactly (prod holds 0 such boards today, so the fixture is
 * where that case is pinned, not the data).
 */
async function resolveCardApprovalProjectRef(
  explicitProjectId: string | undefined,
  boardId: string | undefined,
): Promise<CardApprovalProjectRef> {
  if (explicitProjectId) return { project_id: explicitProjectId, source: 'explicit' };
  if (!boardId) return { project_id: null, source: 'no_board' };
  const [projectRow] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.planka_board_id, boardId))
    .limit(1);
  if (projectRow) return { project_id: projectRow.id, source: 'board_project' };
  const [streamRow] = await db
    .select({ id: streams.id })
    .from(streams)
    .where(eq(streams.planka_board_id, boardId))
    .limit(1);
  return {
    project_id: null,
    source: streamRow ? 'stream_only' : 'board_unknown',
  };
}

/**
 * Resolve the Keycloak subject to record as the REQUESTER of a system-minted
 * approval: the resolving project's `owner_id`.
 *
 * WHY THIS EXISTS. Measured on prod 2026-08-25: the approvals UI renders
 * "Requested by:" EMPTY for every n8n-minted card approval, because
 * `handleN8nCardApproval`'s insert never set `requester_id` at all — the column
 * (schema.ts:434, made nullable by migration 004 "n8n service account creates
 * approvals") stayed NULL on every row this route has ever written. The two
 * sibling system-minted paths already answer "who asked?" the same way and always
 * have: `handleN8nApprovalRequest` above (`requester_id: project.owner_id`) and
 * `routes/execution-approvals.ts` (`project?.owner_id ?? null`). One answer, three
 * paths — this helper is so they cannot drift apart again.
 *
 * `projects.owner_id` is `notNull()` (schema.ts:73), so a resolved project ALWAYS
 * yields a real id; null here means only "no project resolved" (board-less or
 * stream-only card approvals), never "the project had no owner".
 *
 * ⚠️ WHY NOT SYNTHESISE A "system" ID FOR THE NULL CASE — READ BEFORE "FIXING" IT.
 * fr has NO local `users` table; every id in this column is a Keycloak subject.
 * `approvals.requester_id` is a bare `uuid` with NO foreign key (schema.ts:434 has
 * no `.references()`; the only migration touching it, 004, just dropped NOT NULL),
 * so Postgres WOULD happily accept an invented uuid — which is exactly why one must
 * not be written: nothing downstream would reject it, and `routes/approvals.ts`
 * treats `requester_id` as an authorization fact (`reachable = approval.requester_id
 * === user.id` at :249, and the "mine" filter at :833). A fabricated subject there is
 * a visibility grant, not a cosmetic label. The only system-shaped uuid already in
 * this codebase is `00000000-0000-0000-0000-000000000000`, which is the AUTH_BYPASS
 * *dev* user (middleware/auth.ts:35) — stamping that into prod rows would make real
 * approvals indistinguishable from dev-bypass ones. So: a real owner when one exists,
 * an honest NULL plus a recorded `requester_source` when one does not.
 */
export async function resolveCardApprovalRequesterId(
  projectId: string | null,
): Promise<string | null> {
  if (!projectId) return null;
  const [projectRow] = await db
    .select({ owner_id: projects.owner_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return projectRow?.owner_id ?? null;
}

/**
 * POST /api/webhooks/n8n/card-approval
 * Simpler endpoint for n8n to request card approvals.
 * No fr_project_id or required_approvers needed; an optional recipient phone is
 * stored on the row as producer metadata.
 *
 * Tenant scoping (migration 043): n8n MUST supply either `tenant_id` or a
 * `boardId` that maps to a known FR project (planka_board_id) or stream
 * (planka_board_id). Without one of those, the webhook returns 400; we no
 * longer accept tenantless card approvals.
 */
/**
 * Card-approval fields a licence caller may NOT set (403 licence_field_forbidden).
 * G5 (George 2026-10-10): the licence is the tenant's conveyor seat and mints
 * every gate KIND the secret door minted — deblock_action (COVERAGE, MERGE,
 * SPLIT, DROP, …), pr_* (bound to the project's repo), advance_phase_on_approve,
 * the bug-fix marker. What stays refused is not a kind but a reach outside the
 * tenant no binding can check here:
 *   * recipient — a producer-supplied phone override stored on the approval (no channel
 *     delivers to it); a licence caller may still not set it;
 *   * approver_user_id — addresses the gate to any user id; fr resolves the
 *     approver from the tenant instead (resolveApprover);
 *   * learning_card_id — links the gate to an arbitrary learning card;
 *   * callback_path (non-default) — chooses which n8n webhook fr fires.
 */
const LICENCE_CARD_APPROVAL_FORBIDDEN_FIELDS = [
  'recipient',
  'approver_user_id',
  'learning_card_id',
] as const;
const DEFAULT_CARD_APPROVAL_CALLBACK_PATH = 'kanban/approval-callback';

/**
 * The licence door's binding for POST /api/webhooks/n8n/card-approval. Runs
 * after the schema and BEFORE any lookup that writes, dedupes or mints:
 *   * no out-of-tenant field (above);
 *   * `boardId` REQUIRED and its tenant (`resolveCardApprovalTenant(undefined,
 *     boardId)` — board → project, else stream; never the body tenant) must be
 *     the licence's. This also closes the old secret door's no-reference
 *     platform-tenant branch (`classifyCardApprovalTenant` 'no_reference_platform');
 *   * an explicit `tenant_id` / `project_id`, when sent, must name the same tenant;
 *   * the card, and every list the callback may move it to, must sit on that
 *     board (Planka parent lookup; null/err ⇒ not yours);
 *   * a MERGE's PR must be in the project's repository (assertLicencePrOnProjectRepo).
 * Refusal: 403 licence_tenant_mismatch (write-route convention, card-phase-lease).
 */
async function bindCardApprovalToLicence(
  door: LicenceDoor,
  rawBody: unknown,
  v: z.infer<typeof N8nCardApprovalSchema>,
): Promise<void> {
  const raw = (rawBody ?? {}) as Record<string, unknown>;
  for (const key of LICENCE_CARD_APPROVAL_FORBIDDEN_FIELDS) {
    if (raw[key] !== undefined && raw[key] !== null) {
      throw licenceFieldForbidden(key, 'it reaches outside the licence tenant');
    }
  }
  if (v.callback_path !== DEFAULT_CARD_APPROVAL_CALLBACK_PATH) {
    throw licenceFieldForbidden('callback_path', 'fr, not the caller, chooses which n8n webhook a decision fires');
  }
  if (!v.boardId) throw licenceTenantMismatch('a card approval with no boardId');
  const boardTenant = await resolveCardApprovalTenant(undefined, v.boardId);
  if (!sameTenant(boardTenant, door.tenantId)) throw licenceTenantMismatch(`board ${v.boardId}`);
  if (v.tenant_id !== undefined && !sameTenant(v.tenant_id, door.tenantId)) {
    throw licenceTenantMismatch('tenant_id');
  }
  let repositoryUrl: string | null = null;
  if (v.project_id !== undefined) {
    const [projectRow] = await db
      .select({
        tenant_id: departments.workspace_id,
        project_data: projects.project_data,
        repository_url: projects.repository_url,
      })
      .from(projects)
      .leftJoin(departments, eq(departments.id, projects.dept_id))
      .where(eq(projects.id, v.project_id))
      .limit(1);
    const projectTenant = tenantFromProjectRow(projectRow?.tenant_id, projectRow?.project_data);
    if (!sameTenant(projectTenant, door.tenantId)) throw licenceTenantMismatch(`project ${v.project_id}`);
    repositoryUrl = projectRow?.repository_url ?? null;
  } else {
    const [boardProject] = await db
      .select({ repository_url: projects.repository_url })
      .from(projects)
      .where(eq(projects.planka_board_id, v.boardId))
      .limit(1);
    repositoryUrl = boardProject?.repository_url ?? null;
  }
  assertLicencePrOnProjectRepo(raw, repositoryUrl);
  const cardBoard = await licenceParentBoard('card', v.card_id);
  if (cardBoard === null || cardBoard !== String(v.boardId)) throw licenceTenantMismatch(`card ${v.card_id}`);
  for (const listId of [v.doingListId, v.todoListId]) {
    if (typeof listId !== 'string' || listId.length === 0) continue;
    const listBoard = await licenceParentBoard('list', listId);
    if (listBoard === null || listBoard !== String(v.boardId)) throw licenceTenantMismatch(`list ${listId}`);
  }
}

export async function handleN8nCardApproval(req: Request): Promise<Response> {
  // G5 (George 2026-10-10): a licence token ONLY (lib/licence-door.ts), bound to its
  // tenant by bindCardApprovalToLicence below. X-Webhook-Secret is not accepted: a
  // secret-only request (or a Keycloak JWT) is 401.
  const door = await licenceOnly(req);
  // fr row 14d-2: the caller's OWN tenant, read BEFORE `meterToResolvedTenant`
  // below stamps the resolved (possibly explicit, unverified) tenant onto the
  // frame — after that, "the caller's own tenant" would just echo the body.
  const callerOwnTenant = tryCtxTenantId();
  const body = await req.json();
  const validated = N8nCardApprovalSchema.parse(body);
  await bindCardApprovalToLicence(door, body, validated);
  // D17: validated BEFORE any lookup that writes, dedupes or mints (422 on refusal).
  const callbackUrl =
    validated.callback_url !== undefined ? assertCallbackUrlAllowed(validated.callback_url) : null;
  // D13: shape first (422 artifact_ref_invalid), before any lookup that writes.
  const artifactRef = parseArtifactRef(validated.artifact_ref);

  const tenantId = await resolveCardApprovalTenant(
    validated.tenant_id,
    validated.boardId,
  );
  // Same reasoning as the execution-event route: publish before the guard, so
  // the 400s below are attributed too. Measured on worker4 over 3h on
  // 2026-09-04, 48 card-approval events landed on billing's nil tenant while
  // this very handler had already resolved a real one and REQUIRED it to
  // proceed — the value existed, it just never left the function.
  meterToResolvedTenant(tenantId);
  if (!tenantId) {
    // ⛔ NAME WHAT FAILED. Every one of these is a gate that was never created:
    // n8n asked for a human decision, got a 400, and the card stays BLOCKED with
    // nobody asked and no callback ever fired — the same silent-loss shape as an
    // approval that names no approver. The old message said only that a
    // `boardId` was required, so an occurrence in the log was undiagnosable:
    // it named neither the board, nor the card, nor which of the TWO distinct
    // causes had fired. Measured on prod 2026-08-26: one occurrence per ~90min
    // of peak traffic, and no way to tell from the log which board to chase.
    //
    // ⛔ AND DO NOT NAME THE WRONG THING. The first version of this message said
    // a present-but-unresolved boardId "matches no fr project
    // (projects.planka_board_id)". The very first occurrence it captured in prod
    // proved that wrong: board 1850128618575890404 HAS a project row — it simply
    // had no department and no stamped tenant to resolve through. The message
    // sent a reader hunting an unregistered board that was registered perfectly.
    //
    // So the board-present arm now distinguishes the two states it was
    // conflating, by asking whether a project row exists at all:
    //   * no project row and no stream row → the board really is unknown to fr;
    //   * a project row exists but yields no tenant → registration is fine and
    //     the row is untenanted, which is a data problem on that project.
    // A message that misnames the cause is worse than the silent 400 it replaced:
    // it spends someone's afternoon.
    const [existingProject] = validated.boardId
      ? await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.planka_board_id, validated.boardId))
          .limit(1)
      : [];
    const detail = !validated.boardId
      ? 'no `boardId` was supplied and no explicit `tenant_id` was given'
      : existingProject
        ? `boardId ${validated.boardId} maps to project ${existingProject.id}, but that project ` +
          'has no department link and no project_data.keycloak_tenant_id, so no tenant could be resolved'
        : `boardId ${validated.boardId} matches no fr project (projects.planka_board_id) ` +
          'and no improvement stream (streams.planka_board_id)';
    console.error(
      `[webhooks] card-approval REJECTED for card ${validated.card_id} — ${detail}. ` +
        'This gate was NOT created; the card will stay blocked until the caller retries with a resolvable board.',
    );
    throw new BadRequestError(
      `Card-approval webhook could not resolve a tenant: ${detail}. ` +
        'Supply an explicit `tenant_id`, or a `boardId` that maps to a known FR project or improvement stream.',
    );
  }

  const projectRef = await resolveCardApprovalProjectRef(
    validated.project_id,
    validated.boardId,
  );
  const projectId = projectRef.project_id;

  // ── fr row 14d-2: an EXPLICIT tenant must agree with the card's project/board ──
  // `resolveCardApprovalTenant` returns an explicit body tenant verbatim, so
  // without this the n8n caller alone decides which tenant an approval is filed
  // under. Rule + outcomes: lib/card-approval-tenant-check.ts. Runs BEFORE any
  // dedupe or insert, so a refused request mints nothing.
  if (validated.tenant_id) {
    const reference = await resolveCardApprovalReferenceTenant(projectId, validated.boardId);
    const outcome = classifyCardApprovalTenant({
      explicitTenant: validated.tenant_id,
      referenceTenant: reference.tenant,
      callerTenant: callerOwnTenant,
    });
    recordCardApprovalTenantCheck({
      outcome,
      explicitTenant: validated.tenant_id,
      referenceTenant: reference.tenant,
      referenceSource: reference.source,
      cardId: validated.card_id,
    });
    if (isRefusedCardApprovalTenant(outcome)) {
      throw new ValidationError(
        `Card-approval tenant_id ${validated.tenant_id} does not match the card's ` +
          (reference.source === 'project_tag'
            ? `project tag (${reference.tenant})`
            : reference.source === 'board'
              ? `board tenant (${reference.tenant})`
              : 'project or board (none resolved; an explicit tenant must then be a platform tenant)') +
          '. The approval was NOT created.',
        { outcome, reference_source: reference.source },
      ).withCode('card_approval_tenant_mismatch');
    }
  }

  // D13: the ref must name an artifact of the approval's resolved project — 422
  // artifact_ref_not_found (also when no project resolves) before any dedupe or insert.
  if (artifactRef) await assertArtifactRefInProject(artifactRef, projectId, tenantId);

  // ── U3 PROOF-RUN KINDS (migration 153) ─────────────────────────────────────────
  // bug_fix / feature_design are SENT (`kind`); qa.coverage_signoff is DERIVED. Validated
  // HERE — before the dedupe and before any insert — so a malformed U3 request is always
  // a 422/409, never minted, deduplicated onto an existing row, or stripped. Reads the RAW
  // body on purpose (see the module header): the parsed object drops what it does not
  // declare, and after fr#1333 its `metadata` passthrough is lenient by design.
  // after fr#1333: its schema parses only `metadata.coverage_request`, leniently
  // (`.catch(undefined)` drops a malformed one) and spreads it into the insert; the spread
  // of `u3.metadata` below comes LAST, so the strictly validated request is what is stored,
  // and a malformed one never gets that far — it is refused here. #1333 does not carry the
  // bug_fix/design fields at all, which is why this reads the raw body, not `validated`.
  const u3 = await resolveU3Mint({ rawBody: body, cardId: validated.card_id, tenantId });
  // U3 bug-fix gate (RULING 10-01): a blocked-escalate deblock row marked
  // metadata.approval_kind='bug_fix_authorization' must cite the bug card's U2 report,
  // its hash and bug_ids ⊆ its bugs. Raw body for the same reason as above. null = unmarked.
  const bugFixAuth = await resolveBugFixAuthorizationMint({ metadata: (body as { metadata?: unknown })?.metadata, tenantId });

  // ── ONE CARD, ONE OPEN GATE ────────────────────────────────────────────────────
  // MEASURED 2026-08-26: seven Planka cards each carried TWO pending approvals, and
  // for all seven there were ZERO `moveCard` rows between the two mints. So these are
  // double-mints on an UNCHANGED card, not a card that was released and re-blocked —
  // a discriminator worth stating, because re-block hardening (cooldowns, exit guards)
  // would not have touched a single one of them.
  //
  // The two producers are different KINDS, which is why this guard must not be
  // kind-scoped:
  //   1. `execution.ready_signoff`, minted within ±1s of the READY→BLOCKED move
  //      ("AA ready-prefetch policy gate: human stakeholder sign-off required…").
  //      This is the thing actually holding the card.
  //   2. `generic`, minted 23s–11min later by THIS route, because producer 1 blocked
  //      the card without persisting a `block_reason` and this path cannot see
  //      producer 1's already-pending row. Its own description says so:
  //      "A card reached BLOCKED with block_reason_class=unknown_no_reason_persisted".
  // A kind-scoped guard would fire on neither.
  //
  // Returning the existing approval rather than 409-ing is deliberate: the caller
  // (`blocked-escalate :: Call FR`) reads `frResult.approval_id || null`, so a 200
  // carrying the row that IS holding the card is the honest answer to "make sure this
  // card has a gate". A second row would not add a gate; it would add a second thing
  // for a human to decide about one stuck card.
  //
  // ⚠️ KNOWN INFORMATION LOSS, stated rather than hidden: a `learning_card_id` on the
  // suppressed request is NOT merged onto the surviving row. Merging is a write into
  // another producer's row and deserves its own evidence; the id is logged here so the
  // link is recoverable. Not indexed either — `approvals` holds ~550 rows and grows at
  // ~150/day against ~20 mints/hour, so a seq scan is not yet worth a migration.
  // The query itself now lives in domain/approvals/one-open-gate.ts, because the
  // sibling minter (routes/execution-approvals.ts) inserted unconditionally and
  // this rule only ever applied to whichever door the request came through.
  if (validated.card_id) {
    const existing = await findOpenGateForCard({
      tenantId,
      cardId: validated.card_id,
    });
    if (existing) {
      // U3: a proof-run gate dedupes only onto an open gate asking the SAME question
      // (same kind + same report/design/commit). Anything else is 409 open_gate_conflict,
      // never a `deduplicated: true` that names another question's row. See
      // assertU3DedupeCompatible. Non-U3 mints keep the return-the-existing-row rule.
      assertU3DedupeCompatible(u3, existing);
      // U3 bug-fix gate: a MARKED request dedupes ONLY onto the SAME request — a marked
      // `generic` row with equal report_hash, bug_card_id and bug_ids (as a set); anything
      // else is 409 (bug_card_already_has_approval / open_gate_conflict, refuseMarkedDedupe),
      // exactly as on the execution-approvals door. A marked row on this door is always kind
      // `generic` (resolveU3Mint refuses a U3 kind with the marker; assertU3NotImprovement an
      // improvement board). Unmarked (bugFixAuth null): no-op.
      assertSameBugFixRequest(existing, bugFixAuth, 'generic');
      // D13: the gate keeps its own artifact_ref; a request naming another is 409.
      assertArtifactRefDedupeCompatible(existing, artifactRef);
      console.warn(
        describeSuppression('webhooks', validated.card_id, existing) +
          (validated.learning_card_id
            ? ` Dropped learning_card_id=${validated.learning_card_id} (not merged onto the surviving row).`
            : ''),
      );
      // D17: the deduped create's Wait node must resume too — ATTACH its URL to the
      // surviving gate (a no-op when that URL is already attached).
      if (callbackUrl) await attachApprovalCallbackUrl(existing.id, tenantId, callbackUrl);
      return jsonResponse({ approval_id: existing.id, deduplicated: true });
    }
  }

  // ── FIXTURE TRAFFIC DOES NOT GET A HUMAN ───────────────────────────────────────
  // The same refusal `execution-approvals.ts` already applies to the sign-off path,
  // applied here to the generic card-approval mint — which never called it, so the
  // control was inert against exactly the traffic it was written for.
  //
  // MEASURED 2026-08-26: board `smoke-test-2026-05-01` produced 100 of the 200 cards
  // that entered BLOCKED in 24h and released 4, and accounted for 41 of the 62 pending
  // approvals. Every one of those 41 is `kind='generic'` from this route.
  //
  // ⚠️ `project_data` is NOT in scope here — `resolveCardApprovalProjectRef` selects
  // `{ id }` only. It is fetched with its own query rather than by widening that
  // helper, because the helper has another caller whose contract should not move for
  // this. Board-id-only gating was rejected: it would silently miss the
  // `fixture:true` and `requestor` markers that catch the IT Flow1 drivers, which are
  // the other half of the fixture population.
  //
  // ⚠️ This is INERT until `FR_FIXTURE_BOARD_IDS` is set — `resolveFixtureBoardIds()`
  // defaults to EMPTY, and inert-but-shipped reads identical to working. The env var
  // is the other half of this change and ships in gitops.
  {
    const [fixtureProject] = projectId
      ? await db
          .select({ project_data: projects.project_data, status: projects.status })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1)
      : [];
    if (
      isFixtureOrigin({
        projectData: fixtureProject?.project_data,
        boardId: validated.boardId,
      })
    ) {
      const detail =
        `Fixture-origin card approval: no human gate minted for card ` +
        `${validated.card_id} on board ${validated.boardId ?? 'unknown'}` +
        `${projectId ? ` (project ${projectId})` : ''}. This is a deliberate refusal, ` +
        `not a configuration defect — see SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN.`;
      console.warn(`[webhooks] ${detail}`);
      // 403 for the same reason the sign-off path uses one: the request is well-formed
      // and nothing is misconfigured, fr is declining to act. Verified safe for the
      // caller — `blocked-escalate :: Call FR` carries continueOnFail:true and its only
      // consumer, `Format Result`, reads `frResult.approval_id || null`. So this does
      // NOT convert 100 suppressions a day into 100 red executions.
      throw new ForbiddenError(detail).withCode(SIGNOFF_BLOCK_REASONS.FIXTURE_ORIGIN);
    }
    // fr#1499: a card approval on an ARCHIVED project — named explicitly OR
    // resolved from its (still-registered) board — is written and then
    // invisible, because the approvals project lane hides archived projects.
    // 409 project_archived, before any dedupe or insert. (The fixture refusal
    // above keeps precedence: it is a deliberate non-mint, not a defect.)
    if (fixtureProject && projectId) {
      assertProjectNotArchived({ id: projectId, status: fixtureProject.status });
    }
  }


  // ── WHO IS ASKING ──────────────────────────────────────────────────────────────
  // The counterpart to "who is being asked" below. There is no human actor to read
  // here — this route is licence-authed (G5), so the request proves "the tenant's
  // conveyor seat", not a Keycloak subject. The project owner is the only real
  // Keycloak identity in scope, and it is what both sibling mint paths already write.
  // See resolveCardApprovalRequesterId for the measured blank-UI defect this closes and
  // for why the null case stays null instead of getting a synthetic "system" uuid.
  const requesterId = await resolveCardApprovalRequesterId(projectId);
  if (!requesterId) {
    // Not fatal — a stream-only / board-less card approval genuinely belongs to no
    // project and therefore to no owner. Logged (not silently swallowed) because a
    // NULL here is now a MEASUREMENT of an unattributable mint, not the old default.
    console.warn(
      `[webhooks] card-approval for card ${validated.card_id} has no resolvable project owner ` +
        `(project_id=${projectId ?? 'null'}); requester_id stays NULL rather than inventing a subject.`,
    );
  }

  // Drop an invalid phase marker at the boundary; only keep a phase of this
  // tenant's RM catalogue (services/catalogue/tenant-catalogue.ts — fr holds no
  // phase list). Read only when a marker is present.
  const markedPhase = validated.advance_phase_on_approve
    ? (await cataloguePhases(tenantId)).find((p) => p.name === validated.advance_phase_on_approve)
    : undefined;
  const advancePhase = markedPhase ? markedPhase.name : undefined;

  // NULL/omitted deadline_hours => NULL expires_at => never expires. See the schema field.
  // Same helper as the two sibling writers: one implementation, so a future change cannot fix
  // one card-blocking write path and silently leave the others manufacturing a deadline —
  // which is exactly how 132 approvals kept expiring after migration 105 "fixed" them.
  //
  // ⭐ A GATE APPROVAL (George 2026-10-12, Q2: gates are approvals only): when the
  // marked phase has an RM gate (`has_gate`, `/pm/gates`), that gate's
  // `expires_after_hours` is the TTL. No gate, or a gate with no TTL set ⇒ the
  // existing default, unchanged.
  let expiresAt = deadlineFromHours(validated.deadline_hours);
  if (markedPhase?.has_gate) {
    const gate = await catalogueGateForPhase(tenantId, markedPhase.id);
    if (gate?.expires_after_hours != null) expiresAt = deadlineFromHours(gate.expires_after_hours);
  }

  // ── TRIAGE — ROUTING ONLY, NOT PERSISTED ───────────────────────────────────────
  // Today a pass-through that always returns `escalate`, so this cannot change an
  // outcome. The seam exists so a future single-inference n8n worker can pre-filter
  // requests without re-opening the write path of a live gate (P-SYS-12: the loop
  // lives in the graph, not in the model). resolveTriageVerdict maps anything
  // unknown — null, unreachable, malformed — back to `escalate`.
  //
  // ⚠️ `verdict` IS STILL READ, WHICH IS WHY THIS CALL SURVIVED THE 2026-09-23
  // RETIREMENT OF THE `triage_*` COLUMNS. Its one consumer is the
  // "no reachable human approver" refusal two screens down
  // (`verdict === 'escalate' && !routing.approver`). That is an IN-MEMORY read of
  // a value computed in this same function — the thing that was removed is the
  // PERSISTENCE of it, which nothing ever read back. `triage.actor` and
  // `triage.rationale` are now unread and are kept only because they arrive on the
  // same return value; do not add new writers for them.
  //
  // ⛔ Do NOT "simplify" the guard to `!routing.approver`. It is behaviourally
  // identical today only because the triager is a stub, and collapsing it deletes
  // the one place a real verdict would have to be honoured.
  const triage = await triageApproval({
    tenantId,
    cardId: validated.card_id,
    description: `${validated.card_name}: ${validated.reason}`,
  }).catch((err) => {
    // A triager that goes dark must NOT approve everything by going dark.
    console.error('[webhooks] triage failed; escalating to a human:', err);
    return { verdict: 'escalate' as const, actor: 'policy', rationale: 'triage unavailable' };
  });
  const verdict = resolveTriageVerdict(triage.verdict);

  // ── WHO IS BEING ASKED ─────────────────────────────────────────────────────────
  // An approval that names nobody is a 24-hour timer, not a gate: 316 of the 362
  // approvals this route had raised named no one, and 335 expired unread. Refusing
  // to write the row is the point — a loud 422 to n8n is recoverable, a silent timer
  // strands the card in BLOCKED forever.
  const routing = await resolveApprover({
    tenantId,
    projectId,
    explicitUserId: validated.approver_user_id ?? null,
  });

  // ── CAN THIS BE ANSWERED AT ALL? ───────────────────────────────────────────────
  // The mirror of the check below. That one refuses an approval nobody can be
  // TOLD about; this refuses one nobody can ANSWER. Measured: 8 of 10 pending
  // rows carried a producer PLACEHOLDER as their reason (#888) and 6 more carried
  // a crashed worker's error text as the "question" (#890) — 341 approvals have
  // expired unanswered. Neither row states a proposition a human can decide.
  //
  // A loud 422 sends the defect back to the producer that has the missing
  // information; minting the row buries it in a human queue for 24h and then
  // drops it. Deliberately conservative — see classifyUndecidableReason.
  const undecidable = classifyUndecidableReason(validated.reason);
  if (undecidable) {
    throw new ValidationError(
      `Card ${validated.card_id} ("${validated.card_name}") supplied a reason that ` +
        `cannot be decided on (${undecidable}): ${JSON.stringify(validated.reason)}. ` +
        'An approval a human cannot answer is a timer, not a gate — it consumes ' +
        'approver attention and TTL and then expires unread. Send the actual block ' +
        'reason, or fix the upstream failure that produced this text; do not mint a ' +
        'gate to carry it.',
    );
  }

  if (verdict === 'escalate' && !routing.approver) {
    throw new ValidationError(
      `No reachable human approver for tenant ${tenantId}` +
        (projectId ? ` / project ${projectId}` : '') +
        `. Considered: ${JSON.stringify(routing.considered)}. ` +
        'An approval nobody can be told about would strand this card in BLOCKED. ' +
        'Fix one of: give the tenant a workspace-admin with an enabled push channel ' +
        '(telegram/email/teams/voice), set APPROVAL_FALLBACK_APPROVER_USER_ID ' +
        'to a reachable human, or pass approver_user_id explicitly.',
    );
  }

  // ── CAN APPROVING THIS EVER MOVE THE CARD? ─────────────────────────────────────
  // The third member of the family above. `classifyUndecidableReason` refuses an
  // approval nobody can ANSWER; `resolveApprover` refuses one nobody can be TOLD
  // about; this refuses one that, once answered, DOES NOTHING.
  //
  // `buildCallbackPayload` narrows `metadata.deblock_action` through a closed
  // allowlist — "a key absent here is DROPPED" — so a BLOCKED-exit approval minted
  // without one is approved by a human, stamped `callback_delivered_at`, and leaves
  // the card exactly where it was. Measured on prod 2026-09-06: 97 cards in BLOCKED
  // behind 137 such approvals, 119 of them with a delivered callback. Delivery was
  // never the missing piece.
  //
  // The counter fires on BOTH arms, deliberately. A 422 here is invisible outside fr
  // (`blocked-escalate :: Call FR` carries continueOnFail:true, so it does not redden
  // the n8n execution — the same property the fixture-origin 403 above relies on), and
  // a refusal nobody can see is the bug again at a different seam.
  const deblockExit = classifyDeblockExit({
    action: validated.deblock_action,
    doingListId: validated.doingListId,
    todoListId: validated.todoListId,
    advancePhase: advancePhase,
  });

  // ── CAN APPROVING THIS MEAN TWO THINGS AT ONCE? ────────────────────────────────
  // The fourth member of the family above, and the mirror of the guard below it. That
  // one refuses an approval whose answer does NOTHING; this refuses one whose answer
  // does TWO things.
  //
  // This schema accepts `advance_phase_on_approve` and `deblock_action` together and
  // spreads BOTH into the same jsonb, so a row asserting two exits has always been
  // constructible here. On such a row the approval-completion phase advance used to move
  // the project's macro-phase AND `buildCallbackPayload` told n8n to move the card — two
  // effects from one human decision, with nothing reconciling them. That advance was
  // deleted (fr#1481); the refusal is RETAINED because the marker still asserts an exit
  // the classifier honours (`phase_advance` lane), so the card move would still be
  // withheld on decide.
  //
  // fr does not pick a winner: whichever half lost would lose SILENTLY, which is the
  // exact failure mode the rest of this lane has been paying down. The producer is the
  // only party that knows which exit it meant, so the refusal goes back to it.
  //
  // ⭐ MEASURED 2026-09-07 on prod `fr` (2,856 rows, `deblock_action` live on 1,763):
  // ZERO rows carry `advance_phase_on_approve` under any spelling, so this refuses
  // nothing that exists — it is forward-looking, exactly as the guard below it turned out
  // to be. ⚠️ And a zero that holds only because the producer has not shipped yet is not
  // safety; see the DUAL-EXIT block in `domain/engagement/deblock-actions.ts` for why the
  // improvement lane (32 of 34 rows) is deliberately NOT in the refused set.
  const dualExit = irreconcilableDualExit(deblockExit);
  if (dualExit) {
    // Counted before the throw, for the same reason the guard below counts on both arms:
    // a 422 is invisible outside fr (`blocked-escalate :: Call FR` runs
    // `continueOnFail: true`), and a refusal nobody can see is the bug at a new seam.
    recordDeblockDualExit('mint', dualExit.exemption);
    throw new ValidationError(deblockDualExitMessage(validated.card_id, dualExit));
  }

  if (deblockExit.required) {
    recordDeblockAction('mint', deblockExit.action, {
      rawWasPresent: deblockExit.rawWasPresent,
    });
    if (!deblockExit.usable) {
      throw new ValidationError(deblockActionRequiredMessage(validated.card_id));
    }
  }

  // Built first, then handed to `mintOneOpenGate` so the INSERT itself is the
  // arbiter against migration 114's partial unique index. The pre-check above is a
  // fast path, not a guard — between its SELECT and this write a sibling execution
  // can mint (fr#1000: 39 mints on one card inside 60s, tightest pair 57ms apart).
  const gateValues: typeof approvals.$inferInsert = {
    tenant_id: tenantId,
    project_id: projectId,
    // The field whose absence rendered "Requested by:" blank on every n8n approval.
    requester_id: requesterId,
    description: `${validated.card_name}: ${validated.reason}`,
    // D17: a callback_url row has NO callback_path — the decision goes to the URL
    // only, never also to `${N8N_WEBHOOK_URL}/<callback_path>`.
    callback_path: callbackUrl ? null : validated.callback_path,
    card_id: validated.card_id,
    source: 'n8n',
    // D13 (migration 192): validated above against the resolved project.
    artifact_ref: artifactRef,
    // ── THE PROPOSITION'S REASONING ────────────────────────────────────────────
    // Persisted here, not merely parsed above: a route that accepts the keys and
    // then forgets to pass them to the insert is green on a schema test and still
    // writes NULL — which is precisely the shape of the defect being closed.
    //
    // `rationaleOrAbsence`, not `?? null`. NULL renders NOTHING on the approval
    // page (`approvals/[id]/+page.svelte:161` and siblings gate on truthiness), so
    // an approver cannot tell "the producer supplied no reasoning" from "this kind
    // has no reasoning section". Both are silent; only one should stop a human from
    // deciding. fr does NOT synthesise the missing half — see lib/approval-rationale.ts
    // for why fabricating one from the description or the gate terms would be worse
    // than the empty field.
    change_summary: rationaleOrAbsence(
      validated.change_summary,
      'change_summary',
      RATIONALE_PRODUCERS.cardApproval,
    ),
    impact_analysis: rationaleOrAbsence(
      validated.impact_analysis,
      'impact_analysis',
      RATIONALE_PRODUCERS.cardApproval,
    ),
    // Omitted (not `undefined`) when this is not a U3 gate, so the column
    // default `'generic'` still applies.
    ...(u3 ? { kind: u3.kind } : {}),
    approver_user_id: routing.approver?.userId ?? null,
    // ⛔ THE FOUR `triage_*` COLUMNS ARE DELIBERATELY NOT WRITTEN HERE ANY MORE.
    // They were written by this insert, by the execution-approvals sibling, and by
    // an unrouted PATCH handler — and read by NOBODY outside those write paths.
    // MEASURED 2026-09-23 across backend/src and frontend/src: readers outside the
    // write path, ZERO; frontend readers, ZERO. Every row carried the same constant
    // pair ('escalate','policy') because `triageApproval()` is a pass-through, so
    // the columns encoded no information while reading as populated — which is how
    // "103 of 168 approvals are triaged" came to be believed of rows where not one
    // had been triaged. A populated column nothing reads is worse than an empty one:
    // it answers a question it has not asked.
    //
    // ⚠️ THE COLUMNS AND THE CHECK BOTH STAY FOR NOW, ON PURPOSE. Dropping them in
    // the same release that stops writing them is the unsafe ordering: a lagging or
    // rolled-back pod still running the previous image would INSERT into a dropped
    // column and 500 the whole n8n ingest path. Migration **130** drops the four
    // columns and `approvals_triage_verdict_check`, in BOTH emitters (this
    // repo's `migrations/101_approval_triage.sql` lineage AND the drizzle
    // declarations in `src/db/schema.ts`), in a LATER release. Migration 101's
    // runner probe has already been moved off the CHECK so that 130 cannot wedge
    // boot — see the 101 entry in `src/db/migration-runner.ts` for why.
    //
    // ⭐ STOPPING THE WRITE CANNOT CHANGE BEHAVIOUR HERE, and that is measured, not
    // assumed: the `NULL ⇒ escalate` rule the schema docblock advertised was never
    // implemented — `resolveTriageVerdict` is only ever applied to the IN-MEMORY
    // result of `triageApproval()` above, never to a value loaded from the column —
    // so no code path has ever branched on what is stored here.
    metadata: {
      doingListId: validated.doingListId,
      todoListId: validated.todoListId,
      boardId: validated.boardId,
      ...(validated.deblock_action ? { deblock_action: validated.deblock_action } : {}),
      // Spread individually rather than as one object: an absent field must be ABSENT from the
      // jsonb, not present-and-undefined. `buildCallbackPayload` reads these back with the same
      // allowlist discipline as every other metadata key.
      ...(validated.pr_url ? { pr_url: validated.pr_url } : {}),
      ...(validated.pr_repo_owner ? { pr_repo_owner: validated.pr_repo_owner } : {}),
      ...(validated.pr_repo_name ? { pr_repo_name: validated.pr_repo_name } : {}),
      ...(validated.pr_number ? { pr_number: validated.pr_number } : {}),
      ...(validated.learning_card_id ? { learning_card_id: validated.learning_card_id } : {}),
      // See the schema note on `card_type`: the approval-completion phase advance (deleted, fr#1481) and
      // `buildCallbackPayload` both read it off metadata, so accepting it without
      // PERSISTING it here would fix nothing. Spread individually, like its
      // siblings, so an absent card_type is ABSENT from the jsonb rather than
      // present-and-undefined.
      ...(validated.card_type ? { card_type: validated.card_type } : {}),
      // See the schema note on `gate_terms`. Accepting the key without PERSISTING it
      // here would fix nothing — that is precisely the defect the `card_type` comment
      // above describes, one field earlier. Spread individually and gated on `.length`,
      // exactly as the sibling `N8nApprovalRequestSchema` mint does, so an absent or
      // empty array leaves the jsonb byte-identical to before: the predicate reads a
      // MISSING `gate_terms` and an EMPTY one as two different findings and must keep
      // being able to tell them apart.
      ...(validated.gate_terms?.length ? { gate_terms: validated.gate_terms } : {}),
      // See the schema note on `open_questions`. ⛔ ACCEPTING THE KEY WITHOUT
      // PERSISTING IT HERE WOULD FIX NOTHING — the fourth time that sentence has had
      // to be written on this one insert (change_summary/impact_analysis, card_type,
      // gate_terms, now these two), which is why both halves land in one change.
      //
      // Gated on `.length`, exactly like `gate_terms` and for the same reason: the
      // whole finding is that an ABSENT key and an EMPTY array are different facts.
      // An absent or empty value must leave the jsonb BYTE-IDENTICAL to today, so
      // every existing producer's row is unchanged and a future reader can still tell
      // "no questions were asked" from "questions were asked and stripped".
      ...(validated.open_questions?.length ? { open_questions: validated.open_questions } : {}),
      ...(validated.rationale ? { rationale: validated.rationale } : {}),
      // See the schema note on `block_reason_class` (ncn#1956 tripwire counts pending rows by
      // `metadata->>'block_reason_class'`). Truthiness-gated like its siblings, so an absent
      // or blank class is ABSENT from the jsonb — never `null` or the string "undefined",
      // which the tripwire would count as a class of its own.
      ...(validated.block_reason_class ? { block_reason_class: validated.block_reason_class } : {}),
      // COVERAGE: the criteria a decider signs off per criterion (see the schema note).
      ...(validated.metadata?.coverage_request
        ? { coverage_request: validated.metadata.coverage_request }
        : {}),
      // The bug-fix authorization marker (see the schema note). Spread only when present,
      // so every other producer's row stays byte-identical.
      ...(validated.metadata?.approval_kind
        ? { approval_kind: validated.metadata.approval_kind }
        : {}),
      recipient: validated.recipient,
      // Mirrors `approver_source`: says HOW the requester was derived, so a NULL
      // requester_id reads as "no project to attribute this to" rather than as the
      // old "this route never set the field" — the two used to be the same row.
      requester_source: requesterId ? 'project_owner' : 'unattributable',
      // Mirrors `requester_source` exactly, one column over. A NULL `project_id`
      // used to be a single undifferentiated value covering four distinct findings;
      // this says WHICH. `stream_only` is the correct null (1,282 of 1,285 pending
      // rows on prod 2026-09-07); `board_unknown` is a board fr cannot resolve at
      // all (3 rows) and is REFUSED into its own value rather than guessed into a
      // project or quietly folded in with the correct ones. See the resolver.
      project_source: projectRef.source,
      approver_source: routing.approver?.source,
      approver_channels: routing.approver?.channels,
      ...(advancePhase ? { advance_phase_on_approve: advancePhase } : {}),
      // U3: ONLY the typed per-kind output of resolveU3Mint, spread LAST so the strictly
      // validated coverage_request replaces any lenient copy (after fr#1333's passthrough).
      ...(u3 ? u3.metadata : {}),
      // U3 bug-fix gate: ONLY the validated marker + report/bug fields, spread LAST.
      ...(bugFixAuth ?? {}),
    },
    status: 'pending',
    expires_at: expiresAt,
  };

  // Unmarked: exactly mintOneOpenGate. Marked: the onConflict re-read is a dedupe only for
  // the SAME request (same strict equality as the pre-check above), else 409.
  const { gate: approval, deduplicated: gateWasDeduplicated } = await mintGateOnePerBugCard(
    { tenantId, cardId: validated.card_id, values: gateValues },
    bugFixAuth,
  );
  if (gateWasDeduplicated && validated.card_id) {
    // Same envelope the pre-check returns, for the same reason: a race is not a
    // different outcome, only the same one discovered later — and so the SAME kind/identity
    // check (movies-f1 finding: the re-read handed back whatever gate won, of any kind).
    assertU3DedupeCompatible(u3, approval);
    assertArtifactRefDedupeCompatible(approval, artifactRef);
    console.warn(describeSuppression('webhooks', validated.card_id, approval));
    if (callbackUrl) await attachApprovalCallbackUrl(approval.id, tenantId, callbackUrl);
    return jsonResponse({ approval_id: approval.id, deduplicated: true });
  }

  if (!approval) {
    throw new Error('Failed to create card approval');
  }

  if (callbackUrl) await attachApprovalCallbackUrl(approval.id, tenantId, callbackUrl);

  // ⚠️ THE ROSTER IS NOT DECORATION — WITHOUT IT THE APPROVAL CAN NEVER COMPLETE.
  // handleUpdateApproval finalises on
  //   allDecisions.length === allRequiredApprovers.length && every(approved)
  // so an approval with ZERO roster rows and ONE approval decision compares 1 === 0,
  // stays `pending` forever, and never fires deliverDecisionCallback — i.e. the human answers
  // and the card still does not move. Naming the approver in `approver_user_id` alone
  // would have produced exactly that: a gate that finally reaches a person and then
  // ignores them. `role` mirrors the sibling n8n route's roster rows.
  await db
    .insert(requiredApprovers)
    .values({
      tenant_id: tenantId,
      approval_id: approval.id,
      user_id: routing.approver!.userId,
      role: 'card_approver',
    })
    .onConflictDoNothing();

  // ── DELIVERY ───────────────────────────────────────────────────────────────────
  // The ws broadcast stays: it drives live badges in an open UI, and it is the reason
  // the old path LOOKED wired. It is no longer the only thing that happens.
  const recipients: { channel: string; address: string }[] = [
    { channel: 'websocket', address: 'broadcast' },
  ];

  notificationService.fanOut(
    { ...approval, metadata: approval.metadata as Record<string, any> },
    recipients,
  ).catch(err => console.error('[webhooks] Card-approval fan-out error:', err));

  // The per-user fan-out is the half that was missing. fanOutToUser reads the
  // approver's enabled prefs and writes one engagement_deliveries row per attempt.
  // AWAITED on purpose: `notified_at` must be a MEASUREMENT, not an intention.
  // Optimistically stamping it here would recreate the exact ambiguity this change
  // deletes — an approval that expires unread would again be indistinguishable from
  // one a human saw and declined to answer.
  if (routing.approver) {
    await notificationService
      .fanOutToUser(
        { ...approval, metadata: approval.metadata as Record<string, any> },
        routing.approver.userId,
        'approval',
      )
      .catch((err) => console.error('[webhooks] per-user fan-out error:', err));

    // Did any PUSH channel actually accept it? An `inapp` row marked sent is not a
    // human being told (43 such rows produced 0 answers), so it must not satisfy this.
    //
    // The body of this check now lives in `confirmPushDelivery` because the OTHER
    // approval-creation path (`routes/execution-approvals.ts`, kind
    // `execution.ready_signoff`) never had it — every signoff approval carried
    // `notified_at = NULL` whether or not Telegram took it, and the expiry worker
    // then blamed a routing failure it had never checked. One function, both callers,
    // so the two cannot drift apart again.
    // P1-TEAM-b: every member of the tenant is told too. (v4 `sub.ask_fr` questions mint
    // through `POST /api/execution/approvals`, which fans out the same way.) Before the
    // confirmation, so a member's push delivery counts as the gate having reached a human.
    await fanOutApprovalToTenantMembers({
      approval: { ...approval, metadata: approval.metadata as Record<string, any> },
      tenantId,
      alreadyNotified: [routing.approver.userId],
      context: 'webhooks',
    });

    const notified = await confirmPushDelivery(approval.id, 'webhooks');
    if (!notified) {
      console.error(
        `[webhooks] approval ${approval.id} unconfirmed for ${routing.approver.userId} ` +
          `(channels: ${routing.approver.channels.join(',')})`,
      );
    }
  }

  console.log(
    `[webhooks] Created card approval ${approval.id} for card ${validated.card_id} ` +
      `-> ${routing.approver?.userId ?? 'NOBODY'} (${routing.approver?.source ?? 'unrouted'}, ` +
      `verdict=${verdict})`,
  );

  return createdResponse({
    approval_id: approval.id,
    card_id: validated.card_id,
    status: 'pending',
    artifact_ref: approval.artifact_ref ?? null,
    expires_at: expiresAt ? expiresAt.toISOString() : null,
  });
}

// Validation schema for the AA router's atomic dedupe claim.
//
// ⚠️ COMPATIBILITY WINDOW — BOTH FIELD NAMES ARE ACCEPTED, ON PURPOSE.
//
// The scope segment of the dedupe key used to be called `tenant_id`, which was
// a lie: the router sends `String(ev.keycloak_tenant_id || ev.boardId)`, and
// both arms are PLANKA ids. Migration 102 renames the column to
// `planka_scope_id`. But fr and the n8n router deploy INDEPENDENTLY: the n8n AA
// router node `atomic-dedupe-fr` (n8n_custom_nodes/workflows/router.json) still
// posts `tenant_id`, and it is a separate repo on a separate release. Accepting
// only the new name would 400 every dedupe claim from the moment this deploys
// until that workflow is re-imported — and because the router calls this with
// onError:continue, the failure would be SILENT: routing would degrade back to
// the best-effort staticData guard, i.e. exactly the concurrent-TOCTOU hole this
// endpoint exists to close, with nothing in the router's output to say so.
//
// So: `planka_scope_id` is the canonical field, `tenant_id` is accepted as a
// deprecated alias, and exactly one of the two must be present (a body with
// NEITHER is still a hard 400 — the compatibility window must not become a way
// to write a NULL scope). Drop the alias only after router.json is updated and
// deployed.
//
// ── `dedupe_eligible`: OPTIONAL, AND AN ABSENT FIELD MEANS `true`. STATED, NOT
//    IMPLIED. ────────────────────────────────────────────────────────────────
//
// This endpoint is now the andon brake for EVERY routed event, including the ones
// that must never be deduped (comment commands — `!block` / `!unblock` /
// `!escalate` — which the router marks `dedupe_eligible: false`; see the block in
// `handleN8nRouterDedupe`). So the field is a request-contract addition, and the
// only interesting question is what an ABSENT one means. There were three
// candidates and two of them are wrong in ways worth writing down:
//
//   * 400 on absence — WRONG. Every caller alive today omits it (the router node
//     `atomic-dedupe-fr` posts four fields), so this would 400 every dedupe claim
//     in the estate from the moment it deploys. And because the router calls with
//     onError:continue, the 400s would be SILENT: routing degrades straight back
//     to the staticData TOCTOU hole, which is the exact failure mode the
//     `tenant_id` alias above exists to avoid. Same trap, second field.
//   * default `false` — WRONG, AND WORSE. It is a silent behaviour change on
//     today's callers: they would stop claiming dedupe keys altogether, so the
//     cascade suppression this endpoint exists for would evaporate with every
//     reply still reading `{duplicate:false}` — a green answer for a dead
//     mechanism, fleet-wide, with nothing to detect it.
//   * default `true` — CHOSEN. It is byte-identical to today for today's callers,
//     and it CANNOT weaken the brake, because eligibility is consulted only AFTER
//     the cord has already answered and only decides whether a claim is written.
//     The permissive default therefore buys compatibility on the dedupe axis and
//     concedes nothing on the safety axis. An explicit `false` is the only way to
//     get the no-claim path, which is what the n8n change will send.
//
// ⚠️ A non-boolean `dedupe_eligible` is still a hard 400 (zod). Only ABSENCE is
// defaulted; a caller that sends `"false"` as a string gets told, rather than
// quietly treated as eligible.
const N8nRouterDedupeSchema = z
  .object({
    planka_scope_id: z.string().min(1).optional(),
    /** @deprecated legacy alias for `planka_scope_id` — see the note above. */
    tenant_id: z.string().min(1).optional(),
    card_id: z.string().min(1),
    list_id: z.string().min(1),
    updated_at_sec: z.number().int(),
    /**
     * Whether this event may claim a dedupe key. Absent === `true` (see above).
     * `false` is how the router routes an event through the andon brake WITHOUT
     * deduping it — comment commands, which are one deliberate action each and
     * must never be suppressed as a cascade duplicate.
     */
    dedupe_eligible: z.boolean().optional(),
    /**
     * OPTIONAL, ADDITIVE: the Planka board the moved card sits on. When it is a
     * digit string the reply carries `board_tenant_id` — see
     * `routerDedupeBoardTenantFields`. Typed `unknown` ON PURPOSE: anything that
     * is not a digit string is IGNORED, never a 400. The router calls this with
     * onError:continue, so a 4xx on an advisory field would silently degrade
     * every dedupe claim back to the staticData guard — the same trap the
     * `tenant_id` alias and the `dedupe_eligible` default document above.
     */
    board_id: z.unknown().optional(),
  })
  .refine((b) => b.planka_scope_id !== undefined || b.tenant_id !== undefined, {
    message: 'planka_scope_id is required (legacy alias `tenant_id` also accepted)',
    path: ['planka_scope_id'],
  })
  .transform((b) => ({
    // Non-null by the refine above. The new name wins if a caller sends both.
    planka_scope_id: (b.planka_scope_id ?? b.tenant_id) as string,
    card_id: b.card_id,
    list_id: b.list_id,
    updated_at_sec: b.updated_at_sec,
    // ⛔ The default is `true` and it is load-bearing for today's callers. Do not
    // "tighten" it to `false` or to required without updating router.json in the
    // same breath — the reasoning is in the block above.
    dedupe_eligible: b.dedupe_eligible ?? true,
    // Digit string or nothing. Planka ids are 64-bit snowflakes, so a JSON
    // NUMBER is ignored too (it has already lost precision by the time we see it).
    board_id:
      typeof b.board_id === 'string' && /^\d+$/.test(b.board_id) ? b.board_id : undefined,
  }));

/**
 * The `board_tenant_id` reply field for an explicit `board_id`.
 *
 * WHY IT EXISTS. The n8n router resolves a card's tenant from card Metadata
 * (written seconds AFTER cardCreate) or a single-tenant-board heuristic, so a
 * fresh card on a customer PROJECT board routes with no tenant at all. fr owns
 * the board -> tenant mapping and this call is already on the router's path, so
 * answering it here costs no new round trip.
 *
 * ONE RULE, NOT TWO. Each project row's tenant is `tenantFromProjectRow` — the
 * SAME function `resolveCardApprovalTenant` applies — run in JS over a row
 * loaded by the SAME drizzle select/join the resolver uses, so `project_data`
 * is jsonb-decoded identically (a raw `queryClient` read does NOT decode a
 * double-encoded value the way drizzle does, and once leaked a stream's tenant
 * where the resolver answered the project's). It is deliberately NOT
 * re-expressed in SQL: a `->>` read turns a JSON
 * `0`/`false` into the strings "0"/"false" and an object into its JSON text,
 * where `tenantFromProjectRow` answers null (or the value itself). A second
 * spelling of a tenant rule is a second tenant rule. Streams use the
 * resolver's stream fallback as-is (`tenant_id ?? null`; the column is
 * `uuid NOT NULL`).
 *
 * ⛔ WHY NOT JUST CALL THE RESOLVER. `projects.planka_board_id` has no UNIQUE
 * constraint and the resolver reads `.limit(1)` with no ORDER BY, so two
 * projects on one board resolve by heap order, and a tenantless project falls
 * through to a stream's tenant. Tolerable for its existing callers; here the
 * answer becomes the card's X-Tenant-ID in the router, so a wrong pick is a
 * cross-tenant write. So ALL rows are read and the answer is given only when
 * they cannot disagree:
 *
 *   (0)   any project row whose decoded `project_data` is not a plain object
 *         (string, array, number, null) -> null
 *         (`unexpected_project_data_shape`). Fail closed: the resolver would
 *         read such a row as tenantless (or use its dept tenant); this helper
 *         does not guess;
 *   (i)   a project row with no tenant beside one WITH a tenant -> null
 *         (`project_tenantless_mixed`);
 *   (ii)  project rows naming >1 distinct tenant -> null
 *         (`project_tenants_disagree`). Exact comparison: case variants of one
 *         uuid are two tenants;
 *   (iii) one project tenant and a stream on the board with a DIFFERENT tenant
 *         -> null (`stream_disagrees_with_project`);
 *   (iv)  no project rows, or only tenantless ones (the resolver's own
 *         fall-through) -> the streams alone: 0 -> null, 1 -> it, >1 -> null
 *         (`stream_tenants_disagree`);
 *   (v)   otherwise the single tenant. With exactly one project row and no
 *         disagreeing stream this equals `resolveCardApprovalTenant(undefined,
 *         board)` — pinned by a parity test.
 *
 *   * no (or a non-digit) `board_id` -> `{}`: the reply is byte-identical to
 *     before this field existed.
 *   * a board fr does not own, or whose rows carry no tenant ->
 *     `{board_tenant_id: null}`.
 *   * null-because-ambiguous logs a warning with the board id and a reason code
 *     only (never a tenant).
 *   * OUTPUT BOUNDARY: whatever (v) resolves is emitted only if it is a
 *     canonical uuid string (`isUuidShape`, case-insensitive, emitted as
 *     stored). An object or whitespace tenant — which `tenantFromProjectRow`
 *     returns as-is — becomes null with reason `invalid_tenant_shape`. So the
 *     parity in (v) holds for uuid-shaped and null answers only.
 *   * the lookup THROWS -> `{board_tenant_id: null}` and a warning. Advisory
 *     only: a tenant hint must never be able to fail a dedupe claim.
 */
async function routerDedupeBoardTenantFields(
  boardId: string | undefined,
): Promise<{ board_tenant_id?: string | null }> {
  if (boardId === undefined) return {};
  try {
    const resolved: unknown = await resolveUnambiguousBoardTenant(boardId);
    // OUTPUT BOUNDARY. The router sends this value as X-Tenant-ID, so only a
    // canonical uuid string leaves (case-insensitive shape, emitted exactly as
    // stored). `tenantFromProjectRow` can hand back an object or a whitespace
    // string (kept there for resolver parity); neither is a tenant. Log the
    // board and a reason code, never the value.
    if (resolved !== null && !isUuidShape(resolved)) {
      console.warn(
        `[webhooks] router-dedupe board ${boardId} board_tenant_id withheld: invalid_tenant_shape`,
      );
      return { board_tenant_id: null };
    }
    return { board_tenant_id: resolved };
  } catch (err) {
    console.warn(`[webhooks] router-dedupe could not resolve a tenant for board ${boardId}:`, err);
    return { board_tenant_id: null };
  }
}

async function resolveUnambiguousBoardTenant(boardId: string): Promise<string | null> {
  // PROJECT rows are loaded through the SAME drizzle select/join as
  // `resolveCardApprovalTenant` (minus `.limit(1)`), NOT a raw `queryClient`
  // query. That is load-bearing: drizzle's jsonb `mapFromDriverValue`
  // JSON.parses a value postgres.js hands back as a string, so a DOUBLE-ENCODED
  // `project_data` (a jsonb string containing JSON) decodes to an object for the
  // resolver but stays a string on a raw read. A raw read therefore saw such a
  // project as tenantless, fell through to a stream on the board, and emitted
  // the STREAM's tenant while the resolver answered the project's — a
  // cross-tenant hint. Same query builder, same column type => same decode.
  const rows = await db
    .select({
      tenant_id: departments.workspace_id,
      project_data: projects.project_data,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.planka_board_id, boardId));
  const streamRows = await db
    .select({ tenant_id: streams.tenant_id })
    .from(streams)
    .where(eq(streams.planka_board_id, boardId));

  const withheld = (reason: string): null => {
    console.warn(
      `[webhooks] router-dedupe board ${boardId} board_tenant_id withheld: ${reason}`,
    );
    return null;
  };

  const streamTenants = new Set<string>();
  for (const s of streamRows) {
    // The resolver's stream fallback, verbatim: `tenant_id ?? null`.
    const t = s.tenant_id ?? null;
    if (t !== null) streamTenants.add(t);
  }

  const fromStreams = (): string | null => {
    if (streamTenants.size > 1) return withheld('stream_tenants_disagree');
    return streamTenants.size === 1 ? [...streamTenants][0]! : null;
  };
  if (rows.length === 0) return fromStreams();

  // FAIL CLOSED on a project_data shape we do not expect. After the drizzle
  // decode a well-formed row is a plain object; a string (encoded more than
  // twice), an array, a number or null means the row was written by something
  // this reader does not understand, so no tenant is inferred from the board.
  for (const r of rows) {
    const pd: unknown = r.project_data;
    if (pd === null || typeof pd !== 'object' || Array.isArray(pd)) {
      return withheld('unexpected_project_data_shape');
    }
  }

  const projectTenants = new Set<string>();
  let tenantless = 0;
  for (const r of rows) {
    const t = tenantFromProjectRow(r.tenant_id, r.project_data);
    if (t === null) tenantless++;
    else projectTenants.add(t);
  }
  if (tenantless > 0 && projectTenants.size > 0) return withheld('project_tenantless_mixed');
  if (projectTenants.size > 1) return withheld('project_tenants_disagree');
  if (projectTenants.size === 0) {
    // Every project row is tenantless. The resolver would fall through to the
    // stream; with exactly one project row that is still its answer (parity),
    // but only while the streams themselves agree.
    return fromStreams();
  }
  const [tenant] = [...projectTenants];
  for (const st of streamTenants) {
    if (st !== tenant) return withheld('stream_disagrees_with_project');
  }
  return tenant!;
}

/**
 * The refusal codes the router-dedupe brake returns. These are WIRE VALUES: the
 * n8n AA router is built against them (`{routed:false, reason:<code>, duplicate:true}`) and
 * `lib/andon-halt-metrics.ts` uses the same strings as label values. Renaming one
 * is an API change in two repos at once.
 */
type RouterDedupeAndonRefusal = Exclude<AndonHaltOutcome, 'proceeded' | 'other'>;

/*
 * The andon consult the router-dedupe brake performs: `handleGetAndonInternal`.
 *
 * ⭐ IT IS `handleGetAndonInternal`, DELIBERATELY, AND NOT A SECOND DERIVATION.
 * That handler already resolves the four-way distinction this brake needs
 * (`released` / `engaged` / `unreadable` / `uninitialised`) from TWO reads with a
 * documented, test-pinned asymmetry, and it is the same answer fr gives n8n on
 * `GET /api/internal/andon`. Re-deriving it here from `isGlobalAndonEngaged`
 * alone would get a bare boolean that cannot name a reason, and re-deriving it
 * from `readAndon` would build a second, drifting copy of a rule whose comments
 * exist precisely because getting it subtly wrong is easy. One rule, one place;
 * this caller only chooses what to DO with the answer.
 */

/**
 * Ask the global andon cord whether a card move may be dispatched.
 *
 * ⛔ FAIL CLOSED: `'proceed'` is returned ONLY for an EXPLICIT release — a
 * definite `engaged:false` whose reason is `released`. Everything else refuses,
 * including an absent singleton and a consult that throws. This is STRICTER than
 * `GET /api/internal/andon` itself, which answers `engaged:false` for an
 * uninitialised singleton, and the difference is intentional and owner-ruled: the
 * interlock's job is to report what the cord says, this brake's job is to not
 * dispatch work when nobody can say the cord is released. Do not "reconcile" the
 * two by making this permissive — that inverts the brake.
 *
 * ⚠️ AVAILABILITY CONSEQUENCE, STATED RATHER THAN DISCOVERED: because this runs
 * on the ONE synchronous call every Planka card move makes, an fr blip — a DB
 * failover, an OOM-killed pod, a bad deploy — halts AA dispatch FLEET-WIDE for
 * its duration, and a halted conveyor looks exactly like an idle one. The
 * workflow-programme owner accepted that trade under "the brake must always
 * work", on the condition that it is PAIRED WITH AN ALERT so a blip pages
 * someone instead of reading as a quiet Monday. That alert is not in this repo:
 * `lib/andon-halt-metrics.ts` exports the series it needs
 * (`fr_andon_brake_total{surface="router_dedupe",outcome=...}`, with
 * `outcome="proceeded"` as the denominator), and the rule belongs in
 * `clusters/prod/services/prometheus/rules-c.yaml`, in a new
 * `fr-andon-brake` group beside the existing `fr-deblock-refusals` /
 * `fr-scheduled-triggers` groups. Two rules: a sustained nonzero rate of
 * `andon_check_failed`/`andon_unreadable` (fr cannot read its own cord), and a
 * sustained ZERO rate of the whole family (the conveyor stopped calling at all,
 * which this counter cannot distinguish from a released cord on its own).
 */
async function consultAndonForRouterDedupe(): Promise<'proceed' | RouterDedupeAndonRefusal> {
  let engaged: unknown;
  let reason: unknown;
  try {
    const res = await handleGetAndonInternal(
      new Request('http://fr.example.com/api/internal/andon', { method: 'GET' }),
    );
    if (res.status !== 200) {
      publishAndonStateForMetrics(null);
      return 'andon_check_failed';
    }
    ({ engaged, reason } = (await res.json()) as { engaged?: unknown; reason?: unknown });
    // ⚠️ THIS GUARD IS BELT-AND-BRACES, NOT THE PROTECTION — and the comment that
    // stood here claimed the opposite. It said that coercing a non-boolean
    // `engaged` to `false` beside a `reason` of `'released'` would publish a
    // CONFIDENT RELEASE. MEASURED FALSE: `publishAndonStateForMetrics` decides
    // KNOWN by STRICT equality on both axes (`engaged === false && reason ===
    // 'released'`, or `=== true && reason === 'engaged'`), so `'false'`, `0`,
    // `null` and `'true'` for `engaged`, and a non-string `reason`, ALREADY fall
    // through to UNKNOWN and emit no `fr_andon_engaged` sample. That strict
    // comparison is what fails closed; this line is not.
    //
    // ⛔ Be precise about what the guard buys, because it is less than it looks:
    // the ONLY thing it changes today is the `reason` string stored in the cache
    // (`andon_check_failed` rather than the drifted value), and that string is
    // deliberately not a label, so it is not observable in the exposition at all.
    // It is kept because it states the verdict LOCALLY — the same verdict the
    // refusal below reaches for a shape nobody can read — instead of depending on
    // a strictness that lives in another module and that a future edit there
    // could relax. Keep it; do not promote it to load-bearing, and never delete
    // the strict comparison in the belief that this line guards the gauge.
    publishAndonStateForMetrics(
      typeof engaged === 'boolean' && typeof reason === 'string' ? { engaged, reason } : null,
    );
  } catch {
    // The consult threw. We do not know the cord state, so we do not start work.
    publishAndonStateForMetrics(null);
    return 'andon_check_failed';
  }

  // ⭐ ONE POLICY, ONE DECIDER (fr#1208). The two axes are normalised by
  // `andonVerdictFromInterlockAnswer` and the proceed/halt call is made by
  // `andonPermitsWork` — both in lib/global-andon-gate.ts, alongside the stated
  // ANDON_GATE_POLICY. This brake was already fail-closed and its behaviour is
  // UNCHANGED by the rewiring; what changed is that it no longer carries its own
  // private copy of the rule, so a future edit cannot make this gate and
  // `isGlobalAndonEngaged` disagree again.
  //
  // ⛔ `engaged === false` is still required IN ADDITION to the reason (the
  // normaliser enforces it). The two axes cannot disagree in the current
  // derivation, but if they ever do, the halt decision must not be read off the
  // descriptive axis alone.
  if (andonPermitsWork(andonVerdictFromInterlockAnswer(engaged, reason))) return 'proceed';
  // Below here is this endpoint's own refusal VOCABULARY, not the policy: the
  // wire codes the router and `fr_andon_brake_total{outcome=...}` are keyed on.
  if (reason === 'engaged') return 'andon_engaged';
  if (reason === 'unreadable') return 'andon_unreadable';
  if (reason === 'uninitialised') return 'andon_uninitialised';
  // A reason this caller does not recognise, or an `engaged` that is not a
  // boolean: the consult and this brake have drifted. Refuse — an unknown
  // answer is not a release.
  return 'andon_check_failed';
}

/**
 * POST /api/webhooks/n8n/router-dedupe
 *
 * Durable ATOMIC dedupe for the AA router's Planka card-move cascade. The n8n
 * router collapses Planka's N-PATCH cardUpdate burst per move via a best-effort
 * $getWorkflowStaticData('global') guard; under truly concurrent router
 * executions a read-before-write TOCTOU lets several events all pass. The router
 * calls this ONLY for events that already passed that guard, to close the race:
 * an INSERT ... ON CONFLICT (planka_scope_id, card_id, list_id, updated_at_sec)
 * DO NOTHING RETURNING means exactly one concurrent caller claims the key (gets a
 * row → `duplicate: false`, proceed routing) and the rest get nothing
 * (`duplicate: true`, suppress). The unique PK IS the atomicity. The router calls
 * with onError:continue, so fr being unreachable degrades to the staticData guard
 * rather than breaking routing.
 *
 * ⭐ IT IS ALSO THE AA CONVEYOR'S ANDON BRAKE, as of this change. The cord is
 * consulted BEFORE the claim is written and a halt answers
 * `{routed:false, reason:<code>, duplicate:true}`; see the block at the top of the
 * body for why the refusal carries `duplicate` as well — without it the DEPLOYED
 * router reads a halt as "not a duplicate" and dispatches the card anyway.
 *
 * ⭐ AND BECAUSE THE BRAKE LIVES HERE, THIS ENDPOINT SERVES EVERY ROUTED EVENT —
 * not only the dedupe-eligible ones. A caller passes `dedupe_eligible: false` for
 * an event that must be braked but must NOT be deduped (comment commands), and
 * gets the cord check with no claim written and `{duplicate:false}` on a release.
 * Three shapes, and they are exhaustive:
 *
 *   cord not definitely released  -> `{routed:false, reason:<code>, duplicate:true}`,
 *                                    0 rows (SAME for eligible and ineligible)
 *   released + dedupe_eligible    -> `{duplicate:boolean}`, 1 row on a first claim
 *   released + !dedupe_eligible   -> `{duplicate:false}`, 0 rows
 *
 * A digit-string `board_id` adds `board_tenant_id: string|null` to BOTH released
 * shapes (first claim, duplicate, and ineligible) and to neither refusal; absent or
 * non-digit, the reply is exactly as above. See `routerDedupeBoardTenantFields`.
 *
 * The eligible path is byte-identical to before this change, including an absent
 * `dedupe_eligible` (which defaults to eligible — see `N8nRouterDedupeSchema`).
 *
 * ⚠️ AND THE ONE THING THIS BRAKE CANNOT DO, SAID PLAINLY: fail-closed here means
 * fail-closed when fr ANSWERS. The sentence above is still true — the router's
 * `onError:continue` means an fr that is UNREACHABLE (pod down, DNS, NetworkPolicy)
 * is not a halt at all; the router falls back to its staticData guard and keeps
 * dispatching. So the brake covers "fr can be reached and cannot confirm a
 * release", not "fr is gone". Closing that last gap is an n8n-side change (treat a
 * failed/timed-out dedupe call as a halt rather than continuing) and belongs with
 * the router work being built against this contract — it is NOT achievable from
 * this file.
 */
export async function handleN8nRouterDedupe(req: Request): Promise<Response> {
  validateWebhookSecret(req);
  const body = await req.json();
  const { planka_scope_id, card_id, list_id, updated_at_sec, dedupe_eligible, board_id } =
    N8nRouterDedupeSchema.parse(body);

  // ── THE GLOBAL ANDON BRAKE — BEFORE THE CLAIM, AND THAT ORDER IS THE FIX ─────
  //
  // ⛔ NOTHING MAY BE WRITTEN TO `router_dedupe` ABOVE THIS BLOCK. The brake used
  // to live in n8n as four nodes DOWNSTREAM of `Atomic Dedupe (fr)`, so by the
  // time the cord halted a card, this endpoint had already claimed the key —
  // and the claim is only reaped at `NOW() - interval '10 minutes'` (see the
  // opportunistic DELETE below). The halt's own remedy, "release the cord, then
  // re-emit the card", was therefore DEAD FOR TEN MINUTES: the re-emitted card
  // hit the surviving claim, came back `duplicate:true`, and the router answered
  // `200 {routed:false, reason:'cascade_dedupe'}` — no dispatch, no error
  // execution, and a reported cause that was not the real one.
  //
  // Checking first does not patch that bug, it DISSOLVES it: a refusal consumes
  // no claim, so the very next re-emit of the same card is the first claimant and
  // dispatches (engaged → refuse → release → re-emit → dispatch).
  //
  // Folded into THIS call rather than added as a new one because fr already makes
  // exactly one synchronous call per card move: the brake costs no extra round
  // trip, no extra latency, and no new workflow nodes (which would also have trip-
  // ped the workflow scorecard ratchet). See `consultAndonForRouterDedupe` above
  // for the fail-closed rule and for the availability trade this buys.
  const brake = await consultAndonForRouterDedupe();
  if (brake !== 'proceed') {
    reportAndonBrakeDecision({
      surface: 'router_dedupe',
      outcome: brake,
      subject_id: card_id,
      detail: { planka_scope_id, list_id, updated_at_sec },
    });
    // 200, not 409: the router calls this with onError:continue and the n8n
    // modules retry on `status >= 500`, so a halt must be an ANSWER it reads,
    // not an error it retries or silently swallows. `routed:false` is the
    // existing suppression vocabulary; the `reason` names WHY, which the old
    // `cascade_dedupe` lie could not.
    //
    // ⭐ `duplicate: true` IS A COMPATIBILITY KEY AND IT IS WHAT MAKES THE BRAKE
    // ACTUALLY BRAKE. Without it this refusal was INERT IN PRODUCTION, measured
    // against the LIVE workflow rather than reasoned about: `AA Router - Global`
    // (`gktduLrpeU6HS3Ku`, active) reads the reply with exactly
    //
    //     if (resp && resp.duplicate === true) is_duplicate = true;
    //
    // and nothing else. `routed` and `reason` are keys it has never heard of, so a
    // refusal left `is_duplicate` FALSE, the `Is Duplicate?` IF node took its
    // output-1 branch, and the card WAS DISPATCHED — an engaged emergency cord
    // that dispatched anyway, with a 200 and no error execution to show for it.
    // The consumer that understands `routed` lives in n8n_custom_nodes PR #1658,
    // which is OPEN AND UNDEPLOYED; `origin/main`'s router.json contains zero
    // andon nodes. So the deployed reader is the one this reply must satisfy.
    //
    // ⛔ AND IT WAS WORSE THAN INERT — IT INVERTED THE GUARANTEE. This endpoint is
    // the CONCURRENT backstop the router's staticData guard cannot be: exactly one
    // caller of an N-event burst claims the key and the rest are told
    // `duplicate:true`. A refusal writes NO claim (which is correct, and is what
    // makes the release-then-re-emit remedy work), so with `duplicate` absent EVERY
    // event of the burst read as "not a duplicate". Pulling the cord therefore
    // turned 1 dispatch per card move into N. The brake did not slow the conveyor
    // down, it multiplied it.
    //
    // WHAT EACH CONSUMER DOES WITH THIS EXACT BODY:
    //   * TODAY'S LIVE ROUTER — reads `duplicate:true`, sets `is_duplicate`, takes
    //     `Is Duplicate?` output 0 → `Response (Deduped)`, a TERMINAL node. Nothing
    //     is dispatched and `Route by Event` is never reached. Its own answer is
    //     `{received:true, routed:false, reason:'cascade_dedupe'}`, because that
    //     node hard-codes `cascade_dedupe` for any non-demo suppression. So the
    //     reason it reports is MISLEADING BUT SAFE: the routing claim (`routed:
    //     false`) is TRUE and the decision is the one we want; only the CAUSE is
    //     mis-attributed, and the true cause is not lost — fr counts it here as
    //     `fr_andon_brake_total{surface="router_dedupe",outcome=<code>}`. It is the
    //     same imprecision the pre-#1658 estate already had, now attached to a
    //     card that is genuinely held rather than one that slipped through.
    //     (It does not reach `Tee to Bounce Recorder` either — that tee sits on the
    //     NOT-duplicate branch, so a braked move logs no phantom bounce.)
    //   * PR #1658's ROUTER — tests `resp.routed === false` BEFORE it looks at
    //     `duplicate`, and normalises `reason` against its four known codes. It
    //     therefore still gets the precise cause and throws `ANDON_HALT reason=…`;
    //     `duplicate` is dead weight it never reads. Adding the key cannot regress
    //     it, and its `typeof resp.duplicate !== 'boolean'` arm is only consulted
    //     on a non-refusal.
    //
    // ⛔ DO NOT "SIMPLIFY" THIS TO A PLAIN `{duplicate:true}`. The `reason` is the
    // only thing that can tell an operator a cord halt from a cascade collapse, it
    // is what #1658 branches on, and it is the label value the metric carries. Nor
    // is `duplicate` a lie to be removed later: it says "suppress this event", which
    // is exactly what a halt means to a reader that has no halt vocabulary. Remove
    // it only once no deployed router reads `duplicate` without first reading
    // `routed` — i.e. after #1658 is merged AND baked AND active.
    //
    // `board_tenant_id` is deliberately NOT on this path: a refused event is not
    // dispatched, so a tenant hint has no reader, and the refusal must never wait
    // on (or depend on) a board lookup — `andon_check_failed` is often a DB that
    // is already failing.
    return jsonResponse({ routed: false, reason: brake, duplicate: true });
  }
  reportAndonBrakeDecision({ surface: 'router_dedupe', outcome: 'proceeded', subject_id: card_id });

  // ── EVERY ROUTED EVENT IS BRAKED; ONLY SOME OF THEM ARE DEDUPED ─────────────
  //
  // ⭐ THIS BRANCH SITS BELOW THE BRAKE, AND THAT IS THE WHOLE POINT OF IT. The
  // brake above is UNCONDITIONAL — it runs before this file has looked at
  // `dedupe_eligible` at all, before the schema's value is even read. Putting the
  // cord check behind an eligibility test is precisely the hole this change
  // closes, so if you ever find yourself writing `if (dedupe_eligible)` around the
  // consult, stop: an INELIGIBLE event must be refused with `andon_engaged`.
  //
  // ⛔ THE HOLE, NAMED. Comment commands (`!block` / `!unblock` / `!escalate`) are
  // `dedupe_eligible: false`: each is one deliberate operator action, never an
  // N-PATCH cascade, so suppressing a repeat as a "duplicate" would eat a real
  // command. Under the previous design that meant the router never called this
  // endpoint for them at ALL — and since the cord lives in this call, the andon
  // brake did not brake comment commands. An earlier design consulted the cord at
  // the router's dominating node and covered both branches; folding the check in
  // here lost that. Serving ineligible events from this same endpoint gets it
  // back without reintroducing a second consult site (one cord, one caller).
  //
  // ⛔ AND NO COMMAND IS SPECIAL-CASED. `!block` during an engaged cord is
  // arguably harmless — it engages a brake on a conveyor that is already braked —
  // and it is STILL refused here. Owner-ruled, and the reason is the property
  // rather than the instance: a uniform brake is a fact you can state about the
  // system ("an engaged cord dispatches nothing"), while a brake with a
  // hand-curated exemption list is a claim you must re-audit every time a command
  // is added. The refusal is cheap to recover from — release the cord, re-issue
  // the command — because, exactly as for the eligible path, a refusal consumes no
  // claim.
  //
  // Returning `{duplicate:false}` (not `{routed:false}`) is deliberate: the cord
  // is RELEASED, so this is a proceed, and the router's downstream branch reads
  // `duplicate` to decide whether to dispatch. An ineligible event is never a
  // duplicate, by definition — it has no key to collide with.
  //
  // ⚠️ It also returns BEFORE the attribution and the opportunistic reap below,
  // which is correct on both counts: there is no claim to attribute, and the reap
  // is sampled at ~1% OF CLAIMS — running it on no-claim traffic would change that
  // denominator as soon as n8n starts sending comment commands here.
  if (!dedupe_eligible) {
    return jsonResponse({
      duplicate: false,
      ...(await routerDedupeBoardTenantFields(board_id)),
    });
  }

  const claimed = await queryClient<{ card_id: string }[]>`
    INSERT INTO router_dedupe (planka_scope_id, card_id, list_id, updated_at_sec)
    VALUES (${planka_scope_id}, ${card_id}, ${list_id}, ${updated_at_sec})
    ON CONFLICT (planka_scope_id, card_id, list_id, updated_at_sec) DO NOTHING
    RETURNING card_id
  `;

  // Attribution runs AFTER the claim, deliberately. The INSERT ... ON CONFLICT
  // above IS the atomicity this endpoint exists for; putting a lookup in front
  // of it would widen the window it closes. Best-effort — a metering tag must
  // never be able to fail a dedupe claim, because the router calls this with
  // onError:continue and a failure here degrades routing SILENTLY back to the
  // staticData TOCTOU hole.
  try {
    meterToResolvedTenant(await resolveRouterDedupeTenant(planka_scope_id));
  } catch (err) {
    console.warn(
      `[webhooks] router-dedupe could not resolve a tenant for scope ${planka_scope_id}:`,
      err,
    );
  }

  // Opportunistic reap (~1% of calls): a dedupe claim is only meaningful for the
  // ~60s cascade window, so rows past it are dead weight. Indexed DELETE keeps the
  // table bounded without a separate sweep. Best-effort — never blocks the claim.
  if (Math.random() < 0.01) {
    try {
      await queryClient`DELETE FROM router_dedupe WHERE created_at < NOW() - interval '10 minutes'`;
    } catch {
      // ignore — reaping is opportunistic
    }
  }

  // Resolved AFTER the claim for the same reason as the attribution above, and
  // on BOTH the first-claim and the duplicate reply.
  return jsonResponse({
    duplicate: claimed.length === 0,
    ...(await routerDedupeBoardTenantFields(board_id)),
  });
}
