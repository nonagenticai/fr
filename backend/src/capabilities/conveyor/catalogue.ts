// fr-agui SPEC §13 P4a3 — spec drain: the conveyor catalogue. The 12
// `/api/conveyor/{taxonomy,catalogue/*}` routes
// (routes/conveyor-catalogue.ts, routes/conveyor-taxonomy.ts) re-expressed as
// capabilities with NO behaviour change (`legacyHandler`).
//
// Every one of them ALREADY had an operation in the served spec, so each moves
// here VERBATIM (`openapi.frozen`, SPEC §3.3: operationId and operation body
// byte-identical; the openapi.ts literal keeps only the position marker). n8n-nodes-fr
// and the frontend client keep their operations unchanged.
//
// The routes are a facilitator proxy over requirements_management's tenant PM
// catalogue: reads are any authenticated caller whose request tenant resolves
// (`ctxTenantId(user.tenantId)`: the frame tenant, else the JWT one) to a
// non-blank value (RM's client refuses a blank one; the static `enums` read has
// no upstream, so any resolved tenant); writes and
// import-defaults additionally need workspace-admin of THAT tenant
// (`isWorkspaceAdminVia`). Both rules are route-aware (`principalDoorAdmits`):
// none of these routes is on the licence allowlist, and the conveyor identity may
// only read.
//
// Not here:
//   * `GET /api/conveyor/project-types` (P0b, ./list-project-types.ts);
//   * `GET /api/conveyor/priority-levels`: its id `conveyor.list_priority_levels` is a
//     DOORWAY member (agent/intake-catalog.ts), served today by a hand-written agent
//     action (agui/actions/projects-create.ts) with its own output shape. Re-expressing
//     it means exposing it (the doorway rule) and moving the agent metric — the doorway
//     unit's change, as P0b did for project-types — so it stays a literal operation;
//   * the super-admin `POST /api/admin/tenants/:tenantId/catalogue/import-defaults` (P4c, admin).
import { z } from 'zod';

import { defineCapability, type Capability, type HttpMethod } from '../define';
import { withLicenceDoor } from '../frozen-routes';
import { lazyHandler } from '../lazy';
import { isAuthenticatedUserInResolvedNonBlankTenant, isAuthenticatedUserInResolvedTenant, type CapabilityRoute } from '../rbac-rules';

/** `integrations/pm-catalogue.ts PM_CATALOGUE_RESOURCES` (equality pinned in library-capabilities.test.ts); any other name is a 404, RM not called. */
export const CATALOGUE_RESOURCES = [
  'project-phases',
  'capabilities',
  'card-types',
  'project-types',
  'gates',
  'wip-limits',
  'priority-levels',
  'deliverable-kinds',
  'milestone-kinds',
  'board-templates',
] as const;

const data = z.object({ data: z.unknown() });
const forwarded = z.object({}).passthrough().describe('Forwarded as-is to requirements_management, which validates it (an empty body is sent as none).');
const resource = z.enum(CATALOGUE_RESOURCES).describe('The catalogue resource (any other name is 404 `unknown_catalogue_resource`, RM not called).');
const id = z.string().min(1).describe('The item id (RM resolves it).');
const filter = (what: string) => z.string().optional().describe(`${what}; forwarded verbatim to RM.`);

const CATALOGUE = { module: 'src/routes/conveyor-catalogue.ts', load: () => import('../../routes/conveyor-catalogue') };
const TAXONOMY = { module: 'src/routes/conveyor-taxonomy.ts', load: () => import('../../routes/conveyor-taxonomy') };

/**
 * A read: the resolved tenant (frame, else JWT) must be non-blank — the RM catalogue client refuses a blank
 * one. `enums` has no upstream, and `taxonomy` reads through the tenant-catalogue reader, which does not
 * trim: for those two any resolved tenant is served.
 */
const read = (route: CapabilityRoute, upstream: boolean) => ({
  type: 'custom' as const,
  check: (ctx: Parameters<typeof isAuthenticatedUserInResolvedTenant>[0]) =>
    upstream ? isAuthenticatedUserInResolvedNonBlankTenant(ctx, route) : isAuthenticatedUserInResolvedTenant(ctx, route),
});
/** Workspace-admin of the request tenant, past the route doors for THIS route (agui/rbac.ts). */
const admin = (route: CapabilityRoute) => ({ type: 'workspace-admin' as const, route });

