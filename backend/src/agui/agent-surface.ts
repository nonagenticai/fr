/**
 * fr-agui SPEC §13 P1c — RETIRE THE TENANT RAIL (OQ-17 = c, George 2026-10-14).
 *
 * "Removed at the end of P1c. Project-scoped actions are re-homed into the
 * project agent, the doorway rail stays, and the UI keeps every capability."
 *
 * Three disjoint sets cover EVERY registered AG-UI action:
 *
 *   PROJECT  the project agent's catalog = the `project-core` pack
 *            (agent/packs/project-core/capabilities.json). Bound project only.
 *   DOORWAY  the doorway agent's catalog = the `request-intake` pack.
 *   RETIRED  `catalog: 'none'` — in NO agent catalog. Stamped at registration
 *            (`agui/registry.ts registerAction`) from the list below, which is
 *            §13 P1c's "Retired from the agent" list verbatim plus "any
 *            remaining action whose target is not the bound project".
 *
 * WHO IS AFFECTED (`agentSurfaceRefusal`, run by `assertRbac` — the seam both
 * the catalog dry-run and `invokeAction` call):
 *   - the AG-UI RAIL (`/api/agent/chat`, `/api/agui/invoke`; contexts marked
 *     server-side by `markAgentTokenContext`): a bound thread may use PROJECT
 *     members only, an unbound one DOORWAY members only. The client can no
 *     longer pick a wider catalog (P1b carry: the doorway rode on a client-sent
 *     `mode`).
 *   - the CHANNEL AGENT (the LLM / `<tool>.<verb> {json}` resolvers, initiator
 *     `agent` on a dispatcher-marked context): RETIRED actions are refused.
 *   - NOT affected: the deterministic channel grammar (`approve`, `reject`,
 *     `start`, `card`, `comment`, `status`, `help` — initiator `human`), the
 *     REST tools routes (`/api/tools/*`, `assets/artifacts`; initiator from the
 *     request, context unmarked), and a deferred approval's execution
 *     (`resolvePendingAction`, its own context). That is why no route is
 *     removed and every retired module stays in `register-all-actions.ts`.
 *
 * ⛔ Env-free: rbac.ts and the CI guards import this.
 */
import { DOORWAY_INTAKE_ACTIONS } from '../agent/intake-catalog';
import { packCore, packMembers, packSearchable } from '../agent/packs';
import { isAgentTokenContext, isChannelDispatched } from './context-provenance';
import type { ActionContext } from './types';

/** The project agent's whole set (core ∪ searchable). */
export const PROJECT_AGENT_ACTIONS: ReadonlySet<string> = packMembers('project-core');
/** Sent every turn in a bound thread. */
export const PROJECT_AGENT_CORE: ReadonlySet<string> = packCore('project-core');
/** Offered in a bound thread only after `capabilities.search` returned them there. */
export const PROJECT_AGENT_SEARCHABLE: ReadonlySet<string> = packSearchable('project-core');

/**
 * Declared project members no unit has registered yet. Exact, shrink-only: a
 * member that becomes registered must be deleted here (the surface test fails
 * until it is).
 */
export const PROJECT_AGENT_NOT_YET_REGISTERED: ReadonlySet<string> = new Set<string>([]);

/** Whole namespaces retired from the agent (`<ns>.*`). §13 P1c verbatim. */
export const RETIRED_FROM_AGENT_NAMESPACES: ReadonlySet<string> = new Set([
  'workers',
  'kag',
  'research',
  'media',
  'pm',
  'pm_catalogue',
  'analytics',
  'streams',
  'bridge',
  // "any remaining action whose target is not the bound project":
  // quality_history.* reads a TENANT library asset's quality history by id.
  'quality_history',
]);

/** Single actions retired from the agent. §13 P1c verbatim, plus the remaining non-project targets. */
export const RETIRED_FROM_AGENT_ACTIONS: ReadonlySet<string> = new Set([
  'secrets.list',
  'n8n.get_execution',
  'n8n.list_workflows',
  'n8n.trigger_workflow',
  'channels.send_message',
  'status.summary',
  'help.list_commands',
  'agent.search_library',
  // "any remaining action whose target is not the bound project":
  'channels.preview_message', // a tenant channel (channels are never project-scoped, Spec 1 §6.5)
]);

export function isRetiredFromAgent(actionName: string): boolean {
  if (RETIRED_FROM_AGENT_ACTIONS.has(actionName)) return true;
  const dot = actionName.indexOf('.');
  return dot > 0 && RETIRED_FROM_AGENT_NAMESPACES.has(actionName.slice(0, dot));
}

/**
 * fr-agui SPEC §5.7 rule 3 for the HAND-WRITTEN re-homed actions (a capability
 * derives its `projectParam` from its `/api/projects/:<param>` path instead).
 *
 *   projectParam  the input key that SCOPES the action to a project. In a bound
 *                 thread it is removed from the LLM-facing schema and set to the
 *                 bound project (`bindProjectInput`), so a list can only ever
 *                 answer for this project ("bound project only").
 *                 `visible_in` (fr asset bindings: bound to the project, plus
 *                 assets bound to no project) is the project's view of a library.
 *   hide          further keys that name a project and are NOT the model's to
 *                 fill in a bound thread (removed from the schema; a value that
 *                 is not the bound project is refused `project_mismatch`).
 *
 * Actions addressed by an asset id (`requirements.get {rid}`, `toc.get_graph
 * {tree_id}`, `coding.get_job_status {job_id}`, …) are NOT re-checked against
 * the bound project here: proving an asset belongs to a project is the P2
 * project-asset unit (SPEC §13 P2, OQ-16). Recorded in the P1c SPEC status line.
 */
