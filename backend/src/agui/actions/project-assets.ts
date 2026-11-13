/**
 * fr-agui SPEC §13 P2 — the project agent's PROJECT-ASSET actions (backend, P2-a).
 *
 *   repositories   projects.list_repositories · repositories.get (attached to THIS
 *                  project only) · projects.attach_repository ·
 *                  projects.detach_repository · projects.set_primary_repository
 *   documents      documents.list · documents.get_status (this project's documents)
 *   governed edit  project_assets.edit — OQ-16 (DECIDED a): copy-on-write
 *   PM library     the D12 RM read-only reads (handlers of capabilities/projects/assets.ts)
 *   governance     architecture.get_governance_conformance — the Governance tab's
 *                  conformance verdict (handler of capabilities/projects/assets.ts)
 *
 * ⭐ EVERY call runs the project shell's OWN UI route as the HUMAN
 * (`callRouteAsHuman`, agui/actions/project-core.ts): same identity, same gates,
 * same refusals, so the agent can never do more than the button (SPEC §10.3
 * parity by construction). A write is PROPOSED (a `capability-invoke` confirm
 * card); the human's Confirm reaches `POST /api/capabilities/:id/invoke`, whose
 * bearer IS the human's Keycloak token, and the action then calls the route.
 *
 * BOUND PROJECT ONLY: every action takes the project as `project_id`
 * (`projectParam`, hidden from the model and injected from the thread; the
 * invoke route requires it and re-checks read access). A repository / document
 * id is accepted only when it belongs to the bound project.
 *
 * Decisions (P2, conservative, in the SPEC P2 status line):
 *   - `projects.detach_repository` is a card, not a typed confirmation: the route
 *     refuses the primary (409), and a detached repository is re-attached with
 *     one click — reversible, so not "destructive" in the OQ-1 sense.
 *   - repositories stay USER-owned exactly as the routes keep them: attach /
 *     detach / set-primary act on the caller's own repository rows (the routes'
 *     `repositories.user_id` checks). Widening that to every tenant member is a
 *     route behaviour change, not an agent one; it is reported, not made here.
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction, ProposalSpec } from '../types';
import { ProjectMismatchError } from '../../agent/project-binding';
import { bound, callRouteAsHuman, lazyRoute } from './project-core';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import { AppError } from '../../utils/errors';
import { GOVERNANCE_ARCHITECTURE_CAPABILITIES, PROJECT_PM_CAPABILITIES } from '../../capabilities/projects/assets';

const anyOut = z.unknown();

/** The confirm card of a project-asset write: the invoke route, under the human's session. */
export function invokeCard(name: string): ProposalSpec {
  return { http: { method: 'POST', path: `/api/capabilities/${name}/invoke` }, card: 'capability-invoke' };
}

/** `project_id`: the binding (hidden from the model; injected; required by the invoke route). */
const projectId = z.string().uuid().describe('The project (set from this conversation; never chosen by the model).');

const repoRoutes = () => import('../../routes/project-repositories');
const documentRoutes = () => import('../../routes/documents');

const READ = {
  kind: 'read' as const,
  approval: { type: 'auto' as const },
  cronSafe: false,
  output: anyOut,
  rbac: { type: 'project-member' as const },
  projectParam: 'project_id',
};

/** A human-confirmed write: runs on Confirm (initiator = the human; self-approves, no approval row). */
function write<I extends { project_id: string }>(
  name: string,
  description: string,
  input: z.ZodType<I>,
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
    confirm: invokeCard(name),
    idempotencyKey: key,
    handler: async (i, ctx) => run(i, ctx, bound(ctx, name)),
  };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

interface RepoRow {
  repo_id: string;
  url?: string;
  is_primary?: boolean;
  [k: string]: unknown;
}

async function projectRepositories(action: string, pid: string, ctx: ActionContext): Promise<RepoRow[]> {
  const body = (await callRouteAsHuman(
    action,
    {
      method: 'GET',
      template: '/api/projects/:id/repositories',
      handler: lazyRoute(repoRoutes, 'handleListProjectRepositories'),
      params: { id: pid },
    },
    ctx,
  )) as { items?: RepoRow[] } | null;
  return Array.isArray(body?.items) ? body.items : [];
}