interface CatalogueRoute {
  id: `conveyor.${string}`;
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  input: z.ZodTypeAny;
  output?: z.ZodTypeAny;
  effect: Capability['effect'];
  handler: string;
  source: { module: string; load: () => Promise<Record<string, unknown>> };
  frozen: Record<string, unknown>;
}

function catalogueCapability(r: CatalogueRoute): Capability<unknown, unknown> {
  const route = { method: r.method, path: r.path };
  return defineCapability({
    id: r.id,
    area: 'conveyor',
    summary: r.summary,
    http: { method: r.method, path: r.path, operationId: r.operationId },
    input: r.input,
    output: r.output ?? data,
    errors: [],
    auth: { principal: 'user', rbac: r.effect === 'read' ? read(route, r.id !== 'conveyor.get_catalogue_enums' && r.id !== 'conveyor.get_taxonomy') : admin(route) },
    tenancy: 'tenant',
    effect: r.effect,
    confirm: r.effect === 'read' ? 'none' : r.effect === 'write' ? 'card' : 'card-typed',
    agent: { expose: false, reason: 'out-of-agent-scope' },
    // P4d-2d (P4d-1 carry): the server's licence-door 403 on a read that declared no 403 / default (none of these
    // routes is on the licence allowlist).
    openapi: { frozen: withLicenceDoor(r.method, r.path, r.frozen) },
    legacyHandler: lazyHandler(r.source.load, { module: r.source.module, exportName: r.handler }),
  });
}