export const PROJECT_BINDING: ReadonlyMap<string, { projectParam?: string; hide?: readonly string[] }> = new Map([
  // P2: the project agent's confirmed writes name their project in `project_id`
  // (injected from the thread; the invoke route requires it in the body).
  ['kanban.create_card', { projectParam: 'project_id', hide: ['project_ref'] }],
  ['kanban.add_comment', { projectParam: 'project_id' }],
  ['agent.create_asset', { projectParam: 'project_id' }],
  ['agent.update_asset', { projectParam: 'project_id' }],
  ['coding.trigger_analysis', { projectParam: 'project_id' }],
  ['kanban.verify_liveness', { projectParam: 'projectId' }],
  ['n8n.list_executions', { projectParam: 'projectId' }],
  ['artifacts.list', { projectParam: 'project_id' }],
  ['artifacts.get', { projectParam: 'project_id' }],
  ['artifacts.preview', { projectParam: 'project_id' }],
  ['artifacts.manifest', { projectParam: 'project_id' }],
  ['artifacts.download', { projectParam: 'project_id' }],
  ['requirements.list', { projectParam: 'visible_in', hide: ['project_id', 'bound_to'] }],
  ['decisions.list', { projectParam: 'visible_in', hide: ['project_id', 'bound_to'] }],
  ['principles.list', { projectParam: 'visible_in', hide: ['bound_to'] }],
  ['requirements.search', { projectParam: 'visible_in' }],
  ['decisions.search', { projectParam: 'visible_in' }],
  ['principles.search', { projectParam: 'visible_in' }],
  ['toc.list_trees', { projectParam: 'project_id' }],
  ['toc.get_config', { projectParam: 'project_id' }],
  ['toc.build_io_map', { projectParam: 'project_id' }],
  ['toc.evaporate_conflict', { projectParam: 'project_id' }],
  ['toc.evaluate_lenses', { projectParam: 'project_id' }],
  ['architecture.list_elements', { projectParam: 'project_id' }],
  ['architecture.list_relationships', { projectParam: 'project_id' }],
  ['architecture.list_standards', { projectParam: 'project_id' }],
  ['architecture.list_views', { projectParam: 'project_id' }],
  // The Governance tab's conformance read (a capability whose route takes the
  // project as the `projectId` QUERY filter, so derive-agent finds no path param).
  ['architecture.get_governance_conformance', { projectParam: 'projectId' }],
  ['architecture.list_models', { projectParam: 'project_id' }],
  ['architecture.list_uml_elements', { projectParam: 'project_id' }],
  ['architecture.list_uml_relationships', { projectParam: 'project_id' }],
  ['architecture.list_uml_interactions', { projectParam: 'project_id' }],
  ['architecture.list_uml_diagrams', { projectParam: 'project_id' }],
]);

/**
 * SPEC §4.1: in a BOUND rail context every project-agent tool is gated by the
 * bound project's membership rule, whatever its own (weaker) rule says — the
 * caller of `assertRbac` evaluates `project-member` first when this is true.
 */
export function projectAgentMembershipApplies(action: { name: string }, ctx: ActionContext): boolean {
  return (
    ctx.initiator === 'agent' &&
    isAgentTokenContext(ctx) &&
    typeof ctx.projectId === 'string' &&
    ctx.projectId.length > 0 &&
    PROJECT_AGENT_ACTIONS.has(action.name)
  );
}

/** Refusal codes (RbacDeniedError.code). */
export const RETIRED_FROM_AGENT = 'rbac_retired_from_agent';
export const NOT_IN_PROJECT_AGENT = 'rbac_not_in_project_agent';
export const NOT_IN_DOORWAY = 'rbac_not_in_doorway_agent';

export interface SurfaceRefusal {
  code: string;
  reason: string;
}

/**
 * Why the AGENT may not use `action` in `ctx`, or null. Pure; `assertRbac`
 * turns a refusal into `RbacDeniedError` before the action's own rule runs.
 */
export function agentSurfaceRefusal(
  action: { name: string; catalog?: 'none' },
  ctx: ActionContext,
): SurfaceRefusal | null {
  if (ctx.initiator !== 'agent') return null;
  const rail = isAgentTokenContext(ctx);
  if (!rail && !isChannelDispatched(ctx)) return null;
  if (action.catalog === 'none' || isRetiredFromAgent(action.name)) {
    return {
      code: RETIRED_FROM_AGENT,
      reason: 'this action is retired from the agent (OQ-17 = c); it stays available in the fr UI',
    };
  }
  if (!rail) return null;
  if (typeof ctx.projectId === 'string' && ctx.projectId.length > 0) {
    return PROJECT_AGENT_ACTIONS.has(action.name)
      ? null
      : { code: NOT_IN_PROJECT_AGENT, reason: "this action is not one of this project agent's tools" };
  }
  return DOORWAY_INTAKE_ACTIONS.has(action.name)
    ? null
    : {
        code: NOT_IN_DOORWAY,
        reason: 'outside a project the agent can only start work (create a project or a request); open a project to use its agent',
      };
}
