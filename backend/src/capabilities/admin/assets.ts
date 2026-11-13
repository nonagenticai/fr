// fr-agui SPEC §13 P4c part 2 — spec drain: the asset console, the
// /api/admin/assets/* routes (routes/admin/assets/*.ts), re-expressed with NO
// behaviour change (`legacyHandler`). It is the operator view of the REQUEST
// tenant's library (principles, requirements, decisions, its projects)
// and the production n8n workflows, so `tenancy: 'tenant'` (the X-Active-Tenant of a
// switched super_admin, else the JWT tenant). Despite the path, the READS are not
// super-admin only.
//
// Gates (routes/admin/assets/_lib/gate.ts): validateAuth CAUGHT (any refusal 401
// 'unauthorized' with the throw's OWN status, so the conveyor write door is a 403 with
// that body), then:
//   * reads (`gateReadAsset`): nothing more. The principle / requirement / decision
//     reads go through a `requireTenant` client (requirements_management: a blank frame
//     tenant is MISSING_TENANT, nothing sent) and
//     the lists also refuse an absent one (400 'no_active_tenant') —
//     `isAuthenticatedUserInFrameTenant`. The project reads and the workflow list
//     refuse only an absent / empty frame tenant (`isAuthenticatedUserWithFrameTenant`;
//     a customer tenant's workflow list is an EMPTY 200, n8n never called). The
//     workflow read is `canReadProductionWorkflows` (super_admin or a platform active
//     tenant; anyone else the 404 an unknown id gets) — `isAuthenticatedProductionWorkflowReader`.
//   * writes (`gateWriteAsset`): an absent / empty frame tenant is 400 'no_active_tenant';
//     in the SYSTEM tenant only a super_admin; elsewhere a super_admin or a
//     workspace-admin of the frame tenant — the workspace-admin rule with
//     `superAdmin`, `systemTenantSuperOnly` and `frameTenant` (non-blank after trim for
//     the requireTenant upstreams; untrimmed for the fr-DB project writes).
// Whether a SYSTEM-owned row may be edited (`system_asset_read_only`) is a RESOURCE
// check after an upstream read, not part of the principal rule.
import { RequirementInVersionStatus } from '@fr/service-client-requirements';
import { z } from 'zod';

import {
  listDecisionsParamsSchema,
  listPrinciplesParamsSchema,
  listRequirementsParamsSchema,
} from '../../integrations/_lib/asset-query-schemas';
import { PatchProjectSchema } from '../../routes/admin/assets/projects-schemas';
import type { Capability } from '../define';
import {
  isAuthenticatedProductionWorkflowReader,
  isAuthenticatedUserInFrameTenant,
  isAuthenticatedUserWithFrameTenant,
} from '../rbac-rules';
import { caughtAuthResponses, isoTime, pathId, routeRule, settingsCapabilities, workspaceAdminRule, type SettingsRoute } from '../observe/_shared';

const TAG = 'Asset Console';
const isSystem = z.boolean().describe("The row's owner is the SYSTEM tenant (read off the row's own `tenant_id`; a platform tenant's view only).");

// ── the upstream rows (requirements_management, generated clients) ──

