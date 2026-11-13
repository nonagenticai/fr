// fr-agui SPEC §13 P4c part 2 — spec drain: `POST /api/asset-scope/:assetType/:assetId/promote`
// (routes/asset-scope/promote.ts), re-expressed with NO behaviour change (`legacyHandler`). It writes an
// `owns` edge for one of the request tenant's library assets (the tenant `ctxTenantId(user.tenantId)`
// resolves: the frame tenant, else the JWT one; a throw → 500 with neither). Its siblings override / block
// (project scope) are P2's (P4-carry ownership decision).
//
// Gate: validateAuth (thrown to the central catch), the asset type and the body (400), then BY TARGET:
//   * `to: 'workspace'` — a workspace-admin of the resolved tenant (`isWorkspaceAdminVia`, 403 otherwise);
//   * `to: { dept_id }` — that, OR a dept-admin / dept-manager of a department that belongs to the resolved
//     tenant (an unknown one: 404 'department not found').
// Declared: the route-aware workspace-admin rule with `deptManagerOfPromoteTarget`.
import { z } from 'zod';

import { ASSET_TYPES } from '../../routes/assets/assignments-schemas';
import type { Capability } from '../define';
import { pathId, settingsCapabilities, standardResponses, workspaceAdminRule } from '../observe/_shared';

export const ASSET_SCOPE_PROMOTE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'asset_assignments', tag: 'Asset Scope', tenancy: 'tenant',
    module: 'src/routes/asset-scope/promote.ts', load: () => import('../../routes/asset-scope/promote'),
    rule: workspaceAdminRule({ deptManagerOfPromoteTarget: true }),
  },
  [
    {
      id: 'asset_assignments.promote', method: 'POST', path: '/api/asset-scope/:assetType/:assetId/promote', handler: 'handlePromote', effect: 'write',
      summary: "Promote one of the request tenant's library assets to the whole workspace, or to a department",
      description:
        "Upserts the asset's `owns` edge at that scope. To the workspace: workspace-admin. To a department: workspace-admin, " +
        "or that department's dept-admin / dept-manager. Other body keys are ignored.",
      input: z.object({
        assetType: z.enum(ASSET_TYPES).describe('The asset kind (else 400).'),
        assetId: pathId('The asset id'),
        to: z
          .union([z.literal('workspace'), z.object({ dept_id: z.string().min(1) })])
          .describe("'workspace', or `{ dept_id }` (a department of the request tenant)."),
      }),
      output: z.object({ ok: z.literal(true) }),
      responses: standardResponses(
        "400: `error` 'unknown asset_type: …', 'invalid JSON body' or \"body.to must be 'workspace' or { dept_id: string }\". " +
          "403: `error` 'workspace-admin role required to promote to workspace' or 'dept-manager role on the target department " +
          "required'. 404: `error` 'department not found' (not a department of the request tenant). ",
        { noTenant500: true },
      ),
    },
  ],
);
