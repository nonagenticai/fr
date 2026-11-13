// fr-agui SPEC §13 P4b (part 2) — spec drain: the read-only n8n workflow browsers,
// re-expressed with NO behaviour change (`legacyHandler`):
//
//   * the Workflows Viewer (routes/workflows.ts): `GET /api/workflows`,
//     `GET /api/workflows/tags`, `GET /api/workflows/:id`;
//   * `GET /api/tools/n8n/workflows` (routes/tools/n8n.ts). Its siblings
//     `/api/tools/n8n/executions[/:id]` stay router rows (P3).
//
// Gate: `validateAuth` alone (its licence / conveyor doors): `isAuthenticatedUser`.
// The catalogue is the PRODUCTION n8n instance, so `canReadProductionWorkflows`
// (lib/production-workflows-gate.ts: a super_admin, or an ACTIVE platform tenant)
// decides WHAT is answered, never WHETHER: a customer tenant gets the same
// envelope with an empty `data` (an empty facet map for /tags), and `/:id` answers
// exactly the 404 an unknown id produces. That is a visibility filter, not a
// refusal, so it is not part of the declared rule.
//
// The list and tag reads never wait on n8n: they serve the background-refreshed
// catalogue; past its freshness window it is served `degraded` with `stale_as_of`,
// and with nothing fresh enough to serve the recorded upstream error is answered.
import { z } from 'zod';

import type { ResponseSpec } from '../define';
import { isAuthenticatedUser } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, settingsCapabilities, unauthorizedBody } from '../settings/_shared';

/** An n8n workflow as n8n's Public API answers it (`Workflow`: id, name, active, nodes, connections, settings, …). */
const n8nWorkflow = z.object({ id: z.string().optional(), name: z.string().optional(), active: z.boolean().optional() }).passthrough();

const listRow = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  tags: z.array(z.string()).describe('Every raw tag on the workflow, namespaced and plain.'),
  facets: z.object({ domains: z.array(z.string()), purposes: z.array(z.string()), stages: z.array(z.string()), triggers: z.array(z.string()) }),
  domains: z.array(z.string()).describe('Legacy derived labels (kept for one release).'),
  primaryDomain: z.string(),
  purpose: z.string(),
  updatedAt: z.string(),
  nodeCount: z.number().int(),
});

const facetCount = z.object({ slug: z.string(), label: z.string(), workflowCount: z.number().int() });
const facetedTags = z.object({
  domain: z.array(facetCount),
  purpose: z.array(facetCount),
  stage: z.array(facetCount),
  trigger: z.array(facetCount),
  other: z.array(z.object({ tag: z.string(), workflowCount: z.number().int() })),
});

/** A fresh read is `{ data }`; a degraded one adds the markers BESIDE `data`. */
const cached = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    data,
    degraded: z.literal(true).optional().describe('Present when the catalogue is past its freshness window (served anyway).'),
    stale_as_of: z.string().optional().describe('When the served catalogue was fetched (with `degraded`).'),
  });

const RESPONSES = (extra = ''): ResponseSpec[] => [
  { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
  {
    status: 'default',
    description:
      extra +
      DOOR_403 +
      " 502 / 504: n8n failed or is unreachable / no catalogue fresh enough to serve (`error.code` 'UPSTREAM_…'); n8n's own 4xx " +
      "pass through (`error.code`). 500: fr's own (`error`).",
    schema: frErrorBody,
  },
];

export const WORKFLOW_VIEWER_CAPABILITIES = settingsCapabilities(
  {
    area: 'workflows', tag: 'Workflows', tenancy: 'platform',
    module: 'src/routes/workflows.ts', load: () => import('../../routes/workflows'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'workflows.list', method: 'GET', path: '/api/workflows', handler: 'handleList',
      summary: 'The production n8n workflow catalogue, with facets (platform callers; empty for a customer tenant)', effect: 'read',
      input: z.object({}), output: cached(z.array(listRow)), responses: RESPONSES(),
    },
    {
      id: 'workflows.list_tags', method: 'GET', path: '/api/workflows/tags', handler: 'handleTags',
      summary: 'Faceted tag counts over the production workflow catalogue', effect: 'read',
      input: z.object({}), output: cached(facetedTags), responses: RESPONSES(),
    },
    {
      id: 'workflows.get', method: 'GET', path: '/api/workflows/:id', handler: 'handleGet',
      summary: 'One production n8n workflow definition (nodes, connections, settings)', effect: 'read',
      description: 'Read live from n8n (not cached). A customer tenant gets the 404 an unknown id gets.',
      input: z.object({ id: pathId('n8n workflow id') }), output: z.object({ data: n8nWorkflow }),
      responses: RESPONSES("404: `error.code` 'UPSTREAM_NOT_FOUND' (unknown id — or a customer tenant). "),
    },
  ],
);

export const N8N_TOOL_WORKFLOW_CAPABILITIES = settingsCapabilities(
  {
    area: 'tools', tag: 'Workflows', tenancy: 'platform',
    module: 'src/routes/tools/n8n.ts', load: () => import('../../routes/tools/n8n'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'tools.list_n8n_workflows', method: 'GET', path: '/api/tools/n8n/workflows', handler: 'handleListWorkflows',
      summary: 'Production n8n workflows, read live (platform callers; empty for a customer tenant)', effect: 'read',
      input: z.object({
        active: z.boolean().optional().describe("Only active (true) or inactive (false) workflows; 'true' / 'false'."),
        limit: z.number().int().min(1).max(250).optional().describe('At most this many workflows (1-250).'),
      }),
      output: z.object({ data: z.array(n8nWorkflow) }),
      responses: RESPONSES("400: `error.code` 'BAD_REQUEST' ('Invalid query: …': `active` not a boolean, `limit` not 1-250). "),
    },
  ],
);