const ns = z.string().nullable();
/** The provenance / versioning / quality columns every requirements_management row carries. */
const rmCommon = {
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  tenant_id: z.string(),
  approved_at: ns.optional(),
  approved_by: ns.optional(),
  created_at: ns.optional(),
  created_by_user_id: z.string().optional(),
  updated_at: ns.optional(),
  is_system: z.boolean().optional(),
  last_evaluated_at: ns.optional(),
  last_evaluated_by_agent: ns.optional(),
  origin_kind: z.string().optional(),
  origin_project_id: ns.optional(),
  origin_workflow_run_id: ns.optional(),
  published_at: ns.optional(),
  quality_issues: z.array(z.string()).nullable().optional(),
  quality_score: z.number().nullable().optional(),
  quality_suggestions: z.array(z.string()).nullable().optional(),
  superseded_by: ns.optional(),
  supersedes: ns.optional(),
  version: z.string().optional(),
  version_notes: ns.optional(),
  version_status: z.string().optional(),
};
/** The writable provenance / versioning columns of a requirements_management `*In` model. */
const rmWritable = {
  title: z.string(),
  approved_at: ns.optional(),
  approved_by: ns.optional(),
  created_by_user_id: z.string().optional(),
  origin_kind: z.string().optional(),
  origin_project_id: ns.optional(),
  origin_workflow_run_id: ns.optional(),
  published_at: ns.optional(),
  superseded_by: ns.optional(),
  supersedes: ns.optional(),
  version: z.string().optional(),
  version_notes: ns.optional(),
  // The upstream's own enum (requirements_management *InVersionStatus: Principle / Requirement / Decision carry the same three).
  version_status: z.nativeEnum(RequirementInVersionStatus).optional(),
};
const lens = z.record(z.unknown()).optional();

const principleOut = z
  .object({ ...rmCommon, statement: z.string(), rationale: ns.optional(), implications: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), active: z.boolean().optional() })
  .passthrough();
const principleIn = z
  .object({ ...rmWritable, statement: z.string(), rationale: ns.optional(), implications: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), active: z.boolean().optional() })
  .passthrough();
const requirementFields = {
  description: z.string(),
  effort: z.number(),
  acceptance: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  impact: z.number().optional(),
  reach: z.number().optional(),
  lens_metadata: lens,
  links: z.record(z.array(z.string())).optional(),
  project_id: ns.optional(),
  stable_key: ns.optional(),
};
const requirementOut = z.object({ ...rmCommon, ...requirementFields }).passthrough();
const requirementIn = z.object({ ...rmWritable, ...requirementFields }).passthrough();
const decisionFields = {
  context: z.string(),
  decision: z.string(),
  alternatives: z.array(z.string()).optional(),
  consequences: ns.optional(),
  lens_metadata: lens,
  project_id: ns.optional(),
  related_principles: z.array(z.string()).optional(),
  stable_key: ns.optional(),
};
const decisionOut = z.object({ ...rmCommon, ...decisionFields, status: z.string().optional() }).passthrough();
const decisionIn = z
  .object({ ...rmWritable, ...decisionFields, status: z.enum(['proposed', 'accepted', 'deprecated', 'superseded']).optional() })
  .passthrough();

// ── responses ────────────────────────────────────────────────────────────────

const SENT_TO = (service: string) =>
  `409: \`error.code\` 'MISSING_TENANT' (a blank request tenant: nothing is sent to ${service}). ` +
  `404: \`error.code\` 'UPSTREAM_NOT_FOUND' (an unknown id — and a SYSTEM-owned row asked for under a customer tenant, ` +
  `answered exactly like one). Any other status is ${service}'s, relayed (\`error.code\` 'UPSTREAM_…'). `;
const READ = (service: string, o: { noTenant400: boolean; badQuery: boolean }) =>
  caughtAuthResponses(
    { status: 'own' },
    (o.noTenant400 || o.badQuery
      ? '400: ' +
        [o.noTenant400 ? "`error` 'no_active_tenant' (no request tenant)" : '', o.badQuery ? "`error` 'bad_request' (a query value that fails the schema; checked first)" : '']
          .filter(Boolean)
          .join(', or ') +
        '. '
      : '') + SENT_TO(service),
  );
const WRITE_403 =
  "403: `error` 'super_admin_only' (a write while the request tenant is the SYSTEM tenant, by anyone but a super_admin), " +
  "'workspace_admin_required' (neither a super_admin nor a workspace-admin of the request tenant), or — update / delete — " +
  "'system_asset_read_only' (a non-super_admin on a SYSTEM-owned row, read first). ";
const WRITE = (service: string, extra = '') =>
  caughtAuthResponses(
    { status: 'own', write: true },
    "400: `error` 'no_active_tenant' (no request tenant), or 'bad_request' (the body is not JSON / not an object). " + WRITE_403 + extra + SENT_TO(service),
  );