const ROUTES: CatalogueRoute[] = [
  {
    id: 'conveyor.get_taxonomy', method: 'GET', path: '/api/conveyor/taxonomy', operationId: 'getConveyorTaxonomy',
    summary: 'Conveyor taxonomy catalogue of the caller tenant', effect: 'read', handler: 'handleGetConveyorTaxonomy', source: TAXONOMY,
    input: z.object({ template: z.string().optional().describe('Platform-tenant only (403 template_read_forbidden); a permitted read is 404 template_not_found.') }),
    frozen: {
        summary: 'Conveyor taxonomy catalogue of the caller tenant: phases, capabilities, card-type placement',
        description:
          'Read-only, from the caller tenant\'s requirements_management PM catalogue (409 `catalogue_not_initialised` when it has none). `phases` = the tenant\'s RM phases (`gate` = a gate guards the exit); `capabilities` = its RM capabilities (`level` is always null); `card_types[]` = `{id, title, capability, phase|null, group}` where `phase` is the first tenant phase any project type composes it in (null = composed nowhere) and `group` = the capability. `templates` is always `[]` until fr reads pm templates. `?template=` is platform-tenant only (403 `template_read_forbidden`); a permitted read answers 404 `template_not_found` for now.',
        tags: ['Conveyor'],
        operationId: 'getConveyorTaxonomy',
        parameters: [
          { name: 'template', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ data: { phases[], capabilities[], card_types[], templates: [] } }' },
          '401': { description: 'Unauthenticated' },
          '403': { description: '`template_read_forbidden` — template reads are platform-tenant only' },
          '404': { description: '`template_not_found`' },
        },
      },
  },
  {
    id: 'conveyor.get_catalogue_enums', method: 'GET', path: '/api/conveyor/catalogue/enums', operationId: 'getConveyorCatalogueEnums',
    summary: "The tenant catalogue's closed vocabularies", effect: 'read', handler: 'handleGetCatalogueEnums', source: CATALOGUE,
    input: z.object({}), output: z.object({ data: z.object({ definition_of_done: z.array(z.string()) }) }),
    frozen: {
        summary: "The tenant catalogue's closed vocabularies (card-type definition_of_done)",
        description: 'From the regenerated requirements_management client, never a fr copy: `{ data: { definition_of_done: string[] } }` (pr_merged, pr_opened, asset_promoted, asset_persisted, none). Any authenticated member.',
        tags: ['Conveyor'],
        operationId: 'getConveyorCatalogueEnums',
        responses: {
          '200': { description: '{ data: { definition_of_done: string[] } }' },
          '401': { description: 'Unauthenticated' },
        },
      },
  },
  {
    id: 'conveyor.import_catalogue_defaults', method: 'POST', path: '/api/conveyor/catalogue/import-defaults', operationId: 'importConveyorCatalogueDefaults',
    summary: 'Seed the tenant PM catalogue from requirements_management defaults (tenant admin)', effect: 'write',
    handler: 'handleImportCatalogueDefaults', source: CATALOGUE, input: forwarded,
    frozen: {
        summary: 'Seed the tenant PM catalogue from requirements_management defaults (tenant admin)',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: fr forwards, RM validates.',
        tags: ['Conveyor'],
        operationId: 'importConveyorCatalogueDefaults',
        responses: {
          '200': { description: '{ data: <RM import result> }' },
          '403': { description: '`tenant_admin_required`' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.get_project_type_card_types', method: 'GET', path: '/api/conveyor/catalogue/project-types/:id/card-types', operationId: 'getConveyorProjectTypeCardTypes',
    summary: "A project type's card-type matrix", effect: 'read', handler: 'handleGetProjectTypeCardTypes', source: CATALOGUE,
    input: z.object({ id }), frozen: {
        summary: 'A project type\'s card-type matrix',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: fr forwards, RM validates.',
        tags: ['Conveyor'],
        operationId: 'getConveyorProjectTypeCardTypes',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ data: <RM matrix> }' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.set_project_type_card_types', method: 'PUT', path: '/api/conveyor/catalogue/project-types/:id/card-types', operationId: 'setConveyorProjectTypeCardTypes',
    summary: "Replace a project type's card-type matrix (tenant admin)", effect: 'write', handler: 'handleSetProjectTypeCardTypes', source: CATALOGUE,
    input: forwarded.extend({ id }), frozen: {
        summary: 'Replace a project type\'s card-type matrix (tenant admin)',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: fr forwards, RM validates.',
        tags: ['Conveyor'],
        operationId: 'setConveyorProjectTypeCardTypes',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: {
          '200': { description: '{ data: <RM matrix> }' },
          '400': { description: '`invalid_json`' },
          '403': { description: '`tenant_admin_required`' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.resolve_wip_limit', method: 'GET', path: '/api/conveyor/catalogue/wip-limits/resolve', operationId: 'resolveConveyorWipLimit',
    summary: 'The WIP limit that applies to a set of dimensions', effect: 'read', handler: 'handleResolveWipLimit', source: CATALOGUE,
    input: z.object({
      project_type_id: filter('Project type id'), phase_id: filter('Phase id'), capability_id: filter('Capability id'), card_type_id: filter('Card type id'),
    }),
    frozen: {
        summary: 'The WIP limit that applies to a set of dimensions',
        description: 'Facilitator proxy over requirements_management GET /pm/wip-limits/resolve: RM picks the most specific row. Forwards only project_type_id, phase_id, capability_id, card_type_id.',
        tags: ['Conveyor'],
        operationId: 'resolveConveyorWipLimit',
        parameters: ['project_type_id', 'phase_id', 'capability_id', 'card_type_id'].map((name) => ({
          name,
          in: 'query' as const,
          required: false,
          schema: { type: 'string' as const },
        })),
        responses: {
          '200': { description: '{ data: <RM WipLimitResolveOut> }' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.list_catalogue', method: 'GET', path: '/api/conveyor/catalogue/:resource', operationId: 'listConveyorCatalogue',
    summary: 'List a tenant PM catalogue resource', effect: 'read', handler: 'handleListCatalogue', source: CATALOGUE,
    input: z.object({
      resource, limit: filter('Page size'), offset: filter('Page offset'), capability_id: filter('Capability id'),
      project_type_id: filter('Project type id'), phase_id: filter('Phase id'), card_type_id: filter('Card type id'), size: filter('Size'),
    }),
    frozen: {
        summary: 'List a tenant PM catalogue resource',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: fr forwards, RM validates. Forwards only limit, offset, capability_id, project_type_id, phase_id, card_type_id, size (RM filters on ids).',
        tags: ['Conveyor'],
        operationId: 'listConveyorCatalogue',
        parameters: [
          { name: 'resource', in: 'path', required: true, schema: { type: 'string', enum: ['project-phases', 'capabilities', 'card-types', 'project-types', 'gates', 'wip-limits', 'priority-levels', 'deliverable-kinds', 'milestone-kinds', 'board-templates'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'capability_id', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'project_type_id', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'phase_id', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'card_type_id', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'size', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '{ data: <RM list body> }' },
          '404': { description: '`unknown_catalogue_resource` (RM not called), or RM 404 passed through' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.create_catalogue_item', method: 'POST', path: '/api/conveyor/catalogue/:resource', operationId: 'createConveyorCatalogueItem',
    summary: 'Create a tenant PM catalogue item (tenant admin)', effect: 'write', handler: 'handleCreateCatalogueItem', source: CATALOGUE,
    input: forwarded.extend({ resource }), frozen: {
        summary: 'Create a tenant PM catalogue item (tenant admin)',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: fr forwards, RM validates.',
        tags: ['Conveyor'],
        operationId: 'createConveyorCatalogueItem',
        parameters: [{ name: 'resource', in: 'path', required: true, schema: { type: 'string', enum: ['project-phases', 'capabilities', 'card-types', 'project-types', 'gates', 'wip-limits', 'priority-levels', 'deliverable-kinds', 'milestone-kinds', 'board-templates'] } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: {
          '200': { description: '{ data: <RM created item> }' },
          '400': { description: '`invalid_json`' },
          '403': { description: '`tenant_admin_required`' },
          '404': { description: '`unknown_catalogue_resource` (RM not called), or RM 404 passed through' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.get_catalogue_item', method: 'GET', path: '/api/conveyor/catalogue/:resource/:id', operationId: 'getConveyorCatalogueItem',
    summary: 'Get one tenant PM catalogue item', effect: 'read', handler: 'handleGetCatalogueItem', source: CATALOGUE,
    input: z.object({ resource, id }), frozen: {
        summary: 'Get one tenant PM catalogue item',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: fr forwards, RM validates.',
        tags: ['Conveyor'],
        operationId: 'getConveyorCatalogueItem',
        parameters: [{ name: 'resource', in: 'path', required: true, schema: { type: 'string', enum: ['project-phases', 'capabilities', 'card-types', 'project-types', 'gates', 'wip-limits', 'priority-levels', 'deliverable-kinds', 'milestone-kinds', 'board-templates'] } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ data: <RM item> }' },
          '404': { description: '`unknown_catalogue_resource` (RM not called), or RM 404 passed through' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.update_catalogue_item', method: 'PUT', path: '/api/conveyor/catalogue/:resource/:id', operationId: 'updateConveyorCatalogueItem',
    summary: 'Update a tenant PM catalogue item (tenant admin)', effect: 'write', handler: 'handleUpdateCatalogueItem', source: CATALOGUE,
    input: forwarded.extend({ resource, id }), frozen: {
        summary: 'Update a tenant PM catalogue item (tenant admin)',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: the body is forwarded as-is (RM PUT is partial: an omitted field is unchanged, an explicit null sets NULL). RM validates; its 422 passes through.',
        tags: ['Conveyor'],
        operationId: 'updateConveyorCatalogueItem',
        parameters: [{ name: 'resource', in: 'path', required: true, schema: { type: 'string', enum: ['project-phases', 'capabilities', 'card-types', 'project-types', 'gates', 'wip-limits', 'priority-levels', 'deliverable-kinds', 'milestone-kinds', 'board-templates'] } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        responses: {
          '200': { description: '{ data: <RM item> }' },
          '400': { description: '`invalid_json`' },
          '403': { description: '`tenant_admin_required`' },
          '404': { description: '`unknown_catalogue_resource` (RM not called), or RM 404 passed through' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
  {
    id: 'conveyor.delete_catalogue_item', method: 'DELETE', path: '/api/conveyor/catalogue/:resource/:id', operationId: 'deleteConveyorCatalogueItem',
    summary: 'Delete a tenant PM catalogue item (tenant admin)', effect: 'destructive', handler: 'handleDeleteCatalogueItem', source: CATALOGUE,
    input: z.object({ resource, id }), frozen: {
        summary: 'Delete a tenant PM catalogue item (tenant admin)',
        description: 'Facilitator proxy over the requirements_management tenant PM catalogue: fr forwards, RM validates.',
        tags: ['Conveyor'],
        operationId: 'deleteConveyorCatalogueItem',
        parameters: [{ name: 'resource', in: 'path', required: true, schema: { type: 'string', enum: ['project-phases', 'capabilities', 'card-types', 'project-types', 'gates', 'wip-limits', 'priority-levels', 'deliverable-kinds', 'milestone-kinds', 'board-templates'] } }, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: '{ data: <RM delete result> }' },
          '403': { description: '`tenant_admin_required`' },
          '404': { description: '`unknown_catalogue_resource` (RM not called), or RM 404 passed through' },
          '401': { description: 'Unauthenticated' },
          '4XX': { description: 'requirements_management refusal passed through: its status and caller-safe body under `error.upstream`' },
        },
      },
  },
];

export const CONVEYOR_CATALOGUE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = ROUTES.map(catalogueCapability);
