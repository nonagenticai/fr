// tests/unit/db/conveyor-flow-runs-rm-ref.test.ts
//
// R345: fr keeps no RM pm_project id. Most n8n flows report a run under the RM
// id (`project_ref`), and the hook names no tenant to ask RM in, so the INGEST
// leaves such a row unresolved (project_id / tenant_id NULL) — it no longer
// maps it through `project_data.rm_pm_project_id`. The READ resolves it: a
// caller that resolved the project's RM id from RM passes it, and the
// unresolved rows with that ref are the project's. Real CI postgres.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { conveyorFlowRuns, db, projects } from '../../../src/db/client';
import { ingestFlowRuns, listFlowRunsForProject } from '../../../src/services/conveyor-flow-runs';

const OWNER = '66666666-6666-4666-8666-666666666601';
const TENANT = '66666666-6666-4666-8666-666666666602';
const RM_ID = '66666666-6666-4666-8666-6666666666aa';
const OTHER_RM = '66666666-6666-4666-8666-6666666666bb';
const EXEC = ['rmref-own-fr', 'rmref-own-rm', 'rmref-other-rm'] as const;

let projectId: string;

beforeEach(async () => {
  const [p] = await db
    .insert(projects)
    .values({
      owner_id: OWNER,
      name: 'flow-runs rm ref',
      status: 'active',
      // A stale stamp from before R345: the ingest must NOT map through it any more.
      project_data: { keycloak_tenant_id: TENANT, rm_pm_project_id: RM_ID },
    })
    .returning({ id: projects.id });
  projectId = p!.id;
  const out = await ingestFlowRuns([
    { execution_id: EXEC[0], status: 'success', project_ref: projectId },
    { execution_id: EXEC[1], status: 'error', project_ref: RM_ID },
    { execution_id: EXEC[2], status: 'success', project_ref: OTHER_RM },
  ]);
  expect(out.inserted).toBe(3);
});

afterEach(async () => {
  await db.delete(conveyorFlowRuns).where(inArray(conveyorFlowRuns.execution_id, [...EXEC]));
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
});

describe('flow runs reported under the RM id', () => {
  test('ingest resolves an fr-id ref; an RM-id ref stays unresolved (no stored RM id is read)', async () => {
    const rows = await db.select().from(conveyorFlowRuns).where(inArray(conveyorFlowRuns.execution_id, [...EXEC]));
    const by = new Map(rows.map((r) => [r.execution_id, r]));
    expect(by.get(EXEC[0])!.project_id).toBe(projectId);
    expect(by.get(EXEC[0])!.tenant_id).toBe(TENANT);
    expect(by.get(EXEC[1])!.project_id).toBeNull();
    expect(by.get(EXEC[1])!.tenant_id).toBeNull();
  });

  test("with the RM id RM resolved, the project's list includes its RM-ref runs and nobody else's", async () => {
    const ids = (await listFlowRunsForProject(projectId, { tenantId: TENANT, rmPmProjectId: RM_ID })).map((r) => r.execution_id);
    expect(ids.sort()).toEqual([EXEC[0], EXEC[1]].sort());
  });

  test('CONTROL: without the RM id only the fr-id run is listed', async () => {
    const ids = (await listFlowRunsForProject(projectId, { tenantId: TENANT })).map((r) => r.execution_id);
    expect(ids).toEqual([EXEC[0]]);
  });
});
