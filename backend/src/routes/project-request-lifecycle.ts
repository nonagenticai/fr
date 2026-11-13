// src/routes/project-request-lifecycle.ts
//
// THE TWO-STAGE PROJECT REQUEST: submit -> analyse -> outline -> decide -> promote.
//
// ── WHAT THIS FILE ADDS ──────────────────────────────────────────────────────
//
// Until migration 123 a request became a project the instant a human clicked
// approve (routes/project-requests.ts handleApproveProjectRequest). There was
// no state in which an agent could look at the request and propose WHAT the
// project should be. This file is that state machine:
//
//   draft|failed --submit-->  submitted  --dispatch-->  analysing
//   submitted|analysing|outline_proposed --outline webhook--> outline_proposed
//   outline_proposed --outline approved--> approved --promote--> promoted|failed
//   outline_proposed --outline rejected--> submitted   (awaits a NEW outline)
//
// `approved` means OUTLINE AGREED, PROJECT NOT YET CREATED. It is a real,
// observable state rather than an instant, because promotion can fail (Planka,
// the andon, an invalid payload) and a failed promotion must leave evidence that
// the outline itself WAS agreed.
//
// ── WHY THE DECISION REUSES `approvals` ─────────────────────────────────────
//
// The outline CONTENT lives in `project_outlines` (named columns, versioned).
// The DECISION is an ordinary `approvals` row of kind `project_outline.approval`
// hanging off `project_request_id` instead of `project_id` (there is no project
// yet — that is the point of the stage). Reusing approvals buys, for free, the
// decision record (`approval_decisions`), the optimistic lock on decide, the WS
// broadcast, the approvals inbox, and `voidApprovals`. A second, parallel
// decision mechanism would have to re-grow every one of those and would drift.
// The approvals decision path calls `onOutlineDecided` below after it commits a
// decision; that is the ONLY coupling.
//
// ── WHY EVERY STATUS WRITE IS CONDITIONAL ────────────────────────────────────
//
// Every transition UPDATE carries `WHERE status IN (<allowed from>)` and treats
// zero returned rows as a lost race (409), rather than trusting the status it
// SELECTed a moment earlier. An agent delivering an outline while the requester
// withdraws, or a fast agent answering before the dispatch-ack write lands, are
// the ordinary case here, not the unlucky one. Same reason every audit-trail
// append goes through `appendHistorySql` (a SQL-side append): a read-modify-write
// of the history array loses entries under exactly this concurrency.

