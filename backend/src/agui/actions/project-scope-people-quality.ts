/**
 * fr-agui SPEC §13 P2 (P2-c1) — the project agent's SCOPE, PEOPLE and QUALITY actions.
 *
 *   asset scope   project_assets.bind · project_assets.unbind (fr asset bindings,
 *                 routes/assets/bindings.ts) · project_assets.override ·
 *                 project_assets.block (routes/asset-scope/{override,block}.ts) —
 *                 always AT THE BOUND PROJECT (never a department, never another project)
 *   people        projects.get_knowledge_allocation (read) ·
 *                 projects.set_knowledge_allocation (card) — George 2026-10-16 (b):
 *                 any member of the project's tenant; `execution_signoff` untouchable
 *   quality       projects.get_quality · projects.get_quality_history (reads) ·
 *                 projects.analyze_quality (card; 202, or 409 while one is running)
 *
 * ⭐ EVERY call runs the project shell's OWN UI route as the HUMAN
 * (`callRouteAsHuman`, agui/actions/project-core.ts): same identity, same gates,
 * same refusals verbatim, so the agent can never do more than the button (SPEC
 * §10.3 parity by construction). A write is PROPOSED (a `capability-invoke`
 * confirm card); the human's Confirm reaches `POST /api/capabilities/:id/invoke`,
 * whose bearer IS the human's Keycloak token, and the action then calls the route.
 *
 * BOUND PROJECT ONLY: the project is `project_id` (writes; `projectParam`,
 * hidden from the model, injected from the thread, re-checked by the invoke
 * route) or `id` (the derived reads; a different id is refused
 * `project_mismatch`). No input names a project to act on: the bind body is
 * `[bound]`, unbind / override / block target the bound project, so a model can
 * never bind, hide or replace anything in another project.
 *
 * ⛔ Binding is NOT ownership (George 2026-10-16, P2-b): a bind or an override
 * row never makes an asset member-writable — the governed write gate
 * (routes/assets/_lib/governed-asset-write-gate.ts) owns that, and the override
 * route refuses the laundering shapes itself. Promote stays OUT (OQ-6).
 *
 * Asset side: the agent addresses exactly what the button addresses. The bind
 * route verifies the fr-local kinds (trigger, channel) against the caller's
 * tenant and leaves the upstream kinds read-path-gated (`findForeignAssets`);
 * that is the route's contract, unchanged here (P2-carry).
 */
import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { AppError } from '../../utils/errors';
import { ProjectMismatchError } from '../../agent/project-binding';
import { bound, callRouteAsHuman, lazyRoute } from './project-core';
import { invokeCard } from './project-assets';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import { assetType } from '../../db/client';
import {
  PROJECT_QUALITY_PEOPLE_CAPABILITIES,
  QUALITY_PEOPLE_READ_TABLE,
} from '../../capabilities/projects/quality-people';

const anyOut = z.unknown();

/** `project_id`: the binding (hidden from the model; injected; required by the invoke route). */
const projectId = z.string().uuid().describe('The project (set from this conversation; never chosen by the model).');
/** The card's own idempotency key (stable per proposal); never the model's. */
const idempotencyKey = z.string().min(1).max(200).optional().describe('Set by the confirm card.');

/** The asset kinds of fr's bindings and asset scope (single-sourced from the `asset_type` pgEnum). */
const kind = z.enum(assetType.enumValues).describe('The asset kind.');
const assetId = z.string().min(1).max(200).describe('The asset id, as the library lists it.');

const bindingRoutes = () => import('../../routes/assets/bindings');
const overrideRoutes = () => import('../../routes/asset-scope/override');
const blockRoutes = () => import('../../routes/asset-scope/block');
const qualityRoutes = () => import('../../routes/project-quality');
const allocationRoutes = () => import('../../routes/project-knowledge-allocation');

/** A human-confirmed write: runs on Confirm (initiator = the human; self-approves inline, no approval row). */
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
    // The human's Confirm IS the approval: the sole approver is the initiator, so
    // the confirmed run executes inline (shouldSelfApprove needs the opt-in)
    // instead of parking an approval only that same human could grant (the P2-c2
    // finding). A non-human initiator still parks.
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

const keyOf = (name: string, i: { project_id: string; idempotency_key?: string }, ...parts: string[]) =>
  `${name}:${i.project_id}:${parts.join(':')}:${i.idempotency_key ?? ''}`;

// ---------------------------------------------------------------------------
// Asset scope at the bound project
// ---------------------------------------------------------------------------