// ── the four library kinds ───────────────────────────────────────────────────

type CapId = `asset_console.${string}`;

interface Kind {
  area: 'principles' | 'requirements' | 'decisions';
  singular: string;
  module: string;
  load: () => Promise<Record<string, unknown>>;
  service: string;
  key: 'id';
  list: z.ZodTypeAny;
  get: z.ZodTypeAny;
  out: z.ZodTypeAny;
  create: z.ZodTypeAny;
  update: z.ZodTypeAny;
  handlers: { list: string; get: string; create: string; update: string; delete: string };
  /** The five ids in route order (list, get, create, update, delete), spelled out so each is greppable. */
  ids: [{ id: CapId }, { id: CapId }, { id: CapId }, { id: CapId }, { id: CapId }];
  updateNote?: string;
  update422?: string;
}

const RM = 'requirements_management';
const forwarded = (type: string) =>
  `The body is forwarded VERBATIM to ${RM} (${type}; fr only checks it is a JSON object); its required fields are that model's. `;

function kindRoutes(k: Kind): SettingsRoute[] {
  const base = `/api/admin/assets/${k.area}`;
  const one = `${base}/:${k.key}`;
  const keyIn = { [k.key]: pathId(`${k.singular} id`) };
  const write = workspaceAdminRule({ superAdmin: true, systemTenantSuperOnly: true, frameTenant: true });
  const tagged = k.out instanceof z.ZodObject ? (k.out as z.AnyZodObject).extend({ is_system: isSystem }) : k.out;
  return [
    {
      id: k.ids[0].id, method: 'GET', path: base, handler: k.handlers.list, effect: 'read',
      summary: `List the request tenant's ${k.area} (asset console)`,
      description:
        `ONE upstream call under the request tenant. A customer (non-platform) tenant never sees a SYSTEM-owned row; a ` +
        'platform tenant sees them, tagged `is_system`.',
      input: k.list,
      output: z.object({ [k.area]: z.array(tagged) }),
      responses: READ(k.service, { noTenant400: true, badQuery: true }),
    },
    {
      id: k.ids[1].id, method: 'GET', path: one, handler: k.handlers.get, effect: 'read',
      summary: `One ${k.singular} of the request tenant (asset console)`,
      input: z.object(keyIn).merge(k.get as z.AnyZodObject),
      output: z.object({ [k.singular]: tagged }),
      responses: READ(k.service, { noTenant400: false, badQuery: false }),
    },
    {
      id: k.ids[2].id, method: 'POST', path: base, handler: k.handlers.create, effect: 'write', successStatus: 201,
      summary: `Create a ${k.singular} in the request tenant (asset console: workspace-admin; super_admin in the system tenant)`,
      description: forwarded(`${k.singular[0]!.toUpperCase()}${k.singular.slice(1)}In`),
      input: k.create,
      output: z.object({ [k.singular]: k.out }),
      responses: WRITE(k.service),
      rule: write,
    },
    {
      id: k.ids[3].id, method: 'PATCH', path: one, handler: k.handlers.update, effect: 'write',
      summary: `Replace a ${k.singular} of the request tenant (asset console: workspace-admin; super_admin in the system tenant)`,
      description:
        'Mounted PATCH, but the upstream call is a WHOLE-BODY PUT (there is no merge): send the complete object. ' + (k.updateNote ?? forwarded(`${k.singular[0]!.toUpperCase()}${k.singular.slice(1)}In`)),
      input: z.object(keyIn).merge(k.update as z.AnyZodObject),
      output: z.object({ [k.singular]: k.out }),
      responses: WRITE(k.service, k.update422 ?? ''),
      rule: write,
    },
    {
      id: k.ids[4].id, method: 'DELETE', path: one, handler: k.handlers.delete, effect: 'destructive', successStatus: 204,
      summary: `Delete a ${k.singular} of the request tenant (asset console: workspace-admin; super_admin in the system tenant)`,
      input: z.object(keyIn),
      output: z.null(),
      responses: WRITE(k.service),
      rule: write,
    },
  ];
}

