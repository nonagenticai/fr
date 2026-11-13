// fr-agui SPEC §13 P2 — project-asset route groups declared as capabilities.
//
//   * D12 (George 2026-10-14, SPEC §16): the READ-ONLY PM library, restored as
//     five PROJECT reads over requirements_management (routes/project-pm.ts).
//     tenancy 'project', agent-exposed to the project agent (searchable tier):
//     the project comes from the thread (`/api/projects/:id`, SPEC §5.7 rule 3).
//     The agent action runs the route itself as the human
//     (agui/actions/project-assets.ts `pm*Read`), so it answers exactly what the
//     PM library page answers.
//   * The `/api/governance/architecture/conformance` read (routes/governance/
//     architecture/conformance.ts), left pinned by P4c for this unit — declared
//     with NO route behaviour change (`legacyHandler`). The route takes the
//     project as a QUERY filter on tenant-scoped RM data and fr applies no
//     project gate (tenancy 'tenant', stated rather than implied). It is
//     agent-exposed to the project agent (searchable tier) so the Governance
//     tab's conformance verdict is askable (George 2026-10-27, UI ⇔ agent
//     parity): the action runs this same route as the human on the BOUND
//     project (agui/actions/project-assets.ts `governanceConformanceRead`;
//     `projectId` is injected from the thread, agui/agent-surface.ts
//     PROJECT_BINDING). Its sibling containers read (and the
//     `architecture.list_containers` action) fed only the removed proposals
//     queue's container picker and went with it.
//   * The PROJECT andon cord (`/api/projects/:id/andon/*`, routes/andon.ts),
//     declared with NO behaviour change and `out-of-agent-scope`: it is
//     SUPER-ADMIN only (`requireSuperAdmin`), a platform privilege, never
//     agent-exposed (OQ-6).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import { defineCapability, type Capability, type ResponseSpec } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { isAuthenticatedSuperAdmin, isAuthenticatedUserInFrameTenant, isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, libraryCapabilities, pathId, routeRule, unauthorizedBody } from '../library/_shared';
import { LICENCE_ROUTE_DOOR_403, preHandlerRefusalBody } from '../settings/_shared';

// ---------------------------------------------------------------------------
// D12 — the project's read-only PM library
// ---------------------------------------------------------------------------

const projectPath = z.object({ id: z.string().uuid().describe('The project id') });
const rows = (what: string) => z.object({ data: z.array(z.unknown()).describe(what) });

const PM_RESPONSES: ResponseSpec[] = [
  { status: 401, description: "validateAuth's 401 (`error`: 'Missing or invalid Authorization header' / 'Invalid or expired token').", schema: z.object({ error: z.string() }) },
  { status: 404, description: "`error` 'Project not found': absent, not readable by the caller (another tenant's), or not a uuid — one answer.", schema: frErrorBody },
  {
    status: 'default',
    description:
      "403: validateAuth's route doors (`code` 'licence_route_not_allowed', 'conveyor_route_forbidden'). 409: `code` " +
      "'project_tenant_unknown' (the project carries no tenant tag, so its RM tenant cannot be named). Any other status is " +
      "requirements_management's, relayed (`error.code` 'UPSTREAM_…'), or fr's own 500.",
    schema: frErrorBody,
  },
];

interface PmRead {
  id: `${string}.${string}`;
  path: string;
  handler: string;
  readExport: string;
  summary: string;
  what: string;
}

const PM_READS: PmRead[] = [
  { id: 'projects.list_pm_projects', path: '/api/projects/:id/pm/projects', handler: 'handleListProjectPmProjects', readExport: 'pmProjectsRead', summary: "This project's PM projects in requirements_management (read-only)", what: 'The RM pm_projects minted for this fr project (origin_project_id = the project), its type, phase and schedule fields.' },
  { id: 'projects.list_pm_programmes', path: '/api/projects/:id/pm/programmes', handler: 'handleListProjectPmProgrammes', readExport: 'pmProgrammesRead', summary: "The programmes this project's PM projects belong to (read-only)", what: 'One row per distinct programme_id of the project\'s pm_projects.' },
  { id: 'projects.list_pm_risks', path: '/api/projects/:id/pm/risks', handler: 'handleListProjectPmRisks', readExport: 'pmRisksRead', summary: "This project's PM risks (read-only)", what: "The risks of the project's pm_projects (re-filtered on project_id)." },
];

