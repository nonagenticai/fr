// fr-agui SPEC §13 P4c part 1 — spec drain: GET /api/assets/_assignments
// (routes/assets/assignments.ts), the Library "Overrides only" / "Blocked" filter
// read over `asset_assignments`, re-expressed with NO behaviour change.
//
// Gate: validateAuth (its refusals thrown to the central catch), the query schema,
// then `tryCtxTenantId() ?? user.tenantId` — refused 403 when that is empty.
// Declared: `isAuthenticatedUserInFrameOrJwtTenant`. A tenant-level read (the
// workspace's edges; a department / project scope is a FILTER, never a gate), so
// P4c: the project-scoped override / block WRITES are P2's.
import { z } from 'zod';

import { QuerySchema } from '../../routes/assets/assignments-schemas';
import type { Capability } from '../define';
import { isAuthenticatedUserInFrameOrJwtTenant } from '../rbac-rules';
import { routeRule, settingsCapabilities, standardResponses } from './_shared';

export const ASSET_ASSIGNMENT_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'asset_assignments', tag: 'Asset Scope', tenancy: 'tenant',
    module: 'src/routes/assets/assignments.ts', load: () => import('../../routes/assets/assignments'),
    rule: routeRule(isAuthenticatedUserInFrameOrJwtTenant),
  },
  [
    {
      id: 'asset_assignments.list', method: 'GET', path: '/api/assets/_assignments', handler: 'handleListAssetAssignments',
      summary: "The request tenant's asset scope edges (owns / override / block) of one asset type at one scope", effect: 'read',
      description:
        'Workspace scope (or no scope_kind): the workspace-level edges. department / project: the edges targeting that ' +
        '`scope_id` (required then). Unknown query keys are ignored.',
      input: QuerySchema,
      output: z.object({
        data: z.array(z.object({ asset_id: z.string(), link_kind: z.enum(['owns', 'override', 'block']) })),
      }),
      responses: standardResponses(
        "400: `error` 'Invalid query parameters: …' (`details`: the issues) — a missing / unknown `type`, a non-uuid " +
          "`scope_id`, or a department / project scope without one. 403: `error` 'tenant context required' (no request " +
          'tenant and no JWT tenant). ',
      ),
    },
  ],
);