const handlersFor = (Plural: string, Singular: string) => ({
  list: `handleListAdmin${Plural}`, get: `handleGetAdmin${Singular}`, create: `handleCreateAdmin${Singular}`,
  update: `handleUpdateAdmin${Singular}`, delete: `handleDeleteAdmin${Singular}`,
});

const KINDS: Kind[] = [
  {
    area: 'principles', singular: 'principle', module: 'src/routes/admin/assets/principles.ts', load: () => import('../../routes/admin/assets/principles'),
    service: RM, key: 'id', list: listPrinciplesParamsSchema, get: z.object({}), out: principleOut, create: principleIn, update: principleIn,
    handlers: handlersFor('Principles', 'Principle'), 
    ids: [{ id: 'asset_console.list_principles' }, { id: 'asset_console.get_principle' }, { id: 'asset_console.create_principle' }, { id: 'asset_console.update_principle' }, { id: 'asset_console.delete_principle' }],
  },
  {
    area: 'requirements', singular: 'requirement', module: 'src/routes/admin/assets/requirements.ts', load: () => import('../../routes/admin/assets/requirements'),
    service: RM, key: 'id', list: listRequirementsParamsSchema, get: z.object({}), out: requirementOut, create: requirementIn, update: requirementIn,
    handlers: handlersFor('Requirements', 'Requirement'), 
    ids: [{ id: 'asset_console.list_requirements' }, { id: 'asset_console.get_requirement' }, { id: 'asset_console.create_requirement' }, { id: 'asset_console.update_requirement' }, { id: 'asset_console.delete_requirement' }],
  },
  {
    area: 'decisions', singular: 'decision', module: 'src/routes/admin/assets/decisions.ts', load: () => import('../../routes/admin/assets/decisions'),
    service: RM, key: 'id', list: listDecisionsParamsSchema, get: z.object({}), out: decisionOut, create: decisionIn, update: decisionIn,
    handlers: handlersFor('Decisions', 'Decision'), 
    ids: [{ id: 'asset_console.list_decisions' }, { id: 'asset_console.get_decision' }, { id: 'asset_console.create_decision' }, { id: 'asset_console.update_decision' }, { id: 'asset_console.delete_decision' }],
  },
];

const groupOf = (k: Pick<Kind, 'module' | 'load'>, rule: SettingsRoute['rule'] & {}) => ({
  area: 'asset_console' as const, tag: TAG, tenancy: 'tenant' as const, module: k.module, load: k.load, rule,
});

const LIBRARY_KIND_CAPABILITIES = KINDS.flatMap((k) => settingsCapabilities(groupOf(k, routeRule(isAuthenticatedUserInFrameTenant)), kindRoutes(k)));

// ── the request tenant's projects (fr's own table) ───────────────────────────

const projectRow = z
  .object({
    id: z.string(),
    owner_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    repository_url: z.string().nullable(),
    branch: z.string().nullable(),
    status: z.string(),
    delivered_at: isoTime.nullable(),
    delivery_evidence: z.unknown(),
    planka_board_id: z.string().nullable(),
    planka_project_id: z.string().nullable(),
    container_name: z.string().nullable(),
    repository_provisioned: z.boolean().nullable(),
    graph_initialized: z.boolean().nullable(),
    project_data: z.record(z.unknown()).nullable(),
    project_type: z.string().nullable(),
    scope_level: z.string().nullable(),
    shape: z.enum(['deliverable', 'continuous_flow']),
    dept_id: z.string().nullable(),
    andon_engaged: z.boolean(),
    andon_engaged_at: isoTime.nullable(),
    andon_engaged_by: z.string().nullable(),
    project_phase: z.string().nullable(),
    project_phase_updated_at: isoTime.nullable(),
    approved_effort_estimate: z.unknown(),
    coordination_mode: z.string().nullable(),
    template_id: z.string().nullable(),
    template_hash: z.string().nullable(),
    created_at: isoTime.nullable(),
    updated_at: isoTime.nullable(),
    is_system: z.literal(false).describe('Always false: projects carry no tenant_id of their own.'),
  })
  .passthrough()
  .describe("fr's `projects` row.");