const repoId = z.string().uuid().describe('A repository attached to this project (its repo_id).');

export const PROJECT_REPOSITORY_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  {
    ...READ,
    name: 'projects.list_repositories',
    description: "The repositories attached to this project (primary first), as the project's Repositories page lists them.",
    input: z.object({ project_id: projectId }),
    idempotencyKey: (i: { project_id: string }) => `projects.list_repositories:${i.project_id}`,
    handler: async (_i: { project_id: string }, ctx: ActionContext) => {
      const pid = bound(ctx, 'projects.list_repositories');
      return { items: await projectRepositories('projects.list_repositories', pid, ctx) };
    },
  },
  {
    ...READ,
    name: 'repositories.get',
    description: 'One repository attached to this project. A repository that is not attached to this project is refused.',
    input: z.object({ project_id: projectId, repo_id: repoId }),
    idempotencyKey: (i: { project_id: string; repo_id: string }) => `repositories.get:${i.project_id}:${i.repo_id}`,
    handler: async (i: { repo_id: string }, ctx: ActionContext) => {
      const pid = bound(ctx, 'repositories.get');
      const row = (await projectRepositories('repositories.get', pid, ctx)).find((r) => r.repo_id === i.repo_id);
      // Only a repository OF THIS PROJECT is readable here (SPEC §13 P2 "for this
      // project only"): any other id — the caller's own repo elsewhere, another
      // member's, another tenant's — is one refusal.
      if (!row) throw new ProjectMismatchError('repositories.get', 'repo_id', pid);
      return { repository: row };
    },
  },
  write(
    'projects.attach_repository',
    "Attach a repository to this project: one the user registered (`repo_id`) or a git URL (`url`, optional `branch` / `name`). The project's Repositories page Attach button.",
    z
      .object({
        project_id: projectId,
        repo_id: z.string().uuid().optional(),
        url: z.string().min(1).max(2048).optional(),
        branch: z.string().min(1).max(255).optional(),
        name: z.string().min(1).max(255).optional(),
      })
      .refine((v) => Boolean(v.repo_id) !== Boolean(v.url), { message: 'exactly one of repo_id or url' }),
    (i) => `projects.attach_repository:${i.project_id}:${i.repo_id ?? ''}:${i.url ?? ''}:${i.branch ?? ''}`,
    (i, ctx, pid) =>
      callRouteAsHuman(
        'projects.attach_repository',
        {
          method: 'POST',
          template: '/api/projects/:id/repositories',
          handler: lazyRoute(repoRoutes, 'handleAttachProjectRepository'),
          params: { id: pid },
          body: i.repo_id ? { repo_id: i.repo_id } : { url: i.url, ...(i.branch ? { branch: i.branch } : {}), ...(i.name ? { name: i.name } : {}) },
        },
        ctx,
      ),
  ),
  write(
    'projects.detach_repository',
    'Detach a (non-primary) repository from this project. The route refuses the primary: promote another one first.',
    z.object({ project_id: projectId, repo_id: repoId }),
    (i) => `projects.detach_repository:${i.project_id}:${i.repo_id}`,
    async (i, ctx, pid) => {
      await callRouteAsHuman(
        'projects.detach_repository',
        {
          method: 'DELETE',
          template: '/api/projects/:id/repositories/:repo_id',
          handler: lazyRoute(repoRoutes, 'handleDetachProjectRepository'),
          params: { id: pid, repo_id: i.repo_id },
        },
        ctx,
      );
      return { detached: i.repo_id };
    },
  ),
  write(
    'projects.set_primary_repository',
    "Make an attached repository this project's primary (the one analyses and dispatch use).",
    z.object({ project_id: projectId, repo_id: repoId }),
    (i) => `projects.set_primary_repository:${i.project_id}:${i.repo_id}`,
    (i, ctx, pid) =>
      callRouteAsHuman(
        'projects.set_primary_repository',
        {
          method: 'PUT',
          template: '/api/projects/:id/repositories/:repo_id/primary',
          handler: lazyRoute(repoRoutes, 'handlePromoteProjectRepository'),
          params: { id: pid, repo_id: i.repo_id },
        },
        ctx,
      ),
  ),
];