import { conveyorIsConfigured, conveyorNotConfiguredResponse } from '../lib/conveyor-configured-gate';
import { CONVEYOR_NOT_CONFIGURED_CODE } from '../config';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, projectRequests, approvals, requiredApprovers, projects } from '../db/client';
// ⚠️ `projectRequestRepositories` used to be imported here and was DEAD — the
// table had no writer anywhere. It is now reached through
// ./project-request-repo-gate, the single owner of that table's reads and writes.
import { projectOutlines } from '../db/schema';
import {
  ProjectCreateSchema,
  ProjectOutlineSchema,
  type OutlineDeliverable,
  type ProjectOutlineInput,
} from '../types/api';
import { deadlineFromHours } from '../lib/approval-deadline';
import {
  scanOutlineForContradictions,
  renderContradictionsForApproval,
} from '../services/outline-constraint-scan';
import { appendHistorySql } from './project-request-history';
import {
  loadOwnedRequest,
  promoteProjectRequest,
  cancelPreApprovalProject,
  requestCoordinationMode,
  FR_REPO_SENTINEL,
} from './project-requests';
import { voidApprovals } from '../lib/void-approvals';
import { clientSafeCaughtErrorText, reportSwallowedFailure } from '../integrations/_lib/errors';
import { resolveSignoffStakeholderIds } from '../lib/execution-signoff';
import {
  PHASE_PLAN_GATE_UNKNOWN,
  PhasePlanSchema,
  phasePlanHash,
  planGateUnknownSlugs,
  planPhasesOutsideType,
  PHASE_PLAN_PHASE_NOT_IN_TYPE,
  proposedPlanView,
  storedPhasePlan,
  type ProposedPlanView,
} from '../lib/phase-plan';
import { n8nClient } from '../services/n8n';
import { validateWebhookSecret } from '../utils/webhook-secret';
import { isUuidShape } from '../lib/uuid-shape';
import { AppError, BadRequestError, NotFoundError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { phaseTitles, typePhases } from '../services/catalogue/tenant-catalogue';
import { emitSpan } from '../telemetry/spans';
import {
  collectRequestRepoUrls,
  loadRequestRepositories,
  platformRepoRefusalResponse,
  replaceRequestRepositories,
  repoAccessGateResponse,
} from './project-request-repo-gate';

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests/unit/routes/project-request-lifecycle.test.ts
// (the unit suite has no database, so the state machine is tested here, not
// through the handlers).
// ---------------------------------------------------------------------------

export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'analysing',
  'outline_proposed',
  'approved',
  'promoted',
  'rejected',
  'withdrawn',
  'failed',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * The WHERE clause of each EVENT. Keyed by event, not by target status, on
 * purpose: `submitted` is the target of both SUBMIT (from draft|failed) and an
 * outline REJECTION (from outline_proposed). Deriving the submit guard from the
 * target would let a requester "re-submit" a request whose outline is awaiting
 * a decision, silently orphaning the live approval.
 */
export const EVENT_SOURCES = {
  submit: ['draft', 'failed'],
  outline: ['submitted', 'analysing', 'outline_proposed'],
  outline_decided: ['outline_proposed'],
  // workers/project-request-analysis-timeout.ts: no outline arrived within the TTL.
  analysis_timeout: ['analysing'],
  // The requester takes their own request back, before anything was decided.
  // Not `approved` (promotion is under way; withdrawing would race a
  // half-created project) and not `failed` (re-submitted or rejected instead).
  // `withdrawn` is terminal, like `promoted` and `rejected`.
  withdraw: ['draft', 'submitted', 'analysing', 'outline_proposed'],
} as const satisfies Record<string, readonly RequestStatus[]>;
export type LifecycleEvent = keyof typeof EVENT_SOURCES;

export function eventSources(event: LifecycleEvent): RequestStatus[] {
  return [...EVENT_SOURCES[event]];
}

/** Next outline version: max+1, 1 for the first. Gaps are preserved, never reused. */
export function nextOutlineVersion(existingVersions: readonly number[]): number {
  let max = 0;
  for (const v of existingVersions) {
    if (Number.isInteger(v) && v > max) max = v;
  }
  return max + 1;
}

interface OutlineDecisionEffect {
  /** New outline status, or null = leave the outline as it is. */
  outlineStatus: 'approved' | 'rejected' | null;
  /** New request status, or null = leave the request as it is. */
  requestStatus: 'approved' | 'submitted' | null;
  historyAction: string;
  /** True only when the outcome should go on to create the project. */
  promote: boolean;
}

/**
 * What a decided outline approval does to the outline and the request.
 * Anything that is not approved/rejected (expired, voided, a future status)
 * changes nothing but is still RECORDED — a decision path that silently
 * ignores an outcome is one nobody can later explain.
 */
export function outlineDecisionEffect(approvalStatus: string): OutlineDecisionEffect {
  if (approvalStatus === 'approved') {
    return {
      outlineStatus: 'approved',
      requestStatus: 'approved',
      historyAction: 'outline_approved',
      promote: true,
    };
  }
  if (approvalStatus === 'rejected') {
    return {
      outlineStatus: 'rejected',
      requestStatus: 'submitted',
      historyAction: 'outline_rejected',
      promote: false,
    };
  }
  return {
    outlineStatus: null,
    requestStatus: null,
    historyAction: `outline_decision_${approvalStatus}`,
    promote: false,
  };
}

export const OUTLINE_APPROVAL_KIND = 'project_outline.approval' as const;

/**
 * `required_approvers.role` for an outline approval's roster. Must NOT be a
 * realm role (card_approver, execution_signoff, …): the role arm of
 * approverIdentityFilter would then admit every holder of it, not just the
 * people the request named. Migration 124 backfills with the same value.
 */
const OUTLINE_APPROVER_ROLE = 'outline_approver' as const;

/**
 * `metadata.card_type` for an outline approval.
 *
 * An outline approval gates no Planka card — `card_id` is NULL and
 * `callback_path` is NULL — so this is a LABEL, and the approvals UI and the
 * re-delivery digest are its only readers. It is written anyway because a row
 * carrying neither `card_type` nor `gate_terms` says nothing about what is
 * being asked, which is one of the four unanswerable-by-construction shapes
 * `lib/approval-answerability.ts` counts.
 *
 * ⚠️ IT CANNOT BECOME A PHASE SIGNAL, and that is structural rather than
 * lucky: the approval-completion phase advance (deleted, fr#1481) (services/n8n-callback.ts) returns null
 * unless `approval.project_id` is set, and an outline approval carries
 * `project_id: null` by construction — at outline time the project does not
 * exist yet, which is the whole point of the stage. So no value written here
 * can advance anything.
 */
const OUTLINE_APPROVAL_CARD_TYPE = 'project_outline' as const;

/**
 * The concrete conditions an outline approver answers AGAINST — the EVIDENCE,
 * not prose.
 *
 * ⛔ DERIVED, NEVER INVENTED. Every term below is a restatement of something
 * the proposer actually sent in this same request body; nothing is synthesised
 * from an adjacent field, and an empty outline yields an empty array rather
 * than a manufactured term. That is the rule `lib/approval-rationale.ts`
 * states for the rationale columns and it applies here unchanged: a gate term
 * fr made up would let an approver believe they hold the proposer's commitment
 * when they hold fr's paraphrase of one.
 *
 * ⭐ WHY THIS EXISTS AT ALL. `workers/approval-redelivery.ts` reads
 * `metadata->'gate_terms'` to build its digest breakdown and otherwise reports
 * "(no gate_terms recorded)"; a full triage of 274 approvals once scored ALL
 * 274 `insufficient_evidence` for exactly this absence. Both live outline
 * approvals measured in the last 7 days carried neither `card_type` nor
 * `gate_terms`, i.e. they were unanswerable by construction.
 *
 */
function outlineGateTerms(
  body: ProjectOutlineInput,
  version: number,
): string[] {
  const terms: string[] = [`Outline version v${version} is the scope being agreed.`];

  const deliverable = (d: OutlineDeliverable, label: string): string => {
    const ac = d.acceptance_criteria.filter((c) => c.trim());
    return (
      `${label}: ${d.title}${d.kind ? ` (${d.kind})` : ''}` +
      (ac.length ? ` — accepted when: ${ac.join('; ')}` : ' — NO acceptance criteria supplied')
    );
  };
  for (const d of body.deliverables) terms.push(deliverable(d, 'Deliverable'));
  for (const d of body.intermediate_deliverables) {
    terms.push(deliverable(d, 'Intermediate deliverable'));
  }
  for (const m of body.milestones) {
    terms.push(
      `Milestone: ${m.name}` + (m.target_date ? ` — target ${m.target_date}` : ' — no target date'),
    );
  }
  if (body.effort_estimate) {
    terms.push(
      `Effort estimate: ${body.effort_estimate.value} ${body.effort_estimate.unit}` +
        (body.effort_estimate.note ? ` (${body.effort_estimate.note})` : ''),
    );
  }
  if (body.cost_estimate) {
    // ⚠️ "estimate", explicitly, and never "budget" or "spend". See the
    // cost_estimate docblock in types/api.ts: fr produces no per-project cost
    // stream, so nothing here may be presented as money committed or spent.
    terms.push(
      `Cost ESTIMATE (not a tracked budget): ${body.cost_estimate.currency} ` +
        `${body.cost_estimate.amount}` +
        (body.cost_estimate.basis ? ` — basis: ${body.cost_estimate.basis}` : ''),
    );
  }
  return terms;
}

function invalidTransition(from: string, to: string): Response {
  return jsonResponse({ error: 'invalid_transition', from, to }, 409);
}

// ---------------------------------------------------------------------------
// POST /api/project-requests/:id/submit
// ---------------------------------------------------------------------------

// ── The repo-access gate lives in ./project-request-repo-gate.ts ─────────────
// Shared with the direct approve route so neither road can skip it. Re-exported
// here for existing importers/tests.
export {
  READABLE_ACCESS_STATES,
  collectRequestRepos,
  collectRequestRepoUrls,
  loadRequestRepositories,
  replaceRequestRepositories,
  repoAccessBlockers,
  type RepoAccessItem,
  type RequestRepoEntry,
  type StoredRequestRepo,
} from './project-request-repo-gate';

/** Thrown inside the submit transaction when the linked project is not `pending`. */
class PreApprovalProjectNotPending extends AppError {
  constructor(
    readonly projectId: string,
    readonly status: string,
  ) {
    super(409, `linked project ${projectId} is '${status}', not 'pending'`);
    this.name = 'PreApprovalProjectNotPending';
  }
}

type SubmitTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Allocate — or, on a re-submit, REUSE — the `pending` projects row a project
 * request carries before approval (George 2026-10-08). Runs inside the submit
 * transaction. Writes ONLY the `projects` row: no Planka board, no stakeholders,
 * no secrets, no groups, nothing that fires the conveyor.
 *
 * - `request.project_id` set and that row `pending` ⇒ reused (name/repo
 *   refreshed from the payload, which may have been edited since).
 * - set and `cancelled` (a rejected request re-posted) ⇒ a NEW row; the
 *   cancelled one keeps its attributed spend.
 * - set and anything else (e.g. `active` after a promote that failed late) ⇒
 *   PreApprovalProjectNotPending (409): a live project is never re-purposed.
 * - unset, or the row is gone (FK is ON DELETE SET NULL) ⇒ a new row.
 *
 * Name comes from the payload only (`name`, then `title`), else the request id.
 * repository_url mirrors createSingleProject (repo.primary.url, then
 * repository_url — submit has already refused the CP sentinel), else NULL
 * (no repository — optional since migration 190).
 */
export async function allocatePreApprovalProject(
  tx: SubmitTx,
  opts: {
    request: typeof projectRequests.$inferSelect;
    ownerId: string;
    validated: ReturnType<typeof ProjectCreateSchema.parse>;
  },
): Promise<string> {
  const { request, ownerId, validated } = opts;
  const payload = (request.payload ?? {}) as Record<string, unknown>;
  const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const name = pick(validated.name) || pick(payload.title) || request.id;
  // NULL when the request names no repository (migration 190: a repo is optional).
  const repositoryUrl = validated.repo?.primary?.url || validated.repository_url || null;
  const branch = validated.repo?.primary?.branch || validated.branch || 'main';
  const now = new Date();

  if (request.project_id) {
    const [existing] = await tx
      .select({ id: projects.id, status: projects.status })
      .from(projects)
      .where(eq(projects.id, request.project_id))
      .for('update');
    // `cancelled` = an earlier rejection/withdraw that a bridge re-post reopened
    // (routes/project-requests.ts handleCreateProjectRequest). Its spend stays on
    // that row; this submit gets a fresh pending row (falls through to insert).
    if (existing && existing.status !== 'cancelled') {
      if (existing.status !== 'pending') {
        throw new PreApprovalProjectNotPending(existing.id, existing.status);
      }
      await tx
        .update(projects)
        .set({ name, repository_url: repositoryUrl, branch, updated_at: now })
        .where(and(eq(projects.id, existing.id), eq(projects.status, 'pending')));
      return existing.id;
    }
  }

  const [created] = await tx
    .insert(projects)
    .values({
      name,
      repository_url: repositoryUrl,
      branch,
      owner_id: ownerId,
      status: 'pending',
      // The owning tenant, so spend made before approval attributes to the
      // request's tenant (project_data.keycloak_tenant_id is the projects
      // table's tenant key). Approve rewrites project_data in full.
      project_data: { keycloak_tenant_id: request.tenant_id, project_request_id: request.id },
    })
    .returning({ id: projects.id });
  if (!created) throw new Error('pre-approval project insert returned no row');
  return created.id;
}

/**
 * The requester declares the request finished, and analysis is dispatched.
 *
 * The payload is validated against `ProjectCreateSchema` HERE, not at outline
 * approval: promotion will need it to be a valid ProjectCreate, and finding out
 * after a human has agreed an outline is the worst possible moment to learn the
 * repository URL was never set.
 *
 * ⚠️ DISPATCH TARGET. No n8n analysis workflow exists yet — it belongs to the
 * n8n_custom_nodes repo, not here. Until it does, PROJECT_REQUEST_ANALYSIS_WEBHOOK
 * is unset and the request honestly stays `submitted` with `dispatched:false`.
 * `triggerWorkflow` (services/n8n) cannot be used: it is keyed on a projectId
 * and a request has none. A plain `callWebhook` carries the request id instead.
 *
 * A FAILED DISPATCH DOES NOT FAIL THE SUBMISSION. The user's work is saved and
 * submitted; the failure is recorded in history and returned as a note, and a
 * re-dispatch is an operator/retry concern, not a reason to lose the submit.
 */
export async function handleSubmitProjectRequest(
  req: Request,
  id: string,
): Promise<Response> {
  // ⛔ v4 wiring gate (George 2026-10-13), FIRST — before auth, which can upsert
  // the caller's user row, and before any DB/RM/Planka side effect.
  const notConfigured = conveyorNotConfiguredResponse();
  if (notConfigured) return notConfigured;
  const { user, row } = await loadOwnedRequest(req, id);
  return emitSpan(
    'fr.project_request.submit',
    { 'user.id': user.id, 'tenant.id': row.tenant_id, 'project_request.id': row.id },
    async () => {
      const from = eventSources('submit');
      if (!from.includes(row.status as RequestStatus)) {
        return invalidTransition(row.status, 'submitted');
      }

      const parsed = ProjectCreateSchema.safeParse(row.payload);
      if (!parsed.success) {
        return jsonResponse(
          {
            error: 'project_request_payload_invalid',
            issues: parsed.error.issues,
          },
          422,
        );
      }
      if (parsed.data.repository_url === FR_REPO_SENTINEL) {
        return jsonResponse(
          {
            error: 'repository_url_required',
            message:
              'repository_url is still the CP placeholder — set a real repository before submitting',
          },
          422,
        );
      }

      // ── THE STAGE-A REPO SET IS PERSISTED, FIRST ─────────────────────────
      // `project_request_repositories` (migration 123) had NO writer anywhere in
      // `backend/src` until now: it was created, SELECTed by the gate, sorted by
      // its partial unique index, and never inserted into. So the gate computed a
      // verdict PER REPO and discarded it, and a reviewer looking at a denied
      // request could not see which repo failed.
      //
      // Written BEFORE the gate for two reasons: the gate records its verdict
      // ONTO these rows, and a 422 must still leave the reviewer a row per repo
      // saying which one refused. Delete-then-insert, so a re-submit replaces the
      // set rather than duplicating it.
      // ⛔ PLATFORM-REPO OWNERSHIP GATE (ruling 2026-09-30), PURE and BEFORE the
      // row write below: an internal-owner repo named by a non-platform
      // request must never land in `project_request_repositories`, not even as
      // a refused verdict row. (repoAccessGateResponse re-checks the full set.)
      const platformRefused = platformRepoRefusalResponse(
        collectRequestRepoUrls(row.payload),
        row.tenant_id,
      );
      if (platformRefused) return platformRefused;

      await replaceRequestRepositories(row.id, row.payload);

      // ⛔ THE REPO-ACCESS GATE. Runs after the cheap payload checks (no
      // point calling GitHub for a request that 422s anyway) and before any
      // STATUS write: a refusal changes no status and appends no history entry.
      // ⚠️ It DOES write the three verdict columns on the rows above — that is
      // the answer this unit stopped throwing away.
      const denied = await repoAccessGateResponse({
        requestId: row.id,
        tenantId: row.tenant_id,
        payload: row.payload,
        verb: 'submit',
      });
      if (denied) return denied;

      // ── THE PRE-APPROVAL PROJECT IS ALLOCATED WITH THE SUBMIT (George 2026-10-08)
      // Every conveyor LLM call carries a projectId — no "no project" exception —
      // and the outline workflow dispatched below runs BEFORE approval. So the
      // `projects` row is allocated here, status `pending`, in the SAME
      // transaction as the status write: a submit that loses its race allocates
      // nothing. ⛔ The row fires NOTHING (no board, card, stakeholders, secrets,
      // groups): approve promotes this SAME row pending → active and runs the
      // chain then (routes/projects.ts createSingleProject `existingProjectId`).
      const now = new Date();
      let submitted: typeof projectRequests.$inferSelect;
      let preApprovalProjectId: string;
      try {
        const out = await db.transaction(async (tx) => {
          const [moved] = await tx
            .update(projectRequests)
            .set({
              status: 'submitted',
              submitted_at: now,
              updated_at: now,
              error: null,
              history: appendHistorySql({
                at: now.toISOString(),
                action: 'submitted',
                by: user.id,
                from_status: row.status,
              }),
            })
            .where(and(eq(projectRequests.id, row.id), inArray(projectRequests.status, from)))
            .returning();
          if (!moved) return null;
          const projectId = await allocatePreApprovalProject(tx, {
            request: moved,
            ownerId: user.id,
            validated: parsed.data,
          });
          const [linked] = await tx
            .update(projectRequests)
            .set({ project_id: projectId })
            .where(eq(projectRequests.id, moved.id))
            .returning();
          return { submitted: linked ?? moved, projectId };
        });
        if (!out) {
          // Lost a race: someone moved it between our read and this write.
          return invalidTransition(row.status, 'submitted');
        }
        submitted = out.submitted;
        preApprovalProjectId = out.projectId;
      } catch (err) {
        if (err instanceof PreApprovalProjectNotPending) {
          return jsonResponse(
            {
              error: 'linked_project_not_pending',
              message:
                'this request is linked to a project that is no longer pending — it cannot be re-submitted',
              project_request_id: row.id,
              project_id: err.projectId,
              project_status: err.status,
            },
            409,
          );
        }
        throw err;
      }

      const webhookPath = (process.env.PROJECT_REQUEST_ANALYSIS_WEBHOOK ?? '').trim();
      if (!webhookPath) {
        return jsonResponse({
          data: {
            ...submitted,
            dispatched: false,
            dispatch_note:
              'analysis workflow not configured (PROJECT_REQUEST_ANALYSIS_WEBHOOK unset)',
          },
        });
      }

      try {
        // ── THE REPO SET TRAVELS EXPLICITLY, NOT INSIDE `payload` ───────────
        // The body used to carry only `{project_request_id, tenant_id, payload}`,
        // so every repository rode OPAQUELY inside `payload` in one of three
        // different shapes (`repository_url`, `repo.additional[]`,
        // `repositories[]`) and the n8n side had to re-implement the extraction
        // to find them — a second extraction that can disagree with this one.
        // These are the STORED rows, so `access_state` is the verdict the gate
        // just recorded and the order is the canonical primary-first one.
        //
        // ⚠️ NO `repo_id`. At Stage A there is no project, therefore no
        // `repositories`/`project_repositories` row to point at. The key is
        // OMITTED rather than sent as null: a null id reads as "we looked and
        // there is none", which is a different and false statement.
        //
        // ⛔ `payload` is passed through UNCHANGED, so nothing on the n8n side
        // that reads it today can break on this addition.
        const stored = await loadRequestRepositories(submitted.id);
        // The pre-approval project allocated above is the attribution key for
        // every LLM call the outline workflow makes; the actor is the submitting
        // user's Keycloak `sub`.
        await n8nClient.callWebhook(
          webhookPath,
          {
            project_request_id: submitted.id,
            project_id: preApprovalProjectId,
            tenant_id: submitted.tenant_id,
            payload: submitted.payload,
            repositories: stored.map((r) => ({
              url: r.url,
              branch: r.branch,
              name: r.name,
              path: r.path,
              is_primary: r.is_primary,
              position: r.position,
              access_state: r.access_state,
            })),
            repo_count: stored.length,
            coordination_mode: requestCoordinationMode(submitted.payload),
          },
          { projectId: preApprovalProjectId, actorId: user.id },
        );
      } catch (err) {
        // Stored in history (read back by the requester) and echoed as
        // `dispatch_note`: never the raw n8n/upstream text, which is logged.
        console.warn('[project-requests.submit] analysis dispatch failed:', err);
        const detail = clientSafeCaughtErrorText(err, 'analysis dispatch failed — it will be retried', {
          forStorage: true,
        });
        const at = new Date();
        const [kept] = await db
          .update(projectRequests)
          .set({
            updated_at: at,
            history: appendHistorySql({
              at: at.toISOString(),
              action: 'analysis_dispatch_failed',
              by: user.id,
              detail,
            }),
          })
          .where(eq(projectRequests.id, submitted.id))
          .returning();
        return jsonResponse({
          data: { ...(kept ?? submitted), dispatched: false, dispatch_note: detail },
        });
      }

      // Conditional on still being `submitted`: a fast agent may already have
      // delivered an outline, and `outline_proposed -> analysing` would regress it.
      const at = new Date();
      const [analysing] = await db
        .update(projectRequests)
        .set({
          status: 'analysing',
          updated_at: at,
          history: appendHistorySql({
            at: at.toISOString(),
            action: 'analysis_dispatched',
            by: user.id,
            detail: webhookPath,
          }),
        })
        .where(
          and(eq(projectRequests.id, submitted.id), eq(projectRequests.status, 'submitted')),
        )
        .returning();
      return jsonResponse({ data: { ...(analysing ?? submitted), dispatched: true } });
    },
  );
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/n8n/project-request-outline/:id
// ---------------------------------------------------------------------------

const OutlineWebhookBodySchema = ProjectOutlineSchema.extend({
  proposed_by: z.string().min(1).max(200).optional(),
  // U-PS-OUTLINE (migration 167): the phase plan this outline version was
  // instantiated from a template with. OPTIONAL — the current analysis
  // workflow sends none, and an outline without one is the legacy shape,
  // byte-identical to before. Its hash is computed below, never accepted.
  phase_plan: PhasePlanSchema.optional(),
});

/** Thrown inside the transaction to abort it with a 409 answer. */
class TransitionConflict extends Error {
  /**
   * @param liveProjectId set when withdraw is refused because the request
   *   links a project that is already `active` (handleWithdrawProjectRequest).
   */
  constructor(
    readonly from: string,
    readonly liveProjectId?: string,
  ) {
    super(`invalid_transition from ${from}`);
  }
}

/**
 * The analysis agent delivers an outline. Machine-authenticated
 * (`X-Webhook-Secret`), no user — the request is loaded by id directly.
 *
 * One transaction: supersede the live outline, insert version n, raise the
 * `project_outline.approval`, link them, move the request to
 * `outline_proposed`. The request row is locked FOR UPDATE first so two
 * concurrent deliveries serialise instead of one dying on the one-live-outline
 * unique index with a bare 500.
 *
 * The previous version's pending approval is voided AFTER the commit
 * (`voidApprovals` runs its own transaction). If that void fails, the stale
 * approval stays pending, but `onOutlineDecided` refuses to act on an outline
 * that is no longer `proposed`, so deciding it cannot promote a superseded
 * version.
 */
export async function handleProjectRequestOutline(
  req: Request,
  id: string,
): Promise<Response> {
  validateWebhookSecret(req);
  if (!isUuidShape(id)) throw new NotFoundError('Project request not found');

  const [row] = await db.select().from(projectRequests).where(eq(projectRequests.id, id));
  if (!row) throw new NotFoundError('Project request not found');

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const parsed = OutlineWebhookBodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(
      { error: 'project_outline_invalid', issues: parsed.error.issues },
      422,
    );
  }
  const body = parsed.data;

  // fr#1481 — a gate slug that maps to no approval predicate can never show as
  // satisfied in the plan read model. Refused HERE, before anything is written,
  // with the same slug → approval mapping lib/plan-phase-exit.ts evaluates.
  if (body.phase_plan !== undefined) {
    const unknownGates = planGateUnknownSlugs(body.phase_plan);
    if (unknownGates.length > 0) {
      return jsonResponse(
        {
          error: PHASE_PLAN_GATE_UNKNOWN,
          unknown_gates: unknownGates,
          issues: unknownGates.map((g) => ({
            path: ['phase_plan', 'gates', g.phase],
            message: `gate slug '${g.slug}' names no approval kind (execution.<slug> / qa.<slug>) and no known marker`,
          })),
        },
        422,
      );
    }
  }

  // The plan's phases must be an ORDERED SUBSET of the request's RM project-type
  // phases (input validation — fr holds no spine; design: fr consumes RM
  // vocabulary). The request's own tenant catalogue, never the caller's.
  if (body.phase_plan !== undefined) {
    const requestType = (row.payload as { project_type?: unknown } | null)?.project_type;
    if (typeof requestType !== 'string' || requestType.trim() === '') {
      return jsonResponse(
        {
          error: PHASE_PLAN_PHASE_NOT_IN_TYPE,
          issues: [{ path: ['phase_plan', 'phases'], message: 'the request has no project_type, so a phase plan cannot be placed' }],
        },
        422,
      );
    }
    const typeList = await typePhases(row.tenant_id, requestType);
    const outside = planPhasesOutsideType(body.phase_plan, (typeList ?? []).map((p) => p.name));
    if (!typeList || outside.length > 0) {
      return jsonResponse(
        {
          error: PHASE_PLAN_PHASE_NOT_IN_TYPE,
          project_type: requestType,
          type_phases: (typeList ?? []).map((p) => p.name),
          issues: outside.map((o) => ({
            path: ['phase_plan', 'phases'],
            message: `phase '${o.phase}': ${o.reason === 'out_of_order' ? 'out of the project type order' : `not a phase of project type '${requestType}'`}`,
          })),
        },
        422,
      );
    }
  }

  // The plan's hash is a fact about the stored bytes, computed here. A plan the
  // JCS canonicaliser refuses (a non-integer number, say) is an invalid
  // outline — the same 422 a schema failure gets, before anything is written.
  let phasePlanHashValue: string | null = null;
  if (body.phase_plan !== undefined) {
    try {
      phasePlanHashValue = phasePlanHash(body.phase_plan);
    } catch (err) {
      return jsonResponse(
        {
          error: 'project_outline_invalid',
          issues: [
            {
              path: ['phase_plan'],
              message: `phase_plan is not canonicalisable: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        },
        422,
      );
    }
  }

  // WHO decides the outline: the request's named approvers, else the person who
  // asked for it. Resolved by the SAME rule project-create uses to seed the
  // execution_signoff roster (`resolveSignoffStakeholderIds`: deduped UUID
  // subset of `payload.approvers`, falling back to the owner) — so the humans
  // who agree the outline are the humans who later sign off execution.
  //
  // ⛔ THIS LIST IS WRITTEN TO `required_approvers` BELOW, AND THAT IS THE
  // AUTHORIZATION. handleUpdateApproval admits a decider only through a
  // `required_approvers` row (by user_id, or by role); `approver_user_id` has no
  // readers. #1153 wrote only `approver_user_id`, so every outline approval had
  // an empty roster and 422'd for everyone, the requester included.
  //
  // An approval addressed to nobody is a timer, not a request
  // (scripts/check-approval-mint-guard.ts) — refuse rather than mint one.
  const requestPayload = (row.payload ?? {}) as Record<string, unknown>;
  const namedApprovers = Array.isArray(requestPayload.approvers)
    ? requestPayload.approvers.filter((a): a is string => typeof a === 'string')
    : [];
  const approvers = resolveSignoffStakeholderIds(namedApprovers, row.created_by ?? '');

  // ⭐ CLOSING THE "DELIVERED BUT NOT ENFORCED" GAP.
  //
  // `payload.constraints` is rendered into the analysis brief
  // (routes/projects.ts `renderConstraintsForBrief`) and, until this call,
  // NOTHING looked at what the agent proposed back. The only other gate is
  // services/constraint-check.ts, which needs a PR DIFF — so it runs long after
  // a human has agreed an outline that planned the breach.
  //
  // ⛔ ADVISORY, AND THAT IS DELIBERATE. A contradiction does NOT refuse the
  // outline, does not change its status and does not alter the roster: the
  // decider is a human, and this is evidence for them, not a veto. A scan that
  // could reject would make a text heuristic load-bearing, which it is not.
  //
  // ⛔ AND IT CANNOT FAIL THE DELIVERY. `scanOutlineForContradictions` is pure
  // and total (no I/O, no throw on junk — pinned by its unit suite), but this
  // is a machine-authenticated webhook on the conveyor's critical path: losing
  // an outline because an advisory scan threw would be strictly worse than
  // having no scan. So it is wrapped, and a failure degrades to "no block".
  //
  // READERS of what this produces — all FIVE already live, no new field added.
  // ⚠️ CORRECTED 2026-09-24: this said FOUR and listed four. There are FIVE
  // renderers; the project-scoped approval page was missed, and an undercount
  // here is what lets a change to this text ship untested against a real reader.
  //   * approvals.change_summary is rendered at
  //     frontend/src/routes/approvals/[id]/+page.svelte:279 (detail page),
  //     :129 (folded into <AgentSummary>),
  //     frontend/src/routes/approvals/+page.svelte:2676 (the queue row),
  //     frontend/src/lib/components/workspace/NeedsYouQueue.svelte:836, and
  //     frontend/src/routes/projects/[id]/approve/[approvalId]/+page.svelte:107
  //     (inline beside the description) and :215 (the "What changed" section).
  // ⛔ NONE of the five paginates or truncates, which is why the cap lives in
  // `renderContradictionsForApproval` (APPROVAL_NOTICE_CAP) rather than in a
  // component: a per-component clamp would have to be added five times and would
  // still leave the unbounded value in the column.
  //   * the `outline_proposed` history entry's `detail` is rendered by
  //     routes/project-request-history.ts.
  // Nothing new is persisted anywhere else — notably NOT in
  // `approvals.metadata`, which has no reader for this and would be exactly the
  // write-only shape db/schema.ts:307 forbids.
  let constraintNotice: string | null = null;
  let contradictionCount = 0;
  try {
    const scan = scanOutlineForContradictions(requestPayload.constraints, body);
    contradictionCount = scan.contradictions.length;
    constraintNotice = renderContradictionsForApproval(scan);
  } catch (err) {
    console.warn(
      `[project-request-lifecycle] outline constraint scan failed for request ${row.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // ⚠️ An EMPTY notice means "found nothing to report", NEVER "complies" — the
  // scan cannot establish compliance at outline time (no code exists yet). So
  // nothing is appended for a clean outline; see the scan module's header.
  const changeSummary =
    constraintNotice === null
      ? (body.summary ?? null)
      : [body.summary?.trim(), constraintNotice].filter(Boolean).join('\n\n');

  if (approvers.length === 0) {
    return jsonResponse(
      {
        error: 'project_request_has_no_approver',
        message:
          'this request names no approver and has no created_by, so nobody can be asked to decide its outline',
      },
      422,
    );
  }

  return emitSpan(
    'fr.project_request.outline',
    { 'tenant.id': row.tenant_id, 'project_request.id': row.id },
    async () => {
      const from = eventSources('outline');
      let result: {
        outline: typeof projectOutlines.$inferSelect;
        approvalId: string;
        version: number;
        supersededApprovalId: string | null;
      };
      try {
        result = await db.transaction(async (tx) => {
          const [locked] = await tx
            .select({ status: projectRequests.status })
            .from(projectRequests)
            .where(eq(projectRequests.id, row.id))
            .for('update');
          if (!locked || !from.includes(locked.status as RequestStatus)) {
            throw new TransitionConflict(locked?.status ?? 'missing');
          }

          const existing = await tx
            .select({
              id: projectOutlines.id,
              version: projectOutlines.version,
              status: projectOutlines.status,
              approval_id: projectOutlines.approval_id,
            })
            .from(projectOutlines)
            .where(eq(projectOutlines.request_id, row.id));
          const live = existing.find((o) => o.status === 'proposed') ?? null;
          const version = nextOutlineVersion(existing.map((o) => o.version));

          if (live) {
            await tx
              .update(projectOutlines)
              .set({ status: 'superseded' })
              .where(eq(projectOutlines.id, live.id));
          }

          const [inserted] = await tx
            .insert(projectOutlines)
            .values({
              request_id: row.id,
              version,
              status: 'proposed',
              summary: body.summary ?? null,
              deliverables: body.deliverables,
              intermediate_deliverables: body.intermediate_deliverables,
              milestones: body.milestones,
              effort_estimate: body.effort_estimate ?? null,
              cost_estimate: body.cost_estimate ?? null,
              proposed_by: body.proposed_by ?? null,
              phase_plan: body.phase_plan ?? null,
              phase_plan_hash: phasePlanHashValue,
            })
            .returning();
          if (!inserted) throw new Error('project outline insert returned no row');

          // Built from the SAME `body` the outline row above was written from,
          // and from the `version` that row actually received — not from the
          // request's raw JSON — so the terms on the approval and the scope in
          // `project_outlines` can never describe different things.
          const gateTerms = outlineGateTerms(body, version);

          const payload = (row.payload ?? {}) as Record<string, unknown>;
          const name =
            typeof payload.name === 'string' && payload.name.trim()
              ? payload.name.trim()
              : row.id;
          const [approval] = await tx
            .insert(approvals)
            .values({
              tenant_id: row.tenant_id,
              project_id: null,
              project_request_id: row.id,
              kind: OUTLINE_APPROVAL_KIND,
              status: 'pending',
              requester_id: row.created_by,
              approver_user_id: approvers[0],
              description: `Approve project outline v${version}: ${name}`,
              change_summary: changeSummary,
              source: 'n8n',
              callback_path: null,
              // ── WHAT THE ROW IS ASKING ────────────────────────────────────
              // ⛔ ACCEPTING THE OUTLINE WITHOUT PERSISTING WHAT IT COMMITS TO
              // WOULD FIX NOTHING — the same sentence routes/webhooks.ts has
              // had to write four times on its own insert. `card_type` labels
              // the kind of decision; `gate_terms` are the concrete conditions
              // the approver answers against, and `workers/approval-redelivery.ts`
              // reads exactly this key to build its digest.
              //
              // MEASURED (7d to 2026-09-26): BOTH live rows this minter
              // produced carried neither key, so there was nothing on the row
              // to decide from at all.
              metadata: {
                card_type: OUTLINE_APPROVAL_CARD_TYPE,
                outline_version: version,
                // Omitted rather than written empty when the proposer sent an
                // outline with nothing in it: an ABSENT key and an EMPTY array
                // are different findings, and every other mint path in this
                // repo preserves that distinction with the same
                // `...(x.length ? {x} : {})` spread.
                ...(gateTerms.length ? { gate_terms: gateTerms } : {}),
              },
              // ── THE DEADLINE ──────────────────────────────────────────────
              // ⛔ READ ALL FOUR STEPS BEFORE CHANGING THIS EITHER WAY. The
              // comment that stood here said: "expires_at left NULL = no
              // deadline. An outline is a human agreement about scope; letting
              // it lapse on a timer would push the request back without anyone
              // having said no." That argument is NOT deleted and is NOT
              // stupid — it is `lib/approval-deadline.ts`'s own header
              // argument, and 132 approvals really did expire because two
              // writers manufactured a deadline out of nothing.
              //
              // (1) ⭐ THAT HEADER IS SUPERSEDED, IN ITS OWN FILE. Lines 65-93
              //     of `lib/approval-deadline.ts` carry a dated 2026-09-02
              //     OPERATOR OVERRIDE: "⛔ READ THIS BEFORE 'RESTORING' THE
              //     null RETURN … It is OVERRIDDEN, knowingly, by an operator
              //     who was shown the conflict twice and confirmed both times."
              //     `deadlineFromHours` no longer returns `| null`. ⚠️ That ⛔
              //     warns against restoring NULL — it is easy to quote it as
              //     though it warned against adding a deadline, which is the
              //     opposite of what it says.
              //
              // (2) ⭐ AND THE HEADER'S ARGUMENT HAS NO SUBJECT HERE ANYWAY.
              //     It is about a CARD-BLOCKING approval: "BLOCKED *is* the
              //     wait state". This row sets **no `card_id`** (and
              //     `project_id: null`), so it gates no Planka card and cannot
              //     park one in BLOCKED. `callback_path` is null too, so the
              //     reaper's `sendN8nExpiryCallback` — the other half of the
              //     operator's 2026-09-02 evidence, 791 callbacks into a sick
              //     n8n — never fires for it either. ⚠️ The absent
              //     callback_path alone is WEAK evidence; the absent card_id is
              //     the decisive one. Check both before reusing this reasoning.
              //
              // (3) ⚠️ THE PRECONDITION THAT MAKES THE TIMER SAFE, and it had
              //     to be verified rather than assumed: `workers/approval-expiry.ts`
              //     touches ONLY `approvals` — it never writes `project_requests`
              //     — and `handleUpdateApproval` refuses an expired row. So an
              //     outline approval that lapses leaves the request sitting at
              //     `outline_proposed` with a gate nobody can decide. That
              //     would be a strand IF there were no way back. There are two,
              //     both pre-existing: `EVENT_SOURCES.outline` admits
              //     `outline_proposed`, so a NEW outline version may be
              //     proposed over it (superseding the outline and voiding the
              //     stale approval), and `EVENT_SOURCES.withdraw` admits it
              //     too. ⛔ If either source list ever drops `outline_proposed`,
              //     this deadline becomes a strand — revisit it here.
              //
              // (4) What the NULL actually cost: the row is UN-REAPABLE, not
              //     unanswerable (`hasPassedDeadline` is false forever, so a
              //     human can always decide it). Both rows this minter produced
              //     in the last 7 days are in that state and it is the only
              //     live producer of them.
              //
              // `deadlineFromHours(null)` is REUSED, not re-derived: it is the
              // one place the tenant default (DEFAULT_TTL_DAYS = 14) is stated,
              // and it honours the file's `null | undefined` distinction —
              // passing `null` says "this producer asks for no particular TTL",
              // which is exactly true, rather than inventing a number here.
              expires_at: deadlineFromHours(null),
            })
            .returning({ id: approvals.id });
          if (!approval) throw new Error('outline approval insert returned no row');

          // The roster, in the SAME transaction as the approval: an approval row
          // without its roster is undecidable by anyone. Role `outline_approver`
          // is deliberately not a realm role, so the role arm of
          // `approverIdentityFilter` matches nobody — only the named users may
          // decide (plus super_admin, who discharges a real row).
          await tx.insert(requiredApprovers).values(
            approvers.map((user_id) => ({
              tenant_id: row.tenant_id,
              approval_id: approval.id,
              user_id,
              role: OUTLINE_APPROVER_ROLE,
            })),
          );

          const [linked] = await tx
            .update(projectOutlines)
            .set({ approval_id: approval.id })
            .where(eq(projectOutlines.id, inserted.id))
            .returning();

          const now = new Date();
          await tx
            .update(projectRequests)
            .set({
              status: 'outline_proposed',
              updated_at: now,
              history: appendHistorySql({
                at: now.toISOString(),
                action: 'outline_proposed',
                by: body.proposed_by ?? 'system:project-request-outline',
                from_status: locked.status,
                detail:
                  contradictionCount > 0
                    ? `v${version}; ${contradictionCount} constraint contradiction(s) reported on the approval`
                    : `v${version}`,
              }),
            })
            .where(eq(projectRequests.id, row.id));

          return {
            outline: linked ?? inserted,
            approvalId: approval.id,
            version,
            supersededApprovalId: live?.approval_id ?? null,
          };
        });
      } catch (err) {
        if (err instanceof TransitionConflict) {
          return invalidTransition(err.from, 'outline_proposed');
        }
        throw err;
      }

      if (result.supersededApprovalId) {
        try {
          await voidApprovals({
            ids: [result.supersededApprovalId],
            reason: `superseded by outline v${result.version}`,
            dryRun: false,
            actor: 'system:project-request-outline',
          });
        } catch (err) {
          // Not fatal: onOutlineDecided ignores decisions on a non-proposed
          // outline, so the stale approval cannot promote anything.
          console.warn(
            `[project-request-lifecycle] could not void superseded outline approval ${result.supersededApprovalId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return jsonResponse(
        { data: { outline: result.outline, approval_id: result.approvalId } },
        201,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Decision hook — called from routes/approvals.ts after a decision commits.
// ---------------------------------------------------------------------------

type DecidingUser = Parameters<typeof promoteProjectRequest>[0]['user'];

interface OutlineDecisionResult {
  handled: boolean;
  action?: string;
  promoted?: boolean;
  project_id?: string | null;
  error?: string;
}

/**
 * Apply a decided `project_outline.approval` to its outline and request.
 *
 * ⛔ NEVER THROWS. The caller is the human decision path; the decision is
 * already committed when this runs, and a failure here (Planka down, andon
 * engaged, a stale payload) must not turn a human's recorded decision into a
 * 500. Every failure is recorded on the request (promoteProjectRequest itself
 * stamps `failed`) and returned in the result.
 */
export async function onOutlineDecided(opts: {
  approval: {
    id: string;
    kind: string | null;
    project_request_id: string | null;
    status: string;
  };
  decidedBy: DecidingUser;
  /** The decider's comment, recorded on a rejection. */
  comment?: string | null;
}): Promise<OutlineDecisionResult> {
  const { approval, decidedBy } = opts;
  if (approval.kind !== OUTLINE_APPROVAL_KIND || !approval.project_request_id) {
    return { handled: false };
  }
  const requestId = approval.project_request_id;
  const effect = outlineDecisionEffect(approval.status);

  // ⛔ v4 wiring gate, BEFORE ANY WRITE. promoteProjectRequest refuses too, but
  // only after this function has already marked the outline decided and moved
  // the request — and that refusal records nothing (it throws before its own
  // try), so the catch below would report a failure the request never shows:
  // stranded, no `failed` status, no history. The decide handler
  // (approvals.ts handleUpdateApproval) refuses an outline decision 503 before
  // committing it; this is the backstop for any other caller. Nothing is
  // written, so the outline stays `proposed` and the request where it was.
  if (!conveyorIsConfigured()) {
    console.warn(
      `[project-request-lifecycle] outline decision ${approval.id} not applied: ${CONVEYOR_NOT_CONFIGURED_CODE}`,
    );
    return { handled: true, action: CONVEYOR_NOT_CONFIGURED_CODE, error: CONVEYOR_NOT_CONFIGURED_CODE };
  }

  try {
    const [outline] = await db
      .select()
      .from(projectOutlines)
      .where(eq(projectOutlines.approval_id, approval.id));
    const [row] = await db
      .select()
      .from(projectRequests)
      .where(eq(projectRequests.id, requestId));
    if (!outline || !row) {
      console.warn(
        `[project-request-lifecycle] outline decision ${approval.id}: outline or request ${requestId} not found`,
      );
      return { handled: true, action: 'missing', error: 'outline or request not found' };
    }

    const now = new Date();

    // A superseded / already-decided outline must not move the request.
    if (outline.status !== 'proposed' || effect.outlineStatus === null) {
      const action =
        outline.status !== 'proposed'
          ? `outline_decision_ignored_${outline.status}`
          : effect.historyAction;
      await db
        .update(projectRequests)
        .set({
          updated_at: now,
          history: appendHistorySql({
            at: now.toISOString(),
            action,
            by: decidedBy.id,
            detail: `v${outline.version} (approval ${approval.id} ${approval.status})`,
          }),
        })
        .where(eq(projectRequests.id, requestId));
      return { handled: true, action };
    }

    const [decidedOutline] = await db
      .update(projectOutlines)
      .set({
        status: effect.outlineStatus,
        decided_by: decidedBy.id,
        decided_at: now,
        decision_note: opts.comment ?? null,
      })
      .where(and(eq(projectOutlines.id, outline.id), eq(projectOutlines.status, 'proposed')))
      .returning({ id: projectOutlines.id });
    if (!decidedOutline) {
      return { handled: true, action: 'outline_already_decided' };
    }

    const [moved] = await db
      .update(projectRequests)
      .set({
        status: effect.requestStatus!,
        updated_at: now,
        history: appendHistorySql({
          at: now.toISOString(),
          action: effect.historyAction,
          by: decidedBy.id,
          from_status: row.status,
          detail:
            effect.historyAction === 'outline_rejected'
              ? (opts.comment ?? `v${outline.version}`)
              : `v${outline.version}`,
        }),
      })
      .where(
        and(
          eq(projectRequests.id, requestId),
          inArray(projectRequests.status, eventSources('outline_decided')),
        ),
      )
      .returning();
    if (!moved) {
      console.warn(
        `[project-request-lifecycle] request ${requestId} was '${row.status}', not decidable; outline ${outline.id} recorded as ${effect.outlineStatus} only`,
      );
      return { handled: true, action: effect.historyAction, error: `request is '${row.status}'` };
    }

    if (!effect.promote) {
      return { handled: true, action: effect.historyAction };
    }

    const parsed = ProjectCreateSchema.safeParse(moved.payload);
    const invalid = !parsed.success
      ? `payload is not a valid ProjectCreate: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
      : parsed.data.repository_url === FR_REPO_SENTINEL
        ? 'repository_url is still the CP placeholder'
        : null;
    if (invalid !== null || !parsed.success) {
      const message = invalid ?? 'payload is not a valid ProjectCreate';
      const at = new Date();
      await db
        .update(projectRequests)
        .set({
          status: 'failed',
          error: message,
          updated_at: at,
          history: appendHistorySql({
            at: at.toISOString(),
            action: 'promote_failed',
            by: decidedBy.id,
            detail: message,
          }),
        })
        .where(eq(projectRequests.id, requestId));
      return { handled: true, action: effect.historyAction, promoted: false, error: message };
    }

    try {
      // ⛔ `outline` IS THE WHOLE POINT OF THIS CALL (migration 127). Without
      // it, promotion builds the project from `moved.payload` — the Stage-A
      // request payload the customer typed BEFORE any analysis — and every
      // deliverable, acceptance criterion, milestone and effort figure the
      // human just approved is discarded. `outline` has been in scope since the
      // top of this function; the data was always in hand and simply not passed.
      const { project } = await promoteProjectRequest({
        row: moved,
        user: decidedBy,
        validated: parsed.data,
        historyAction: 'promoted_from_outline',
        // ⚠️ The SAME reason `outline` is passed: the value is in hand and, left
        // out, every project promoted down the two-stage road — which is the MAIN
        // road — silently reads `coordinated` from the column default, losing an
        // `independent` the requester declared. One reader
        // (`requestCoordinationMode`), both promote roads.
        coordinationMode: requestCoordinationMode(parsed.data),
        outline: {
          id: outline.id,
          deliverables: outline.deliverables,
          intermediate_deliverables: outline.intermediate_deliverables,
          milestones: outline.milestones,
          effort_estimate: outline.effort_estimate,
          // U-PS-ROUTE: the plan this version carries (NULL ⇒ legacy start) and
          // the decision that closes the contract — this approval, just now.
          version: outline.version,
          phase_plan: outline.phase_plan,
          phase_plan_hash: outline.phase_plan_hash,
          approval_id: approval.id,
          decided_by: decidedBy.id,
          decided_at: now,
        },
      });
      return {
        handled: true,
        action: effect.historyAction,
        promoted: true,
        project_id: project.id,
      };
    } catch (err) {
      // promoteProjectRequest already recorded status='failed' + history (its
      // conveyor_not_configured refusal records nothing, which is why that case
      // is refused at the top of this function instead of reaching here).
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[project-request-lifecycle] promotion after outline approval failed for request ${requestId}: ${message}`,
      );
      return { handled: true, action: effect.historyAction, promoted: false, error: message };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[project-request-lifecycle] onOutlineDecided failed for approval ${approval.id}: ${message}`,
    );
    return { handled: true, action: 'error', error: message };
  }
}

// ---------------------------------------------------------------------------
// POST /api/project-requests/:id/withdraw
// ---------------------------------------------------------------------------

/**
 * The requester takes their own request back.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 *
 * REQUESTER ONLY, on top of `loadOwnedRequest`'s tenant scope. This resource
 * has exactly one notion of "the requester": `project_requests.created_by`.
 * That is already the authorization source everywhere else on this row — it is
 * the roster fallback the outline webhook resolves through
 * (`resolveSignoffStakeholderIds(namedApprovers, row.created_by)`) and it is
 * what `approvals.requester_id` is set from — so this reuses it rather than
 * inventing a second idea of ownership.
 *
 * ⛔ NO super-admin bypass, DELIBERATELY. Withdraw is not an administrative
 * remedy: an operator who needs a request gone rejects it
 * (`handleRejectProjectRequest`, which records a reason), and an operator who
 * needs its approval out of the queue voids the approval
 * (`POST /api/approvals/void`). Both of those already exist and both leave a
 * named actor. "The requester changed their mind" is the only thing this route
 * means, and widening it would make the state stop meaning that.
 *
 * ⚠️ `created_by` IS NULLABLE — the CP bridge intake can land a draft with no
 * subject id. Such a row has no requester, so nobody can withdraw it; it is
 * refused with the same 403 rather than silently admitting whoever asks.
 *
 * ── THE RACE, WHICH BECOMES REACHABLE FOR THE FIRST TIME HERE ───────────────
 *
 * This file's own header names it: "an agent delivering an outline while the
 * requester withdraws". Until now nothing could withdraw, so the sentence
 * described a hazard with no second party. It now has one, in both directions,
 * and both are closed:
 *
 *  1. A DECISION COMMITS WHILE THIS HANDLER IS RUNNING. `loadOwnedRequest` read
 *     the status without a lock, so it may already be stale. The transition
 *     therefore re-reads the status `FOR UPDATE` INSIDE the transaction and the
 *     UPDATE additionally carries `status IN (<withdraw sources>)`. An outline
 *     decision that committed in that window moved the request to `approved`,
 *     which is NOT a withdraw source, so the withdraw loses with a 409 instead
 *     of clobbering a decision that already happened.
 *  2. A DECISION ARRIVES AFTER THE WITHDRAW COMMITS. The same transaction marks
 *     the live outline `superseded`, so `onOutlineDecided` hits its
 *     `outline.status !== 'proposed'` guard and records
 *     `outline_decision_ignored_superseded` without touching the request. (Its
 *     request-level `status IN ('outline_proposed')` guard is a second,
 *     independent stop — neither is load-bearing alone.)
 *
 * ⚠️ `superseded`, not a new outline status. The `project_outlines` CHECK admits
 * proposed | superseded | approved | rejected in BOTH emitters; adding a fifth
 * value would be a two-emitter migration, and `superseded` is exactly what the
 * outline now is — replaced, by nothing. `decided_by` / `decided_at` are left
 * NULL because no human decided it, and the reason is recorded on the voided
 * approval and in the request history.
 *
 * The approval is voided AFTER the commit, because `voidApprovals` runs its own
 * transaction — the same shape, for the same reason, as the supersede path in
 * `handleProjectRequestOutline`. If the void fails the approval stays pending,
 * but the superseded outline means deciding it can promote nothing.
 */
export async function handleWithdrawProjectRequest(
  req: Request,
  id: string,
): Promise<Response> {
  const { user, row } = await loadOwnedRequest(req, id);
  return emitSpan(
    'fr.project_request.withdraw',
    { 'user.id': user.id, 'tenant.id': row.tenant_id, 'project_request.id': row.id },
    async () => {
      if (!row.created_by || row.created_by !== user.id) {
        return jsonResponse(
          {
            error: 'not_the_requester',
            message:
              'only the person who raised this request may withdraw it — reject it, or void its approval, if you are acting as an operator',
            project_request_id: row.id,
          },
          403,
        );
      }

      const from = eventSources('withdraw');
      // A cheap pre-check purely for the error message; the write below does
      // NOT trust it (see the race note above).
      if (!from.includes(row.status as RequestStatus)) {
        return invalidTransition(row.status, 'withdrawn');
      }

      let result: {
        updated: typeof projectRequests.$inferSelect;
        approvalIds: string[];
      };
      try {
        result = await db.transaction(async (tx) => {
          // ⛔ THE SAME-TRANSACTION STATUS READ. Not a cosmetic re-check: it
          // takes a row lock, so a concurrent outline decision either committed
          // before it (and is seen here) or blocks until this transaction ends.
          const [locked] = await tx
            .select({ status: projectRequests.status, project_id: projectRequests.project_id })
            .from(projectRequests)
            .where(eq(projectRequests.id, row.id))
            .for('update');
          if (!locked || !from.includes(locked.status as RequestStatus)) {
            throw new TransitionConflict(locked?.status ?? 'missing');
          }

          // ⛔ NEVER WITHDRAW OVER A LIVE PROJECT (mirrors reject). A promotion
          // that failed after activation leaves the request `failed` and its
          // project `active`; a bridge re-post reopens it to `draft` keeping
          // `project_id`. cancelPreApprovalProject only cancels `pending` rows,
          // so withdrawing here would leave withdrawn + active + a Planka board,
          // and approve (the only road that finishes it) then 409s on
          // `withdrawn`. Locked FOR UPDATE so a concurrent activation is either
          // seen or blocked; refuse and change nothing.
          if (locked.project_id) {
            const [linked] = await tx
              .select({ status: projects.status })
              .from(projects)
              .where(eq(projects.id, locked.project_id))
              .for('update');
            if (linked?.status === 'active') {
              throw new TransitionConflict(locked.status, locked.project_id);
            }
          }

          // Every LIVE outline, in the same transaction as the status write.
          // `project_outlines_one_live_idx` permits at most one, but the query
          // is written over a list so a future relaxation cannot leave a
          // proposed outline behind a withdrawn request.
          const live = await tx
            .select({ id: projectOutlines.id, approval_id: projectOutlines.approval_id })
            .from(projectOutlines)
            .where(
              and(
                eq(projectOutlines.request_id, row.id),
                eq(projectOutlines.status, 'proposed'),
              ),
            );
          for (const outline of live) {
            await tx
              .update(projectOutlines)
              .set({ status: 'superseded' })
              .where(
                and(
                  eq(projectOutlines.id, outline.id),
                  eq(projectOutlines.status, 'proposed'),
                ),
              );
          }

          const now = new Date();
          const [updated] = await tx
            .update(projectRequests)
            .set({
              status: 'withdrawn',
              reviewed_by: user.id,
              updated_at: now,
              history: appendHistorySql({
                at: now.toISOString(),
                action: 'withdrawn',
                by: user.id,
                from_status: locked.status,
                detail:
                  live.length > 0
                    ? `withdrawn with ${live.length} live outline(s) superseded`
                    : 'withdrawn',
              }),
            })
            .where(
              and(
                eq(projectRequests.id, row.id),
                inArray(projectRequests.status, from),
              ),
            )
            .returning();
          if (!updated) throw new TransitionConflict(locked.status);

          // The pre-approval project becomes `cancelled` (George 2026-10-08).
          await cancelPreApprovalProject(tx, updated.project_id);

          return {
            updated,
            approvalIds: live
              .map((o) => o.approval_id)
              .filter((a): a is string => typeof a === 'string'),
          };
        });
      } catch (err) {
        if (err instanceof TransitionConflict && err.liveProjectId) {
          return jsonResponse(
            {
              error: 'project_request_withdraw_conflict',
              message:
                'this request already has a live project (a promotion failed after activation) — approve it again to finish the promotion',
              project_request_id: row.id,
              project_id: err.liveProjectId,
            },
            409,
          );
        }
        if (err instanceof TransitionConflict) {
          return invalidTransition(err.from, 'withdrawn');
        }
        throw err;
      }

      const voided: string[] = [];
      if (result.approvalIds.length > 0) {
        try {
          const outcomes = await voidApprovals({
            ids: result.approvalIds,
            reason: `project request withdrawn by its requester (${row.id})`,
            dryRun: false,
            actor: user.id,
          });
          for (const [approvalId, outcome] of outcomes) {
            if (outcome === 'voided') voided.push(approvalId);
          }
        } catch (err) {
          // Not fatal: the outline is `superseded`, so onOutlineDecided refuses
          // to act on a decision against it — the stranded approval cannot cause a
          // wrong ACTION, only a wrong QUEUE.
          //
          // ⚠️ BUT IT DOES STRAND, AND THIS ONLY MAKES IT OBSERVABLE — IT DOES NOT
          // FIX IT. There is no retry and no reconciler, so a failed void leaves a
          // pending row nobody can answer: exactly the population this PR's own
          // Withdraw control exists to drain (240 unanswerable rows, 192 holding a
          // card in BLOCKED — db/schema.ts:891-893, measured 2026-09-05). A new
          // route that can ADD to that pile deserves a reconciler; that is its own
          // unit of work, and until it exists this telemetry is how anyone finds out.
          // A bare console.warn was not enough: it dies with the pod and cannot be
          // queried, so after a restart the failure was unfindable.
          reportSwallowedFailure(err, {
            service: 'fr.void-approvals',
            method: 'voidApprovals',
            path: `project-request/${row.id}/withdraw`,
            degradedTo:
              'withdraw succeeded; outline approval(s) left PENDING and unanswerable — no retry exists',
          });
          console.warn(
            `[project-request-lifecycle] could not void outline approval(s) ${result.approvalIds.join(
              ', ',
            )} after withdrawing request ${row.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return jsonResponse({
        data: { ...result.updated, voided_approval_ids: voided },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// GET /api/project-requests/:id/outlines
// ---------------------------------------------------------------------------

/**
 * One outline as the panel reads it: the row plus the STATUS of the approval it
 * links to (UI review 2026-10-08). An outline can sit at `proposed` while its
 * approval was voided/withdrawn (request dc3ce2f9 in prod), and the panel then
 * offered "Decide this outline" onto a row nobody can decide. `null` when the
 * outline links no approval, or the approval is not in the request's tenant.
 */
export function toOutlineListItem(
  r: {
    outline: typeof projectOutlines.$inferSelect;
    approval_status: string | null;
  },
  labels: ReadonlyMap<string, string> = new Map(),
) {
  return { ...r.outline, approval_status: r.approval_status ?? null, ...outlinePlanView(r.outline, labels) };
}

/**
 * fr#1484 — the server-built PROPOSED plan for an outline that carries a
 * phase_plan (phases, gates, deliverables, the PSD AT6 card count, checks
 * pending). `plan_view: null` on a legacy outline. A stored plan that no longer
 * parses is reported (`plan_view_error`), never rendered as an empty plan and
 * never allowed to 500 the whole list.
 */
function outlinePlanView(
  o: typeof projectOutlines.$inferSelect,
  labels: ReadonlyMap<string, string>,
): {
  plan_view: ProposedPlanView | null;
  plan_view_error?: string;
} {
  if (o.phase_plan === null || o.phase_plan === undefined || !o.phase_plan_hash) return { plan_view: null };
  try {
    const plan = storedPhasePlan(o.phase_plan);
    return { plan_view: plan ? proposedPlanView(plan, o.phase_plan_hash, labels) : null };
  } catch (err) {
    return { plan_view: null, plan_view_error: `stored phase_plan is invalid: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleListProjectRequestOutlines(
  req: Request,
  id: string,
): Promise<Response> {
  const { row } = await loadOwnedRequest(req, id);
  return jsonResponse({ items: await projectRequestOutlineItems(row) });
}

/** The outline list of one loaded request, newest version first — shared with the agent's read. */
export async function projectRequestOutlineItems(row: { id: string; tenant_id: string }) {
  const rows = await db
    .select({ outline: projectOutlines, approval_status: approvals.status })
    .from(projectOutlines)
    // The tenant conjunct keeps the join inside the request's own workspace.
    .leftJoin(
      approvals,
      and(eq(approvals.id, projectOutlines.approval_id), eq(approvals.tenant_id, row.tenant_id)),
    )
    .where(eq(projectOutlines.request_id, row.id))
    .orderBy(desc(projectOutlines.version));
  // Plan phase labels are the request tenant's RM phase titles — read only when
  // some outline carries a plan (a legacy outline list needs no catalogue).
  const labels = rows.some((r) => r.outline.phase_plan !== null && r.outline.phase_plan !== undefined)
    ? await phaseTitles(row.tenant_id)
    : new Map<string, string>();
  return rows.map((r) => toOutlineListItem(r, labels));
}
