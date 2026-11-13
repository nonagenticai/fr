// fr-agui SPEC §13 P4a3 — spec drain: the 19 `/api/assets/architecture/*` routes
// (routes/assets/architecture.ts) re-expressed as capabilities with NO
// behaviour change (`legacyHandler`).
//
// They proxy the ArchiMate domain of requirements_management, scoped to the
// REQUEST tenant (the upstream client sends it as X-Tenant-Id and refuses to send
// without one). No route here takes a project: a project's architecture view is
// these same tenant routes with a `project_id` LIST FILTER forwarded verbatim
// (frontend lib/api/project-artifacts.ts); nothing on the server scopes or gates
// by project. So all 21 are declared here; P2's project-bound reads are new
// capabilities over the bound project, not these routes.
//
// Ids equal the `architecture.*` AG-UI action
// names (agui/actions/architecture.ts) where one exists; no action is derived.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInFrameTenant } from '../rbac-rules';
import type { OperationName } from '@fr/service-client-requirements';

import { dataEnvelope, libraryCapabilities, pathId, proxyResponses, rmRequestModel, routeRule, upstreamBody, type LibraryRoute } from './_shared';

/** The body of RM operation `op`, forwarded verbatim (its model name read from RM's spec). */
const body = (op: OperationName) => upstreamBody('requirements_management architecture API', rmRequestModel(op));

/**
 * A list route's querystring: `limit` (fr's page cap: absent, junk or < 1 → 200,
 * capped at 1000; never a 400) and every other key forwarded VERBATIM as an
 * upstream filter (the upstream validates them).
 */
const listQuery = z
  .object({
    limit: z
      .string()
      .optional()
      .describe('Rows per page: default 200, max 1000; an absent, non-numeric or < 1 value is the default (never a 400). `X-Applied-Limit` / `X-Truncated` headers report the page cap.'),
    project_id: z.string().optional().describe('An upstream list filter, forwarded verbatim like every other query key (fr does not check it).'),
  })
  .passthrough();

/** Elements, relationships and views belong to a modeling model: their lists also take `model_id`. */
const modelListQuery = listQuery.extend({
  model_id: z.string().optional().describe('Only the rows of this modeling model (for relationships: whose source element is in it). Forwarded verbatim; requirements_management applies it.'),
});

const listOutput = z.object({ data: z.array(z.unknown()) });

const el = z.object({ eid: pathId('Architecture element id') });
const rel = z.object({ rid: pathId('Architecture relationship id') });
const view = z.object({ vid: pathId('Architecture view id') });
const std = z.object({ sid: pathId('Architecture standard id') });
/** The model head the caller last read; on an update it is sent as `If-Match` instead of the head fr reads itself. */
const expectedHead = {
  expected_head: z
    .union([z.number().int().min(0), z.string()])
    .optional()
    .describe("The model head the caller last read (same as an `If-Match` header). Without it fr uses the head it reads with the row. A mismatch is 412 `stale_head` with the current `head`."),
};