// ---------------------------------------------------------------------------
// Documents (the upload is the FileCard, P2-b)
// ---------------------------------------------------------------------------

async function projectDocuments(action: string, pid: string, ctx: ActionContext): Promise<Array<Record<string, unknown>>> {
  const body = (await callRouteAsHuman(
    action,
    {
      method: 'GET',
      template: '/api/documents',
      handler: lazyRoute(documentRoutes, 'handleListUserDocuments'),
      params: {},
      query: { project_id: pid },
    },
    ctx,
  )) as unknown;
  // `GET /api/documents` answers `{ items, total }` (routes/documents.ts).
  const items = ((body ?? {}) as { items?: unknown }).items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

/**
 * fr-agui SPEC §5.5 / §13 P2-b — the FileCard upload. The agent PROPOSES it; the
 * card (frontend `FileUploadCard.svelte`) holds the file picker, and the file
 * goes from the BROWSER straight to the project's own upload route,
 * `POST /api/documents/upload` (multipart, `project_id` = this project, under
 * the human's session) — the route that streams the bytes to kag, where ClamAV
 * scans fail-closed before any parse (backend/CLAUDE.md "Document upload & virus
 * scanning"). The scanner stays the single enforcement seam: there is no second
 * path here, and the bytes never pass through the agent, the LLM or the thread.
 * The agent learns only `{fileName, size, mime, documentId}` (via
 * `documents.list` / `documents.get_status`).
 *
 * The confirm route is the upload route itself, so the invoke route
 * (`POST /api/capabilities/:id/invoke`, which serves only actions whose confirm
 * names it) can never run this action; the handler refuses on its own as well.
 */
export const DOCUMENT_UPLOAD_CONFIRM: ProposalSpec = { http: { method: 'POST', path: '/api/documents/upload' }, card: 'file-upload' };

export const documentsUploadAction: AgentCallableAction<{ project_id: string; purpose?: string; send_to_kag?: boolean }, unknown> = {
  name: 'documents.upload',
  kind: 'write',
  description:
    "Offer the user a card to upload a file into THIS project's documents (virus-scanned, then indexed as project knowledge). " +
    'The user picks the file in the card; you never see or send its contents. Say what the file is for in `purpose`.',
  input: z
    .object({
      project_id: projectId,
      purpose: z.string().min(1).max(500).optional().describe('What the file is for, shown on the card.'),
      send_to_kag: z.boolean().optional().describe('false: store and scan only, do not index as knowledge (default true).'),
    })
    .strict(),
  output: anyOut,
  approval: { type: 'single-approver', approver: 'initiator' },
  cronSafe: false,
  rbac: { type: 'project-member' },
  projectParam: 'project_id',
  webOnly: true,
  confirm: DOCUMENT_UPLOAD_CONFIRM,
  idempotencyKey: (i) => `documents.upload:${i.project_id}:${i.purpose ?? ''}:${i.send_to_kag === false ? 'nokag' : 'kag'}`,
  handler: async () => {
    throw new AppError(409, 'documents.upload: the file goes from the browser to POST /api/documents/upload through its FileCard; this action never runs').withCode(
      'file_card_only',
    );
  },
};

export const PROJECT_DOCUMENT_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  documentsUploadAction,
  {
    ...READ,
    name: 'documents.list',
    description: "This project's uploaded documents (name, status, size) — the ones the project's Knowledge page lists.",
    input: z.object({ project_id: projectId }),
    idempotencyKey: (i: { project_id: string }) => `documents.list:${i.project_id}`,
    handler: async (_i: unknown, ctx: ActionContext) => {
      const pid = bound(ctx, 'documents.list');
      return { documents: await projectDocuments('documents.list', pid, ctx) };
    },
  },
  {
    ...READ,
    name: 'documents.get_status',
    description: "The ingestion status of one of this project's documents (scanned, indexed, rejected, failed).",
    input: z.object({ project_id: projectId, document_id: z.string().min(1).max(64) }),
    idempotencyKey: (i: { project_id: string; document_id: string }) => `documents.get_status:${i.project_id}:${i.document_id}`,
    handler: async (i: { document_id: string }, ctx: ActionContext) => {
      const pid = bound(ctx, 'documents.get_status');
      const mine = (await projectDocuments('documents.get_status', pid, ctx)).some((d) => String(d.id) === i.document_id);
      if (!mine) throw new ProjectMismatchError('documents.get_status', 'document_id', pid);
      return callRouteAsHuman(
        'documents.get_status',
        {
          method: 'GET',
          template: '/api/documents/:id/status',
          handler: lazyRoute(documentRoutes, 'handleGetDocumentStatus'),
          params: { id: i.document_id },
        },
        ctx,
      );
    },
  },
];