const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export const PROJECT_PM_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = PM_READS.map((r) =>
  defineCapability({
    id: r.id,
    area: 'projects',
    summary: r.summary,
    description:
      `${r.what} Sourced from requirements_management in the PROJECT's tenant; read-only — PM editing stays in RM ` +
      '(SPEC §16 D12). Any member of the project\'s tenant may read it (P1-TEAM-a).',
    http: { method: 'GET', path: r.path, operationId: camel(r.id) },
    input: projectPath,
    output: rows(r.what),
    errors: [],
    // The route's gate is validateAuth + loadProjectForRead; the agent's is the
    // bound project's membership (the project agent's implicit rule, SPEC §4.1)
    // AND the route itself, which the agent action runs as the human.
    auth: { principal: 'user', rbac: { type: 'project-member' } },
    tenancy: 'project',
    effect: 'read',
    confirm: 'none',
    rmOwned: ['phase', 'structure'],
    agent: {
      expose: true,
      tier: 'searchable',
      cronSafe: false,
      idempotencyKey: (i: unknown) => `${r.id}:${(i as { id?: string }).id ?? ''}`,
    },
    openapi: { tags: ['Projects'], responses: PM_RESPONSES },
    handler: lazyActionHandler(() => import('../../agui/actions/project-assets'), {
      module: 'src/agui/actions/project-assets.ts',
      exportName: r.readExport,
    }),
    legacyHandler: lazyHandler(() => import('../../routes/project-pm'), { module: 'src/routes/project-pm.ts', exportName: r.handler }),
  }),
);

// ---------------------------------------------------------------------------
// /api/governance/architecture/conformance (1) — declared, no route behaviour change
// ---------------------------------------------------------------------------

const govQuery = {
  projectId: z
    .string()
    .min(1)
    .describe(
      'Required (else 400). Forwarded to requirements_management as the project filter; fr itself does not check it. ' +
        'The project agent never names it: fr sets it to the bound project.',
    ),
  fresh: z.string().optional().describe("'true' bypasses fr's 60 s cache and re-runs the analysis now."),
};

const GOV_RESPONSES: ResponseSpec[] = [
  { status: 400, description: "`error` 'projectId query param required'.", schema: z.object({ error: z.string() }) },
  { status: 401, description: "`error` 'unauthorized' (the handler flattens validateAuth's 401 itself).", schema: z.object({ error: z.literal('unauthorized') }) },
  {
    status: 'default',
    description:
      "403: validateAuth's route doors (`code` 'licence_route_not_allowed', 'conveyor_route_forbidden'). 409: `error.code` " +
      "'MISSING_TENANT' (no request tenant: nothing sent). Any other status is requirements_management's, relayed, or fr's own 500.",
    schema: frErrorBody,
  },
];

const cached = z.object({ data: z.unknown(), meta: z.object({ cached: z.boolean() }) });

export const GOVERNANCE_ARCHITECTURE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    id: 'architecture.get_governance_conformance',
    area: 'architecture',
    summary: "A project's architecture conformance (requirements_management, cached 60 s)",
    description:
      "The verdict the project's Governance tab and the Architecture Governance dashboard show: `data.summary` " +
      '(realization_coverage, conformance_score, illegal_count, unrealized_components, orphan_artifacts), ' +
      '`data.realization_coverage` (realized / unrealized Application Components, orphan artifacts, unbound code units), ' +
      '`data.dependency_conformance` (matched / missing / extra dependency edges) and `data.illegal_dependencies` ' +
      '(layer-order violations); `meta.cached` says whether it came from the 60 s cache. ' +
      '`realization_coverage.total_application_components` = 0 means NO architecture model yet (the 1.0 coverage is then ' +
      'not a perfect score). Read-only; any member of the tenant may read it.',
    http: { method: 'GET', path: '/api/governance/architecture/conformance', operationId: 'architectureGetGovernanceConformance' },
    input: z.object(govQuery),
    output: cached,
    errors: [],
    // The route's gate is validateAuth + a frame tenant (the RM client refuses to
    // send without one); in a bound thread the agent is ALSO gated by the bound
    // project's membership (SPEC §4.1) and runs the route itself as the human.
    auth: { principal: 'user', rbac: routeRule(isAuthenticatedUserInFrameTenant)({ method: 'GET', path: '/api/governance/architecture/conformance' }) },
    tenancy: 'tenant',
    effect: 'read',
    confirm: 'none',
    agent: {
      expose: true,
      // Core (George 2026-10-28): architecture is always in the project agent's catalog.
      tier: 'core',
      cronSafe: false,
      idempotencyKey: (i: unknown) => {
        const q = i as { projectId?: string; fresh?: string };
        return `architecture.get_governance_conformance:${q.projectId ?? ''}:${q.fresh === 'true' ? 'fresh' : ''}`;
      },
    },
    openapi: { tags: ['Architecture'], responses: GOV_RESPONSES },
    handler: lazyActionHandler(() => import('../../agui/actions/project-assets'), {
      module: 'src/agui/actions/project-assets.ts',
      exportName: 'governanceConformanceRead',
    }),
    legacyHandler: lazyHandler(() => import('../../routes/governance/architecture/conformance'), {
      module: 'src/routes/governance/architecture/conformance.ts',
      exportName: 'handleGetArchitectureConformance',
    }),
  }),
];

// ---------------------------------------------------------------------------
// /api/projects/:id/andon/* (2) — the PROJECT cord, super-admin only
// ---------------------------------------------------------------------------

const project = z.object({ id: pathId('Project id (a uuid; anything else answers the same 404 as an absent project)') });