const ROUTES: LibraryRoute[] = [
  // Elements
  { id: 'architecture.list_elements', method: 'GET', path: '/api/assets/architecture/elements', handler: 'handleListArchitectureElements', summary: 'List architecture elements', effect: 'read', input: modelListQuery, output: listOutput },
  { id: 'architecture.create_element', method: 'POST', path: '/api/assets/architecture/elements', handler: 'handleCreateArchitectureElement', summary: 'Create an architecture element (in `model_id` when given; honours If-Match, Idempotency-Key, X-Visibility)', effect: 'write', input: body('createArchitectureElement'), successStatus: 201 },
  { id: 'architecture.get_element', method: 'GET', path: '/api/assets/architecture/elements/:eid', handler: 'handleGetArchitectureElement', summary: 'An architecture element', effect: 'read', input: el },
  { id: 'architecture.update_element', method: 'PUT', path: '/api/assets/architecture/elements/:eid', handler: 'handleUpdateArchitectureElement', summary: 'Update an architecture element: only the fields sent change (honours If-Match; 412 `stale_head` when its model changed meanwhile)', effect: 'write', input: body('updateArchitectureElement').extend({ ...el.shape, ...expectedHead }) },
  { id: 'architecture.delete_element', method: 'DELETE', path: '/api/assets/architecture/elements/:eid', handler: 'handleDeleteArchitectureElement', summary: 'Delete an architecture element', effect: 'destructive', input: el, successStatus: 204 },
  // Relationships (immutable upstream: no update)
  { id: 'architecture.list_relationships', method: 'GET', path: '/api/assets/architecture/relationships', handler: 'handleListArchitectureRelationships', summary: 'List architecture relationships', effect: 'read', input: modelListQuery, output: listOutput },
  { id: 'architecture.create_relationship', method: 'POST', path: '/api/assets/architecture/relationships', handler: 'handleCreateArchitectureRelationship', summary: "Create an architecture relationship; it joins its source element's model (immutable: edit = delete + create; honours If-Match, Idempotency-Key; 422 `model_integrity` when the metamodel forbids it)", effect: 'write', input: body('createArchitectureRelationship'), successStatus: 201 },
  { id: 'architecture.get_relationship', method: 'GET', path: '/api/assets/architecture/relationships/:rid', handler: 'handleGetArchitectureRelationship', summary: 'An architecture relationship', effect: 'read', input: rel },
  { id: 'architecture.delete_relationship', method: 'DELETE', path: '/api/assets/architecture/relationships/:rid', handler: 'handleDeleteArchitectureRelationship', summary: 'Delete an architecture relationship', effect: 'destructive', input: rel, successStatus: 204 },
  // Views
  { id: 'architecture.list_views', method: 'GET', path: '/api/assets/architecture/views', handler: 'handleListArchitectureViews', summary: 'List architecture views', effect: 'read', input: modelListQuery, output: listOutput },
  { id: 'architecture.create_view', method: 'POST', path: '/api/assets/architecture/views', handler: 'handleCreateArchitectureView', summary: 'Create an architecture view (in `model_id` when given; honours If-Match, Idempotency-Key, X-Visibility)', effect: 'write', input: body('createArchitectureView'), successStatus: 201 },
  { id: 'architecture.get_view', method: 'GET', path: '/api/assets/architecture/views/:vid', handler: 'handleGetArchitectureView', summary: 'An architecture view', effect: 'read', input: view },
  { id: 'architecture.update_view', method: 'PUT', path: '/api/assets/architecture/views/:vid', handler: 'handleUpdateArchitectureView', summary: 'Update an architecture view: only the fields sent change (honours If-Match; 412 `stale_head` when its model changed meanwhile)', effect: 'write', input: body('updateArchitectureView').extend({ ...view.shape, ...expectedHead }) },
  { id: 'architecture.delete_view', method: 'DELETE', path: '/api/assets/architecture/views/:vid', handler: 'handleDeleteArchitectureView', summary: 'Delete an architecture view', effect: 'destructive', input: view, successStatus: 204 },
  // Standards
  { id: 'architecture.list_standards', method: 'GET', path: '/api/assets/architecture/standards', handler: 'handleListArchitectureStandards', summary: 'List architecture standards', effect: 'read', input: listQuery, output: listOutput },
  { id: 'architecture.create_standard', method: 'POST', path: '/api/assets/architecture/standards', handler: 'handleCreateArchitectureStandard', summary: 'Create an architecture standard', effect: 'write', input: body('createArchitectureStandard'), successStatus: 201 },
  { id: 'architecture.get_standard', method: 'GET', path: '/api/assets/architecture/standards/:sid', handler: 'handleGetArchitectureStandard', summary: 'An architecture standard', effect: 'read', input: std },
  { id: 'architecture.update_standard', method: 'PUT', path: '/api/assets/architecture/standards/:sid', handler: 'handleUpdateArchitectureStandard', summary: 'Update an architecture standard', effect: 'write', input: body('updateArchitectureStandard').extend(std.shape) },
  { id: 'architecture.delete_standard', method: 'DELETE', path: '/api/assets/architecture/standards/:sid', handler: 'handleDeleteArchitectureStandard', summary: 'Delete an architecture standard', effect: 'destructive', input: std, successStatus: 204 },
];

const group = {
  area: 'architecture' as const,
  tag: 'Architecture',
  tenancy: 'tenant' as const,
  rule: routeRule(isAuthenticatedUserInFrameTenant),
  responses: proxyResponses('requirements_management'),
  output: dataEnvelope,
};

export const ARCHITECTURE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...libraryCapabilities(
    { ...group, module: 'src/routes/assets/architecture.ts', load: () => import('../../routes/assets/architecture') },
    ROUTES,
  ),
];
