// routes/internal-projects-tenant-map.ts
//
//   GET /api/internal/projects/tenant-map   X-Internal-Token == FR_BILLING_INTERNAL_TOKEN
//
// billing-service validates that a usage event's `project_id` belongs to the
// tenant it is billed to. fr is the source of truth for project -> tenant, so
// billing pulls the whole map (~134 rows) in ONE query and caches it.
//
// AUTH — one caller, one secret. Same shape as the coding-github binding lookup
// (routes/github-app.ts `handleGetGithubAppBinding`): `X-Internal-Token`
// compared constant-time (utils/secret-compare.ts) to a DEDICATED env that only
// billing-service holds. It deliberately does NOT reuse FR_GITHUB_BINDING_TOKEN:
// rotating one caller's secret must not touch another caller.
//
//   env unset/empty -> 503  (fail CLOSED: the route is unconfigured, and the
//                            caller must be able to tell that apart from a bad
//                            token it could fix by re-reading its secret)
//   token missing / wrong -> 401
//
// RESPONSE — a bare cross-repo wire contract consumed by billing-service, not
// a UI route:
//
//   { "projects": [{ "project_id", "tenant_id": uuid|null, "archived": bool }],
//     "generated_at": iso }
//
// tenant_id is `project_data->>'keycloak_tenant_id'`, NULL when absent. ALL
// projects are returned, archived included: historical usage events reference
// them, and an archived project still belongs to its tenant.

import { asc, sql } from 'drizzle-orm';
import { db, projects } from '../db/client';
import { jsonResponse } from '../utils/response';
import { timingSafeEquals } from '../utils/secret-compare';

const BILLING_INTERNAL_TOKEN_ENV = 'FR_BILLING_INTERNAL_TOKEN';

interface ProjectTenantRow {
  project_id: string;
  tenant_id: string | null;
  archived: boolean;
}

async function listProjectTenants(): Promise<ProjectTenantRow[]> {
  const rows = await db
    .select({
      project_id: projects.id,
      tenant_id: sql<string | null>`NULLIF(${projects.project_data}->>'keycloak_tenant_id', '')`,
      status: projects.status,
    })
    .from(projects)
    .orderBy(asc(projects.id));
  return rows.map((r) => ({
    project_id: r.project_id,
    tenant_id: r.tenant_id ?? null,
    archived: r.status === 'archived',
  }));
}

/** Read LIVE (not a config snapshot) so a rotation via env + restart and a test
 * that sets env after config.ts evaluated are both seen. */
function expectedToken(): string {
  return (process.env[BILLING_INTERNAL_TOKEN_ENV] ?? '').trim();
}

export async function handleGetProjectsTenantMap(req: Request): Promise<Response> {
  const expected = expectedToken();
  if (!expected) {
    return jsonResponse({ error: 'tenant_map_not_configured' }, 503);
  }
  const presented = req.headers.get('X-Internal-Token') ?? '';
  if (!presented || !timingSafeEquals(presented, expected)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const rows = await listProjectTenants();
  return jsonResponse({ projects: rows, generated_at: new Date().toISOString() });
}