/** routes/andon.ts `authErrorToResponse`: the auth refusals are flattened to these two bodies. */
const ANDON_RESPONSES: ResponseSpec[] = [
  { status: 401, description: "`error`: 'unauthorized' (no / an invalid / an expired bearer).", schema: z.object({ error: z.literal('unauthorized') }) },
  {
    status: 403,
    description:
      "`error`: 'forbidden' — not a super_admin, or the conveyor identity (validateAuth's write door, flattened by the route). " +
      // P4d-1 (real-pipeline parity): a licence token never reaches the route — the server's licence route door answers first.
      'A licence-shaped bearer: `{ error, code }`, ' + LICENCE_ROUTE_DOOR_403,
    schema: z.union([z.object({ error: z.literal('forbidden') }), preHandlerRefusalBody]),
  },
  {
    status: 404,
    description: "`error`: 'project_not_found' — absent, not a uuid, or not a PLATFORM tenant's project (fr row 14c).",
    schema: z.object({ error: z.literal('project_not_found') }),
  },
  { status: 'default', description: "fr's own 500 (`{ error }`), e.g. the database is unreachable.", schema: z.object({ error: z.string() }) },
];

export const PROJECT_ANDON_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = libraryCapabilities(
  {
    area: 'andon',
    tag: 'Andon',
    tenancy: 'platform',
    module: 'src/routes/andon.ts',
    load: () => import('../../routes/andon'),
    rule: routeRule(isAuthenticatedSuperAdmin),
    responses: ANDON_RESPONSES,
    output: z.object({ andon_engaged: z.boolean() }),
  },
  [
    {
      id: 'andon.engage_project', method: 'POST', path: '/api/projects/:id/andon/engage', handler: 'handleEngageProjectAndon',
      summary: "Engage a platform project's andon cord (super-admin)", effect: 'destructive', input: project,
      description: 'No request body. Idempotent: engaging an engaged cord answers the same 200.',
    },
    {
      id: 'andon.disengage_project', method: 'POST', path: '/api/projects/:id/andon/disengage', handler: 'handleDisengageProjectAndon',
      summary: "Release a platform project's andon cord (super-admin)", effect: 'write', input: project,
      description: 'No request body. Refused (409) while the global andon cord is engaged.',
      responses: [
        ...ANDON_RESPONSES,
        { status: 409, description: "`error`: 'global_andon_engaged' (with a human `message`): release the global cord first.", schema: z.object({ error: z.literal('global_andon_engaged'), message: z.string() }) },
      ],
    },
  ],
);

// ---------------------------------------------------------------------------
// The project cord's read
// ---------------------------------------------------------------------------
//
//   projects.get_andon   GET  /api/projects/:id/andon   any member of the project's tenant, and the
//                                                       tenant's licence (projects.getProjectAndon:
//                                                       the conveyor's andon gate)
//
// Agent-exposed (the project agent's halt read, handler in agui/actions/kanban-card.ts, run as
// the human). R349 retired R318's board-move hold, its release-move and resume routes.

const andonView = z.object({
  project_id: z.string().uuid(),
  engaged: z.boolean(),
  reason: z.literal('operator').nullable().describe("'operator' while engaged (a platform operator's hold); null when released."),
  engaged_at: z.string().nullable().describe("When the project's cord was pulled; null when released."),
  engaged_by: z.string().nullable().describe('Who pulled it (an email); null when released.'),
});

const GET_ANDON_ROUTE = { method: 'GET' as const, path: '/api/projects/:id/andon' };
export const PROJECT_ANDON_READ_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  defineCapability({
    id: 'projects.get_andon',
    area: 'projects',
    summary: 'Is this project on hold, and by whom',
    description:
      "The project's andon cord: `engaged`, `reason` ('operator' — a platform operator's hold), who pulled it and when. Nothing runs " +
      "on an engaged project until it is released. Any member of the project's tenant; the tenant's licence (the conveyor's gate). " +
      'Absent, foreign or malformed ids are one 404.',
    http: { ...GET_ANDON_ROUTE, operationId: 'getProjectAndon' },
    input: project,
    output: z.object({ data: andonView }),
    errors: [],
    auth: { principal: 'user', rbac: routeRule(isAuthenticatedUserInResolvedTenant)(GET_ANDON_ROUTE) },
    tenancy: 'project',
    effect: 'read',
    confirm: 'none',
    agent: {
      expose: true,
      tier: 'core',
      cronSafe: false,
      idempotencyKey: (i: unknown) => `projects.get_andon:${(i as { id?: string }).id ?? ''}`,
    },
    handler: lazyActionHandler(() => import('../../agui/actions/kanban-card'), {
      module: 'src/agui/actions/kanban-card.ts',
      exportName: 'getProjectAndonRead',
    }),
    licence: { ops: ['projects.getProjectAndon'] },
    openapi: {
      tags: ['Andon'],
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        { status: 404, description: "`error` 'Project not found' (absent, malformed id, or not readable by the caller).", schema: frErrorBody },
        { status: 'default', description: `${DOOR_403} fr's own 500.`, schema: frErrorBody },
      ],
    },
    legacyHandler: lazyHandler(() => import('../../routes/andon'), { module: 'src/routes/andon.ts', exportName: 'handleGetProjectAndon' }),
  }),
];