const projectId = z.object({ id: pathId('Project id') });
const PROJECT_SCOPE =
  'The fleet view (the SYSTEM request tenant AND a super_admin) sees every PLATFORM-tagged project; anyone else only ' +
  "projects they OWN whose own tenant tag is the request tenant (a blank / untagged one matches nothing).";
const PROJECT_READ = caughtAuthResponses({ status: 'own' }, "400: `error` 'no_active_tenant' (no request tenant). 404: `error` 'not_found' (not visible to the caller). ");
const PROJECT_WRITE = (extra: string) =>
  caughtAuthResponses(
    { status: 'own', write: true },
    "400: `error` 'no_active_tenant' (no request tenant). 403: `error` 'super_admin_only' (a write while the request tenant " +
      "is the SYSTEM tenant, by anyone but a super_admin) or 'workspace_admin_required' (neither a super_admin nor a " +
      'workspace-admin of the request tenant). ' +
      extra +
      "404: `error` 'not_found' (not visible to the caller). ",
  );
const projectWrite = workspaceAdminRule({ superAdmin: true, systemTenantSuperOnly: true, frameTenant: 'untrimmed' });

const PROJECT_ROUTES: SettingsRoute[] = [
  {
    id: 'asset_console.list_projects', method: 'GET', path: '/api/admin/assets/projects', handler: 'handleListAdminProjects', effect: 'read',
    summary: "The request tenant's projects (asset console)", description: PROJECT_SCOPE + " `untagged=1` (the fleet view only, else 403 `error` 'fleet_view_only') lists the untagged rows as `{ id, name, archived }`.",
    input: z.object({ untagged: z.string().optional().describe("'1': the untagged lane (fleet view only).") }),
    output: z.object({
      projects: z.array(z.union([projectRow, z.object({ id: z.string(), name: z.string(), archived: z.boolean() })])),
    }),
    responses: caughtAuthResponses({ status: 'own' }, "400: `error` 'no_active_tenant' (no request tenant). 403: `error` 'fleet_view_only' (`untagged=1` outside the fleet view). "),
  },
  {
    id: 'asset_console.get_project', method: 'GET', path: '/api/admin/assets/projects/:id', handler: 'handleGetAdminProject', effect: 'read',
    summary: 'One project of the request tenant (asset console)', description: PROJECT_SCOPE, input: projectId, output: z.object({ project: projectRow }), responses: PROJECT_READ,
  },
  {
    id: 'asset_console.update_project', method: 'PATCH', path: '/api/admin/assets/projects/:id', handler: 'handleUpdateAdminProject', effect: 'write',
    summary: "Set a project's fr row status (submitted / active) (asset console: workspace-admin; super_admin in the system tenant)",
    description:
      PROJECT_SCOPE +
      " `status` is the only key: any other is refused (400), and an RM-owned project field 422 `rm_owned_field`. " +
      "'archived' is refused (400 'archive_via_delete': archiving purges the documents' PHI, so it is the DELETE).",
    input: projectId.merge(PatchProjectSchema),
    output: z.object({ project: projectRow }),
    responses: PROJECT_WRITE(
      "400: `error` 'bad_request' (not JSON, an unknown key, a status other than submitted / active) or 'archive_via_delete'. " +
        "422: `error` / `code` 'rm_owned_field' (`fields`: requirements_management owns them). 409: `error` 'project_delivered' " +
        "(a delivered project's status is terminal). ",
    ),
    rule: projectWrite,
  },
  {
    id: 'asset_console.archive_project', method: 'DELETE', path: '/api/admin/assets/projects/:id', handler: 'handleDeleteAdminProject', effect: 'destructive', successStatus: 204,
    summary: "Archive a project, purging its documents' downstream PHI first (asset console: workspace-admin; super_admin in the system tenant)",
    description:
      PROJECT_SCOPE +
      " It first closes the project's requirements_management project (R351): if RM cannot close it the answer is 502 " +
      '`rm_project_close_failed` and nothing is archived; a project RM holds no row for is archived anyway.' +
      ' An optional JSON body `{ "keep_board": true }` keeps its Planka board (anything else — a non-boolean, unreadable ' +
      'JSON — or no body archives it too; never a 400).',
    input: projectId.extend({
      keep_board: z.boolean().optional().describe('true keeps the Planka board; only the literal boolean counts.'),
    }),
    bodyFields: ['keep_board'],
    output: z.null(),
    responses: PROJECT_WRITE(''),
    rule: projectWrite,
  },
];

