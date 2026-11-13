// fr-agui SPEC §13 P4a3 — spec drain: the 16 `/api/assets/toc/*` routes
// (routes/assets/toc.ts, Theory-of-Constraints trees over requirements_management)
// re-expressed as capabilities with NO behaviour change (`legacyHandler`).
//
// Scoped to the REQUEST tenant (the upstream client and the TOC read cache both
// refuse to run without one). No route here takes a project: the project goal /
// reasoning pages call these same tenant routes, and `project_id` is only an
// upstream filter (`GET /config?project_id=`, the list queries) that fr forwards
// and never checks. So all 16 are declared here.
//
// The heavy "build" verbs (IO map, evaporating cloud, lenses) are NOT routes;
// they are the `toc.*` AG-UI actions (agui/actions/toc.ts), unchanged. Ids equal
// those action names where one exists; no action is derived.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInFrameTenant } from '../rbac-rules';
import type { OperationName } from '@fr/service-client-requirements';

import { dataEnvelope, libraryCapabilities, pathId, proxyResponses, rmRequestModel, routeRule, upstreamBody, type LibraryRoute } from './_shared';

/** The body of RM operation `op`, forwarded verbatim (its model name read from RM's spec). */
const body = (op: OperationName) => upstreamBody('requirements_management TOC API', rmRequestModel(op));
const tree = z.object({ treeId: pathId('TOC tree id') });
const node = tree.extend({ nodeId: pathId('TOC node id') });
const edge = tree.extend({ edgeId: pathId('TOC edge id') });

const fresh = z
  .string()
  .optional()
  .describe("`true` bypasses fr's short-lived read cache (any other value, or none, may be served from it).");

/** A list querystring: every key forwarded VERBATIM to the upstream (which validates it). */
const listQuery = (extra: Record<string, z.ZodTypeAny> = {}) =>
  z
    .object({
      project_id: z.string().optional().describe('An upstream filter, forwarded verbatim like every other query key (fr does not check it).'),
      ...extra,
    })
    .passthrough();

const ROUTES: LibraryRoute[] = [
  // Trees
  { id: 'toc.list_trees', method: 'GET', path: '/api/assets/toc', handler: 'handleListTocTrees', summary: 'List TOC trees', effect: 'read', input: listQuery() },
  { id: 'toc.create_tree', method: 'POST', path: '/api/assets/toc', handler: 'handleCreateTocTree', summary: 'Create a TOC tree', effect: 'write', input: body('createTocTree'), successStatus: 201 },
  { id: 'toc.get_tree', method: 'GET', path: '/api/assets/toc/:treeId', handler: 'handleGetTocTree', summary: 'A TOC tree', effect: 'read', input: tree },
  { id: 'toc.update_tree', method: 'PUT', path: '/api/assets/toc/:treeId', handler: 'handleUpdateTocTree', summary: 'Update a TOC tree', effect: 'write', input: body('updateTocTree').extend(tree.shape) },
  { id: 'toc.delete_tree', method: 'DELETE', path: '/api/assets/toc/:treeId', handler: 'handleDeleteTocTree', summary: 'Delete a TOC tree', effect: 'destructive', input: tree, successStatus: 204 },
  // Graph / quality
  {
    id: 'toc.get_graph', method: 'GET', path: '/api/assets/toc/:treeId/graph', handler: 'handleGetTocGraph',
    summary: "A TOC tree's node / edge graph", effect: 'read', input: tree.extend({ fresh }),
  },
  {
    id: 'toc.get_quality', method: 'POST', path: '/api/assets/toc/:treeId/quality', handler: 'handleGetTocQuality',
    summary: "Run (and store) a TOC tree's 8-CLR quality score", effect: 'write', input: tree,
    description:
      'POST because the upstream RUNS and PERSISTS the 8-CLR scorer. The request body is ignored; append `?fresh=true` ' +
      "to bypass fr's short-lived read cache.",
  },
  // Config
  {
    id: 'toc.get_config', method: 'GET', path: '/api/assets/toc/config', handler: 'handleGetTocConfig',
    summary: "The tenant's TOC settings (optionally a project's override)", effect: 'read',
    input: z.object({ project_id: z.string().optional().describe('A project whose settings override to read; forwarded verbatim.'), fresh }),
  },
  { id: 'toc.update_config', method: 'PUT', path: '/api/assets/toc/config', handler: 'handleUpdateTocConfig', summary: "Update the tenant's TOC settings", effect: 'write', input: body('upsertTocConfig') },
  // Nodes
  { id: 'toc.list_nodes', method: 'GET', path: '/api/assets/toc/:treeId/nodes', handler: 'handleListTocNodes', summary: "List a TOC tree's nodes", effect: 'read', input: tree.extend(listQuery().shape).passthrough() },
  { id: 'toc.create_node', method: 'POST', path: '/api/assets/toc/:treeId/nodes', handler: 'handleCreateTocNode', summary: 'Add a node to a TOC tree', effect: 'write', input: body('createTocNode').extend(tree.shape), successStatus: 201 },
  { id: 'toc.update_node', method: 'PUT', path: '/api/assets/toc/:treeId/nodes/:nodeId', handler: 'handleUpdateTocNode', summary: 'Update a TOC node', effect: 'write', input: body('updateTocNode').extend(node.shape) },
  { id: 'toc.delete_node', method: 'DELETE', path: '/api/assets/toc/:treeId/nodes/:nodeId', handler: 'handleDeleteTocNode', summary: 'Delete a TOC node', effect: 'destructive', input: node, successStatus: 204 },
  // Edges (no update upstream)
  { id: 'toc.list_edges', method: 'GET', path: '/api/assets/toc/:treeId/edges', handler: 'handleListTocEdges', summary: "List a TOC tree's edges", effect: 'read', input: tree },
  { id: 'toc.create_edge', method: 'POST', path: '/api/assets/toc/:treeId/edges', handler: 'handleCreateTocEdge', summary: 'Add an edge to a TOC tree', effect: 'write', input: body('createTocEdge').extend(tree.shape), successStatus: 201 },
  { id: 'toc.delete_edge', method: 'DELETE', path: '/api/assets/toc/:treeId/edges/:edgeId', handler: 'handleDeleteTocEdge', summary: 'Delete a TOC edge', effect: 'destructive', input: edge, successStatus: 204 },
];

export const TOC_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = libraryCapabilities(
  {
    area: 'toc',
    tag: 'TOC',
    tenancy: 'tenant',
    module: 'src/routes/assets/toc.ts',
    load: () => import('../../routes/assets/toc'),
    rule: routeRule(isAuthenticatedUserInFrameTenant),
    responses: proxyResponses('requirements_management'),
    output: dataEnvelope,
  },
  ROUTES,
);