const scopeInput = z.object({ project_id: projectId, kind, asset_id: assetId, idempotency_key: idempotencyKey }).strict();
type ScopeInput = z.infer<typeof scopeInput>;
const overrideInput = z
  .object({
    project_id: projectId,
    kind,
    asset_id: assetId.describe('The inherited asset this project replaces.'),
    candidate_asset_id: z.string().min(1).max(200).describe("The replacement: a copy created in THIS project (project_assets.edit makes one)."),
    idempotency_key: idempotencyKey,
  })
  .strict();
type OverrideInput = z.infer<typeof overrideInput>;

export const PROJECT_SCOPE_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  write<ScopeInput>(
    'project_assets.bind',
    "Bind an asset of this workspace to THIS project (it joins the project's scope; n8n treats bound assets as in scope here). " +
      'A binding is not ownership: it never makes an original editable by members.',
    scopeInput,
    (i) => keyOf('project_assets.bind', i, i.kind, i.asset_id),
    (i, ctx, pid) =>
      callRouteAsHuman(
        'project_assets.bind',
        {
          method: 'POST',
          template: '/api/assets/:kind/:id/bindings',
          handler: lazyRoute(bindingRoutes, 'handleBindAsset'),
          params: { kind: i.kind, id: i.asset_id },
          body: { project_ids: [pid] },
        },
        ctx,
      ),
  ),
  write<ScopeInput>(
    'project_assets.unbind',
    'Remove an asset\'s binding to THIS project (the asset itself is untouched; other projects keep theirs).',
    scopeInput,
    (i) => keyOf('project_assets.unbind', i, i.kind, i.asset_id),
    async (i, ctx, pid) => {
      await callRouteAsHuman(
        'project_assets.unbind',
        {
          method: 'DELETE',
          template: '/api/assets/:kind/:id/bindings/:project_id',
          handler: lazyRoute(bindingRoutes, 'handleUnbindAsset'),
          params: { kind: i.kind, id: i.asset_id, project_id: pid },
        },
        ctx,
      );
      return { unbound: { kind: i.kind, asset_id: i.asset_id, project_id: pid } };
    },
  ),
  write<OverrideInput>(
    'project_assets.override',
    "Record, for THIS project, that an inherited asset is replaced by the project's own copy (`candidate_asset_id`, created in this " +
      'project). The route refuses a self-override and a candidate not created in this project.',
    overrideInput,
    (i) => keyOf('project_assets.override', i, i.kind, i.asset_id, i.candidate_asset_id),
    (i, ctx, pid) =>
      callRouteAsHuman(
        'project_assets.override',
        {
          method: 'POST',
          template: '/api/asset-scope/:assetType/:assetId/override',
          handler: lazyRoute(overrideRoutes, 'handleOverride'),
          params: { assetType: i.kind, assetId: i.asset_id },
          body: { project_id: pid, candidate_asset_id: i.candidate_asset_id },
        },
        ctx,
      ),
  ),
  write<ScopeInput>(
    'project_assets.block',
    'Hide an inherited asset from THIS project\'s effective set (a block row at this project; the asset itself is untouched).',
    scopeInput,
    (i) => keyOf('project_assets.block', i, i.kind, i.asset_id),
    (i, ctx, pid) =>
      callRouteAsHuman(
        'project_assets.block',
        {
          method: 'POST',
          template: '/api/asset-scope/:assetType/:assetId/block',
          handler: lazyRoute(blockRoutes, 'handleBlock'),
          params: { assetType: i.kind, assetId: i.asset_id },
          body: { project_id: pid },
        },
        ctx,
      ),
  ),
];

// ---------------------------------------------------------------------------
// People (knowledge allocation) and quality — writes
// ---------------------------------------------------------------------------

const allocationInput = z
  .object({
    project_id: projectId,
    user_id: z.string().uuid().describe('A member of this workspace (from projects.get_knowledge_allocation).'),
    areas: z.array(z.string().min(1).max(200)).max(64).describe("The member's FULL allocation on this project after the change (replaces it; [] = none)."),
    idempotency_key: idempotencyKey,
  })
  .strict();
type AllocationInput = z.infer<typeof allocationInput>;

const analyzeInput = z.object({ project_id: projectId, idempotency_key: idempotencyKey }).strict();
type AnalyzeInput = z.infer<typeof analyzeInput>;