// ---------------------------------------------------------------------------
// D12 — the read-only PM library (capability handlers; capabilities/projects/assets.ts)
// ---------------------------------------------------------------------------

const pmRoutes = () => import('../../routes/project-pm');

function pmRead(action: string, path: string, exportName: string) {
  return async (input: { id: string }, ctx: ActionContext): Promise<unknown> => {
    const pid = bound(ctx, action);
    if (input.id && input.id.toLowerCase() !== pid.toLowerCase()) throw new ProjectMismatchError(action, 'id', pid);
    return callRouteAsHuman(action, { method: 'GET', template: path, handler: lazyRoute(pmRoutes, exportName), params: { id: pid } }, ctx);
  };
}

export const pmProjectsRead = pmRead('projects.list_pm_projects', '/api/projects/:id/pm/projects', 'handleListProjectPmProjects');
export const pmProgrammesRead = pmRead('projects.list_pm_programmes', '/api/projects/:id/pm/programmes', 'handleListProjectPmProgrammes');
export const pmRisksRead = pmRead('projects.list_pm_risks', '/api/projects/:id/pm/risks', 'handleListProjectPmRisks');

// ---------------------------------------------------------------------------
// Governance — the project's architecture conformance (capability handler)
// ---------------------------------------------------------------------------

const conformanceRoutes = () => import('../../routes/governance/architecture/conformance');

/**
 * `architecture.get_governance_conformance`: the read behind the project's
 * Governance tab and the Architecture Governance dashboard
 * (frontend lib/api/governance.ts `getArchitectureConformance`). Runs the SAME
 * route — `GET /api/governance/architecture/conformance?projectId=` — as the
 * human, with the BOUND project as `projectId`, so it answers exactly what the
 * tab answers (same auth, same frame tenant, same 60 s cache). `fresh: 'true'`
 * is forwarded as the route's cache bypass.
 */
export async function governanceConformanceRead(input: { projectId?: string; fresh?: string }, ctx: ActionContext): Promise<unknown> {
  const action = 'architecture.get_governance_conformance';
  const pid = bound(ctx, action);
  if (input.projectId && input.projectId.toLowerCase() !== pid.toLowerCase()) throw new ProjectMismatchError(action, 'projectId', pid);
  return callRouteAsHuman(
    action,
    {
      method: 'GET',
      template: '/api/governance/architecture/conformance',
      handler: lazyRoute(conformanceRoutes, 'handleGetArchitectureConformance'),
      params: {},
      query: { projectId: pid, ...(input.fresh === 'true' ? { fresh: 'true' } : {}) },
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

/** The D12 PM reads, DERIVED from their declarations (SPEC §3.4 c). */
export const PROJECT_PM_ACTIONS: ReadonlyArray<AgentCallableAction> = PROJECT_PM_CAPABILITIES.map(
  (c) => deriveAgentAction(c) as AgentCallableAction,
);

/** The Governance tab's conformance read, DERIVED from its declaration (SPEC §3.4 c). */
export const PROJECT_GOVERNANCE_ACTIONS: ReadonlyArray<AgentCallableAction> = GOVERNANCE_ARCHITECTURE_CAPABILITIES.map(
  (c) => deriveAgentAction(c) as AgentCallableAction,
);

/** Every action this module registers. */
export const PROJECT_ASSET_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  ...PROJECT_REPOSITORY_ACTIONS,
  ...PROJECT_DOCUMENT_ACTIONS,
  ...PROJECT_PM_ACTIONS,
  ...PROJECT_GOVERNANCE_ACTIONS,
];

/** Production registrar (called by `registerAllActions`). */
export function registerProjectAssetActions(): void {
  for (const a of PROJECT_ASSET_ACTIONS) safeRegister(a);
}