const PROJECT_CAPABILITIES = settingsCapabilities(
  groupOf({ module: 'src/routes/admin/assets/projects.ts', load: () => import('../../routes/admin/assets/projects') }, routeRule(isAuthenticatedUserWithFrameTenant)),
  PROJECT_ROUTES,
);

// ── the production n8n workflows (read-only) ─────────────────────────────────

const workflowRow = z
  .object({ id: z.string().optional(), name: z.string().optional(), active: z.boolean().optional(), is_system: isSystem.describe('The request tenant is the SYSTEM tenant.') })
  .passthrough()
  .describe('The n8n workflow, verbatim.');
const WORKFLOW_RELAY = "Any other status is n8n's, relayed (`error.code` 'UPSTREAM_…').";

const WORKFLOW_CAPABILITIES = settingsCapabilities(
  groupOf({ module: 'src/routes/admin/assets/workflows.ts', load: () => import('../../routes/admin/assets/workflows') }, routeRule(isAuthenticatedUserWithFrameTenant)),
  [
    {
      id: 'asset_console.list_workflows', method: 'GET', path: '/api/admin/assets/workflows', handler: 'handleListAdminWorkflows', effect: 'read',
      summary: 'The production n8n workflows (asset console; platform data)',
      description:
        "Production n8n is platform data: a customer tenant (neither a super_admin nor a platform request tenant) gets the " +
        'same envelope EMPTY, and n8n is never called. No `limit` crawls the whole catalogue.',
      input: z.object({
        active: z.string().optional().describe("'true': active workflows only; any other value: inactive only."),
        limit: z.string().optional().describe('An integer >= 1 caps the list (else 400 BAD_REQUEST).'),
      }),
      output: z.object({ workflows: z.array(workflowRow) }),
      responses: caughtAuthResponses({ status: 'own' }, "400: `error` 'no_active_tenant' (no request tenant), or 'limit must be an integer >= 1' (a bad `limit`, checked first). " + WORKFLOW_RELAY + ' '),
    },
    {
      id: 'asset_console.get_workflow', method: 'GET', path: '/api/admin/assets/workflows/:id', handler: 'handleGetAdminWorkflow', effect: 'read',
      summary: 'One production n8n workflow (asset console; super_admin or a platform request tenant)',
      input: z.object({ id: pathId('n8n workflow id') }),
      output: z.object({ workflow: workflowRow }),
      responses: caughtAuthResponses({ status: 'own' }, "404: `error.code` 'UPSTREAM_NOT_FOUND' (an unknown id — and anyone but a super_admin or a platform request tenant, answered exactly like one). " + WORKFLOW_RELAY + ' '),
      rule: routeRule(isAuthenticatedProductionWorkflowReader),
    },
  ],
);

export const ASSET_CONSOLE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...LIBRARY_KIND_CAPABILITIES,
  ...PROJECT_CAPABILITIES,
  ...WORKFLOW_CAPABILITIES,
];

/**
 * fr-agui P4d-2c — the requirements_management rows and bodies, shared with
 * the tenant library routes (capabilities/library/governed-assets.ts), which forward the same models.
 */
export const LIBRARY_ASSET_MODELS = {
  principleOut, principleIn, requirementOut, requirementIn, decisionOut, decisionIn,
} as const;