export const PROJECT_PEOPLE_QUALITY_WRITES: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  write<AllocationInput>(
    'projects.set_knowledge_allocation',
    "Set one member's knowledge-area allocation on THIS project (full replacement). Areas are the workspace's knowledge areas " +
      '(projects.get_knowledge_allocation shows each member\'s). The execution sign-off roster is never changed here.',
    allocationInput,
    (i) => keyOf('projects.set_knowledge_allocation', i, i.user_id, [...i.areas].sort().join(',')),
    (i, ctx, pid) =>
      callRouteAsHuman(
        'projects.set_knowledge_allocation',
        {
          method: 'PUT',
          template: '/api/projects/:id/knowledge-allocation/:userId',
          handler: lazyRoute(allocationRoutes, 'handleSetProjectMemberKnowledgeAllocation'),
          params: { id: pid, userId: i.user_id },
          body: { areas: i.areas },
        },
        ctx,
      ),
  ),
  write<AnalyzeInput>(
    'projects.analyze_quality',
    "Start a code-quality analysis of this project's repositories (the Quality tab's Analyze button): 202 started; refused 409 " +
      "'analysis_in_progress' while one is already running. Results land in projects.get_quality later — never report a grade before then.",
    analyzeInput,
    (i) => keyOf('projects.analyze_quality', i),
    (_i, ctx, pid) =>
      callRouteAsHuman(
        'projects.analyze_quality',
        {
          method: 'POST',
          template: '/api/projects/:id/quality/analyze',
          handler: lazyRoute(qualityRoutes, 'handleAnalyzeProjectQuality'),
          params: { id: pid },
        },
        ctx,
      ),
  ),
];

// ---------------------------------------------------------------------------
// Reads (handlers of capabilities/projects/quality-people.ts)
// ---------------------------------------------------------------------------

const READ_ROUTES: Record<string, () => Promise<Record<string, unknown>>> = {
  'projects.get_quality': qualityRoutes,
  'projects.get_quality_history': qualityRoutes,
  'projects.get_knowledge_allocation': allocationRoutes,
};

function projectRead(id: string) {
  const row = QUALITY_PEOPLE_READ_TABLE.find((r) => r.id === id);
  const load = READ_ROUTES[id];
  if (!row || !load) throw new Error(`no quality/people read ${id}`);
  return async (input: Record<string, unknown>, ctx: ActionContext): Promise<unknown> => {
    const pid = bound(ctx, id);
    if (typeof input.id === 'string' && input.id !== '' && input.id.toLowerCase() !== pid.toLowerCase()) {
      throw new ProjectMismatchError(id, 'id', pid);
    }
    const query = Object.fromEntries(row.query.map((q) => [q, input[q] === undefined || input[q] === null ? undefined : String(input[q])]));
    const body = (await callRouteAsHuman(
      id,
      { method: 'GET', template: row.path, handler: lazyRoute(load, row.handler), params: { id: pid }, query },
      ctx,
    )) as { data?: { project_id?: unknown } } | null;
    // The quality read names its project — checked, not trusted (SPEC §13 P3 acceptance).
    if (id === 'projects.get_quality') {
      const named = body?.data?.project_id;
      if (typeof named !== 'string' || named.toLowerCase() !== pid.toLowerCase()) {
        throw new AppError(502, `${id}: the route answered for a different project`).withCode('project_answer_mismatch');
      }
    }
    return body;
  };
}

export const getQualityRead = projectRead('projects.get_quality');
export const getQualityHistoryRead = projectRead('projects.get_quality_history');
export const getKnowledgeAllocationRead = projectRead('projects.get_knowledge_allocation');

/** The three reads, DERIVED from their declarations (SPEC §3.4 c). */
export const PROJECT_QUALITY_PEOPLE_READS: ReadonlyArray<AgentCallableAction> = PROJECT_QUALITY_PEOPLE_CAPABILITIES.map(
  (c) => deriveAgentAction(c) as AgentCallableAction,
);

/** Every action this module registers. */
export const PROJECT_SCOPE_PEOPLE_QUALITY_ACTIONS: ReadonlyArray<AgentCallableAction<any, unknown>> = [
  ...PROJECT_SCOPE_ACTIONS,
  ...PROJECT_PEOPLE_QUALITY_WRITES,
  ...PROJECT_QUALITY_PEOPLE_READS,
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
export function registerProjectScopePeopleQualityActions(): void {
  for (const a of PROJECT_SCOPE_PEOPLE_QUALITY_ACTIONS) safeRegister(a);
}
