/**
 * fr-agui SPEC §13 P2 (P2-c2) — the project agent's OUTPUTS and LIFECYCLE actions.
 *
 *   artifacts.review           review an artifact of THIS project — approve / reject /
 *                              revise. ⛔ The HUMAN chooses, on the card: `decision` and
 *                              `comment` are `humanFields` (removed from the model's
 *                              schema and from any proposal), so the agent can surface
 *                              an artifact for review but can never pre-fill or make
 *                              the decision (fr is a facilitator, never a judge,
 *                              George 2026-10-12). Confirm = POST /api/assets/artifacts/:id/review.
 *   projects.provision         (re)provision this project's code container — the
 *                              Settings page's Provision button (POST /api/projects/:id/provision).
 *   projects.archive           archive this project — DESTRUCTIVE, a TYPED card: the human
 *                              types the project's name (`confirm_name`, a human field,
 *                              re-checked here against the project's stored name before
 *                              anything runs). Confirm = DELETE /api/projects/:id (purges
 *                              document PHI, tears the Planka board down; no RM write).
 *
 * ⭐ Each write is PROPOSED (a confirm card) and runs only on the human's Confirm
 * through POST /api/capabilities/:id/invoke, whose bearer is the human's Keycloak
 * token; the action then runs the project shell's OWN UI route AS THE HUMAN
 * (`callRouteAsHuman`, agui/actions/project-core.ts) — same identity, same gates
 * (P1-TEAM-a: any member of the project's tenant), same refusals verbatim, so the
 * agent can never do more than the button (SPEC §10.3 parity by construction).
 *
 * BOUND PROJECT ONLY: every action takes the project as `project_id` (`projectParam`,
 * hidden from the model, injected from the thread; the invoke route requires it and
 * re-checks read access). An artifact is accepted only when the artifact route,
 * asked for THIS project, answers it AND names this project (`project_mismatch`
 * otherwise) — the artifact route's own `assertProjectAccess` is a no-op today, so
 * the check lives here (P2-carry).
 *
 * `artifacts.download` (the FileCard, SPEC §5.5 / F15) lives with its siblings in
 * routes/assets/artifacts.ts.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction, ProposalSpec } from '../types';
import { AppError } from '../../utils/errors';
import { ProjectMismatchError } from '../../agent/project-binding';
import { bound, callRouteAsHuman, lazyRoute } from './project-core';

const anyOut = z.unknown();
const artifactRoutes = () => import('../../routes/assets/artifacts');
const projectRoutes = () => import('../../routes/projects');

/** `project_id`: the binding (hidden from the model; injected; required by the invoke route). */
const projectId = z.string().uuid().describe('The project (set from this conversation; never chosen by the model).');
/** The card's own idempotency key (stable per proposal); never the model's. */
const idempotencyKey = z.string().min(1).max(200).optional().describe('Set by the confirm card.');

export const REVIEW_DECISIONS = ['approve', 'reject', 'revise'] as const;

/** The confirm card of a project-output write: the invoke route, under the human's session. */
function card(name: string, kind: ProposalSpec['card'], humanFields?: readonly string[]): ProposalSpec {
  return {
    http: { method: 'POST', path: `/api/capabilities/${name}/invoke` },
    card: kind,
    ...(humanFields ? { humanFields } : {}),
  };
}

