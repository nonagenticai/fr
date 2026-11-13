// tests/unit/db/archive-closes-rm.test.ts
//
// R351 / rm#272: archiving an fr project first closes its RM pm_project, and FAILS CLOSED on it —
// an RM failure is 502 `rm_project_close_failed` and nothing is archived. A project RM can hold no
// row for (no tenant tag) is archived anyway.
//
// Real CI postgres; no test double. RM's own answers (200 close, 404) need a live
// requirements_management and are verified live; here RM is either refused before sending (token
// unset) or unreachable (the suite's unroutable host) — both RM failures the archive must refuse on.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, projects } from '../../../src/db/client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from '../../../src/integrations/_lib/service-credential';
import { closeRmProjectOfArchive } from '../../../src/services/catalogue/project-state';
import { archiveProjectRow, archiveProjectWithPurge } from '../../../src/services/project-archive';

const OWNER = '99999999-9999-4999-8999-999999999901';
const TENANT = '99999999-9999-4999-8999-999999999902';
const savedToken = process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];

afterEach(async () => {
  if (savedToken === undefined) delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
  else process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = savedToken;
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
});
afterAll(() => {
  if (savedToken === undefined) delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
  else process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = savedToken;
});

async function project(projectData: Record<string, unknown>) {
  const [row] = await db
    .insert(projects)
    .values({ owner_id: OWNER, name: 'archive closes rm', status: 'active', project_data: projectData })
    .returning();
  return row!;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
  return row!.status;
}

async function refusal(p: Promise<unknown>): Promise<{ status?: number; code?: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return { status: (err as { statusCode?: number }).statusCode, code: (err as { code?: string }).code };
  }
}

describe('the archive closes the RM project first, and fails closed on RM', () => {
  test('RM refused before sending (token unset): 502 rm_project_close_failed, the project stays active', async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
    const p = await project({ keycloak_tenant_id: TENANT });
    expect(await refusal(archiveProjectRow(p, { actor: 'test', keepBoard: true }))).toEqual({
      status: 502,
      code: 'rm_project_close_failed',
    });
    expect(await statusOf(p.id)).toBe('active');
  });

  test('RM unreachable: the user / admin archive (with purge) refuses BEFORE purging, the project stays active', async () => {
    const p = await project({ keycloak_tenant_id: TENANT });
    expect(await refusal(archiveProjectWithPurge(p, { tenantId: TENANT, actor: 'test', keepBoard: true }))).toEqual({
      status: 502,
      code: 'rm_project_close_failed',
    });
    expect(await statusOf(p.id)).toBe('active');
  });

  test('a project with no tenant tag has no RM project: no RM call, archived anyway', async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV]; // any RM call would throw
    const p = await project({});
    expect(await closeRmProjectOfArchive(p)).toEqual({ kind: 'no_rm_project', reason: 'the project has no tenant tag' });
    expect(await refusal(archiveProjectRow(p, { actor: 'test', keepBoard: true }))).toBeNull();
    expect(await statusOf(p.id)).toBe('archived');
  });
});
