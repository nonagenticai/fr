// fr-agui SPEC §13 P4c part 1 — spec drain: GET /api/traceability/graph
// (routes/traceability.ts), the tenant's cross-domain traceability graph composed
// from requirements_management's architecture relationships, re-expressed with NO
// behaviour change.
//
// Gate: validateAuth (thrown to the central catch), fr's own query checks, then the
// requirements_management architecture client, which REQUIRES a frame tenant
// (non-blank; MISSING_TENANT, nothing sent). Declared:
// `isAuthenticatedUserInFrameTenant`. Tenant-level: the whole graph, or one entity's
// neighbourhood, optionally scoped to one project (`project_id`).
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInFrameTenant } from '../rbac-rules';
import { routeRule, settingsCapabilities, standardResponses } from './_shared';

const dimension = z.enum(['architecture', 'requirement', 'decision', 'principle', 'pm', 'other']);

export const TRACEABILITY_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'traceability', tag: 'Traceability', tenancy: 'tenant',
    module: 'src/routes/traceability.ts', load: () => import('../../routes/traceability'),
    rule: routeRule(isAuthenticatedUserInFrameTenant),
  },
  [
    {
      id: 'traceability.get_graph', method: 'GET', path: '/api/traceability/graph', handler: 'handleGetTraceabilityGraph',
      summary: "The request tenant's traceability graph: every relationship (capped at 1000), or breadth-first from one entity", effect: 'read',
      description: 'root_type and root_id are a PAIR: both (a rooted graph) or neither (the whole graph).',
      input: z.object({
        root_type: z.string().optional().describe('The root entity table (e.g. architecture_elements, requirements). Blank is absent.'),
        root_id: z.string().optional().describe('The root entity id. Blank is absent.'),
        depth: z.string().optional().describe('Hops from the root, an integer 1..3 (default 2; blank is the default; anything else is a 400). Parsed even without a root.'),
        project_id: z.string().optional().describe('Scope to one project: only relationships requirements_management stamped with this project id. Blank is absent.'),
      }),
      output: z.object({
        data: z.object({
          nodes: z.array(
            z.object({
              id: z.string().describe('`<entity_type>:<entity_id>`'),
              label: z.string(),
              dimension,
              entity_type: z.string(),
              entity_id: z.string(),
              route: z.string().nullable().describe('The frontend detail href, or null when none is wired.'),
              is_root: z.boolean(),
            }),
          ),
          links: z.array(z.object({ source: z.string(), target: z.string(), type: z.string(), label: z.string().nullable() })),
          root: z.object({ entity_type: z.string(), entity_id: z.string(), depth: z.number().int() }).nullable(),
        }),
        meta: z.object({ node_count: z.number().int(), link_count: z.number().int(), truncated: z.boolean() }),
      }),
      responses: standardResponses(
        "400: `error` — a half-supplied root (root_type and root_id are a pair) or a `depth` that is not an integer 1..3 " +
          "(nothing sent). 409: `error.code` 'MISSING_TENANT' (no request tenant: nothing is sent to requirements_management). " +
          "Any other status is requirements_management's, relayed (`error.code` 'UPSTREAM_…'). ",
      ),
    },
  ],
);