/** A human-confirmed write: runs on Confirm (initiator = the human; self-approves, no approval row). */
function write<I extends { project_id: string }>(
  name: string,
  description: string,
  input: z.ZodType<I>,
  confirm: ProposalSpec,
  key: (i: I) => string,
  run: (i: I, ctx: ActionContext, projectId: string) => Promise<unknown>,
): AgentCallableAction<I, unknown> {
  return {
    name,
    kind: 'write',
    description,
    input,
    output: anyOut,
    // The human's Confirm IS the approval: the sole approver is the initiator, so the
    // confirmed run executes inline (shouldSelfApprove) instead of parking an
    // approval only that same human could grant. A non-human initiator still parks.
    approval: { type: 'single-approver', approver: 'initiator' },
    autoApproveForInitiator: true,
    cronSafe: false,
    rbac: { type: 'project-member' },
    projectParam: 'project_id',
    webOnly: true,
    confirm,
    idempotencyKey: key,
    handler: async (i, ctx) => run(i, ctx, bound(ctx, name)),
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * The artifact, read through the artifact route for the BOUND project, as the
 * human — and it must name that project. An artifact of another project is the
 * upstream's 404 (the route asks for it under this project) or, should an answer
 * ever name another project, `project_mismatch`.
 */
export async function artifactOfBoundProject(
  action: string,
  pid: string,
  artifactId: string,
  ctx: ActionContext,
): Promise<Record<string, unknown>> {
  const body = (await callRouteAsHuman(
    action,
    {
      method: 'GET',
      template: '/api/assets/artifacts/:id',
      handler: lazyRoute(artifactRoutes, 'handleGetArtifact'),
      params: { id: artifactId },
      query: { project_id: pid },
    },
    ctx,
  )) as { data?: Record<string, unknown> } | null;
  const artifact = body?.data;
  const owner = typeof artifact?.project_id === 'string' ? artifact.project_id : '';
  if (!artifact || owner.toLowerCase() !== pid.toLowerCase()) throw new ProjectMismatchError(action, 'artifact_id', pid);
  return artifact;
}

const reviewInput = z.object({
  project_id: projectId,
  artifact_id: z.string().uuid().describe('An artifact of this project (from artifacts.list).'),
  decision: z.enum(REVIEW_DECISIONS).optional().describe('Chosen by the human on the card — never by the agent.'),
  comment: z.string().max(4000).optional().describe('Written by the human on the card — never by the agent.'),
  idempotency_key: idempotencyKey,
});
type ReviewInput = z.infer<typeof reviewInput>;

export const artifactsReviewAction = write<ReviewInput>(
  'artifacts.review',
  "Put one of this project's artifacts in front of the user for review. The USER decides on the card — approve, reject " +
    'or revise, with an optional comment; you never choose, suggest or pre-fill the decision. On their confirm the decision ' +
    "is recorded on the artifact and the workflow that produced it is told (the Artifacts page's Review action).",
  reviewInput,
  card('artifacts.review', 'artifact-review', ['decision', 'comment']),
  (i) => `artifacts.review:${i.project_id}:${i.artifact_id}:${i.decision ?? ''}:${i.idempotency_key ?? ''}`,
  async (i, ctx, pid) => {
    if (i.decision === undefined) {
      throw new AppError(422, 'artifacts.review: the decision is yours to make — choose approve, reject or revise on the card').withCode(
        'decision_required',
      );
    }
    await artifactOfBoundProject('artifacts.review', pid, i.artifact_id, ctx);
    return callRouteAsHuman(
      'artifacts.review',
      {
        method: 'POST',
        template: '/api/assets/artifacts/:id/review',
        handler: lazyRoute(artifactRoutes, 'handleSubmitArtifactReview'),
        params: { id: i.artifact_id },
        query: { project_id: pid },
        body: { decision: i.decision, ...(i.comment !== undefined && i.comment.trim() !== '' ? { comment: i.comment } : {}) },
      },
      ctx,
    );
  },
);

// ---------------------------------------------------------------------------
// Project settings: provision, archive
// ---------------------------------------------------------------------------

const provisionInput = z.object({ project_id: projectId, idempotency_key: idempotencyKey });
type ProvisionInput = z.infer<typeof provisionInput>;

export const projectsProvisionAction = write<ProvisionInput>(
  'projects.provision',
  "Provision (or re-provision) this project's code container from its primary repository: clone, initialise the code graph, " +
    "run the deep analysis — the project Settings page's Provision button. A project with no repository answers " +
    "provision.status 'not_applicable' (nothing to clone). Idempotent: provisioning again reuses the container.",
  provisionInput,
  card('projects.provision', 'capability-invoke'),
  (i) => `projects.provision:${i.project_id}:${i.idempotency_key ?? ''}`,
  async (_i, ctx, pid) =>
    callRouteAsHuman(
      'projects.provision',
      {
        method: 'POST',
        template: '/api/projects/:id/provision',
        handler: lazyRoute(projectRoutes, 'handleProvisionProject'),
        params: { id: pid },
      },
      ctx,
    ),
);

const archiveInput = z.object({
  project_id: projectId,
  confirm_name: z.string().max(500).optional().describe("Typed by the human on the card: the project's name — never by the agent."),
  idempotency_key: idempotencyKey,
});
type ArchiveInput = z.infer<typeof archiveInput>;

export const TYPED_CONFIRMATION_MISMATCH = 'typed_confirmation_mismatch';

export const projectsArchiveAction = write<ArchiveInput>(
  'projects.archive',
  "Archive this project — DESTRUCTIVE: its documents' downstream data is purged, its board is torn down and it leaves the " +
    "project lists (the Settings page's Archive). The user confirms by TYPING the project's name on the card; you never fill it in.",
  archiveInput,
  card('projects.archive', 'typed-confirm', ['confirm_name']),
  (i) => `projects.archive:${i.project_id}:${i.idempotency_key ?? ''}`,
  async (i, ctx, pid) => {
    // The typed name is checked HERE, server-side, against the stored name — a
    // card that skipped its own check still cannot archive.
    const project = (await callRouteAsHuman(
      'projects.archive',
      { method: 'GET', template: '/api/projects/:id', handler: lazyRoute(projectRoutes, 'handleGetProject'), params: { id: pid } },
      ctx,
    )) as { id?: unknown; name?: unknown } | null;
    const name = typeof project?.name === 'string' ? project.name.trim() : '';
    if (name === '' || (i.confirm_name ?? '').trim() !== name) {
      throw new AppError(422, "projects.archive: type the project's exact name on the card to confirm the archive").withCode(
        TYPED_CONFIRMATION_MISMATCH,
      );
    }
    await callRouteAsHuman(
      'projects.archive',
      { method: 'DELETE', template: '/api/projects/:id', handler: lazyRoute(projectRoutes, 'handleDeleteProject'), params: { id: pid } },
      ctx,
    );
    return { archived: pid, name };
  },
);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Every action this module registers. */
export const PROJECT_OUTPUT_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  artifactsReviewAction,
  projectsProvisionAction,
  projectsArchiveAction,
];

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** Production registrar (called by `registerAllActions`). */
export function registerProjectOutputActions(): void {
  for (const a of PROJECT_OUTPUT_ACTIONS) safeRegister(a);
}
