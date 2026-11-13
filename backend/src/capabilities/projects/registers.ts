// R2 / REG-3 (FR-PROJECT-HOME-REDESIGN-2026-10-26 §7.3) — the project's registers, a read-only
// proxy of requirements_management `GET /pm/projects/{eid}/registers` (RM #240):
//
//   projects.get_registers  GET /api/projects/:id/registers?phase=
//
// Same doors as the cockpit read (capabilities/projects/project-routes.ts): validateAuth, then the
// project READ lane (`loadProjectForRead`); RM is asked in the PROJECT's tenant. Not on the licence
// route allowlist; out of agent scope (the Overview reads it; the agent has no register action yet).
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { standardResponses } from '../account/_shared';
import { pathId, routeRule, settingsCapabilities } from '../settings/_shared';

const rule = routeRule(isAuthenticatedUserInResolvedTenant);
const projectId = (name: string) =>
  z.object({ [name]: pathId("Project id (a uuid; a malformed id is the same 404 as an absent project)") });
const PROJECT_404 = "404: `error` 'Project not found' (absent, malformed id, or not readable in the request tenant). ";
const ROUTES_MODULE = (m: string, load: () => Promise<Record<string, unknown>>) => ({ module: `src/routes/${m}.ts`, load });

export const PROJECT_REGISTER_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = [
  ...settingsCapabilities(
    { area: 'projects', tag: 'Projects', tenancy: 'project', rule, ...ROUTES_MODULE('project-registers', () => import('../../routes/project-registers')) },
    [
      {
        // REG-3 / R2 (FR-PROJECT-HOME-REDESIGN §7.3): a read-only proxy of RM #240.
        id: 'projects.get_registers', method: 'GET', path: '/api/projects/:id/registers', handler: 'handleGetProjectRegisters',
        summary: "A project's registers (risks, decisions, requirements, criteria) with the counts, from requirements_management", effect: 'read',
        description:
          "requirements_management `GET /pm/projects/{eid}/registers` for the project's RM pm_project (resolved from RM by origin_project_id), " +
          "read in the PROJECT's tenant. Risks by score (highest first), decisions and requirements newest first; `phase` filters " +
          'risks, decisions and requirements (criteria belong to the brief and are never filtered). A project with no RM link answers ' +
          "`{data: {available: false, reason: 'no_rm_project'}}`.",
        input: z.object({
          ...projectId('id').shape,
          phase: z
            .string()
            .optional()
            .describe("Only rows raised in this phase (a phase name: lowercase letters, digits, '_'; at most 64)."),
        }),
        output: z.object({
          data: z
            .object({
              available: z.boolean(),
              project_id: z.string(),
              reason: z.string().optional(),
              rm_project_id: z.string().optional(),
              phase: z.string().nullable().optional(),
              risks: z.array(z.record(z.unknown())).optional(),
              decisions: z.array(z.record(z.unknown())).optional(),
              requirements: z.array(z.record(z.unknown())).optional(),
              criteria: z.array(z.record(z.unknown())).optional(),
              counts: z
                .object({
                  risks_open: z.number().int(),
                  risks_total: z.number().int(),
                  decisions: z.number().int(),
                  requirements: z.number().int(),
                  criteria_met: z.number().int(),
                  criteria_total: z.number().int(),
                })
                .optional(),
            })
            .passthrough(),
        }),
        responses: standardResponses(
          "422: `code` 'invalid_phase' (`phase` is not a phase name). " +
            PROJECT_404 +
            "409: `code` 'project_tenant_unknown' (the project has no tenant tag). 502: `code` 'rm_registers_mismatch' " +
            '(requirements_management answered for another project). requirements_management unreachable or failing: its relayed ' +
            'status in the integration envelope (`error.code`). ',
        ),
      },
    ],
  ),
];
