// tests/unit/db/rm-outage-fr-data.test.ts
//
// R345 principle: fr calls requirements_management only when it needs an RM id. Anything fr's own
// data answers keeps working when RM is down. Each case below runs with fr's RM token UNSET, so
// any RM call would throw SERVICE_NOT_CONFIGURED: a pass means the path made no RM call.
// Real CI postgres; no test double.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { conveyorFlowRuns, db, projects } from '../../../src/db/client';
import { projectConveyorFailures } from '../../../src/db/schema';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from '../../../src/integrations/_lib/service-credential';
import { resolveConveyorBoardProject } from '../../../src/routes/kanban/cards';
import { withRmRefRuns } from '../../../src/services/cockpit/project-cockpit';
import { downPanel, okPanel } from '../../../src/services/cockpit/panel';
import { ingestFlowRuns } from '../../../src/services/conveyor-flow-runs';
import { recordConveyorFailure } from '../../../src/services/conveyor-failures';
import type { RmProjectState } from '../../../src/services/catalogue/project-state';

const OWNER = '88888888-8888-4888-8888-888888888801';
const TENANT = '88888888-8888-4888-8888-888888888802';
const RM_ID = '88888888-8888-4888-8888-8888888888aa';
const BOARD = 'board-rm-outage-fr-data';
const EXEC = ['rmout-fr', 'rmout-rm'] as const;

const savedToken = process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
let projectId: string;

beforeAll(async () => {
  delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
  const [p] = await db
    .insert(projects)
    .values({ owner_id: OWNER, name: 'rm outage', status: 'active', planka_board_id: BOARD, project_data: { keycloak_tenant_id: TENANT } })
    .returning({ id: projects.id });
  projectId = p!.id;
  await ingestFlowRuns([
    { execution_id: EXEC[0], status: 'success', project_ref: projectId },
    { execution_id: EXEC[1], status: 'error', project_ref: RM_ID },
  ]);
});

afterEach(async () => {
  await db.delete(projectConveyorFailures).where(eq(projectConveyorFailures.tenant_id, TENANT));
});

afterAll(async () => {
  if (savedToken === undefined) delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
  else process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = savedToken;
  await db.delete(conveyorFlowRuns).where(inArray(conveyorFlowRuns.execution_id, [...EXEC]));
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
});

describe('a human card move decides conveyor-ness from the cached link (no RM)', () => {
  test("the project naming this board in its RM-written cache is the board's conveyor project", async () => {
    expect(await resolveConveyorBoardProject(BOARD)).toEqual({ id: projectId, tenantId: TENANT });
  });

  test('a board no fr project names (stream / ad-hoc) is not a conveyor board', async () => {
    expect(await resolveConveyorBoardProject('board-nobody-owns')).toBeNull();
  });
});

describe('cockpit flow runs: the fr-id runs survive an RM outage', () => {
  const fr = async () => okPanel((await db.select().from(conveyorFlowRuns).where(eq(conveyorFlowRuns.execution_id, EXEC[0]))));
  const rmState = { rmPmProjectId: RM_ID } as RmProjectState;

  test('RM down ⇒ the fr-id runs, degraded `rm_unavailable` (never fr_db)', async () => {
    const out = await withRmRefRuns(await fr(), downPanel<RmProjectState>('rm_upstream_unreachable'), projectId, TENANT);
    expect(out.health).toBe('degraded');
    expect(out.detail_code).toBe('rm_unavailable');
    expect(out.data!.map((r) => r.execution_id)).toEqual([EXEC[0]]);
  });

  test('RM holds no pm_project ⇒ the fr-id runs as they are', async () => {
    const out = await withRmRefRuns(await fr(), downPanel<RmProjectState>('rm_rm_project_missing'), projectId, TENANT);
    expect(out.health).toBe('ok');
    expect(out.data!.map((r) => r.execution_id)).toEqual([EXEC[0]]);
  });

  test("RM answered ⇒ the runs reported under the RM id are added", async () => {
    const out = await withRmRefRuns(await fr(), okPanel(rmState), projectId, TENANT);
    expect(out.health).toBe('ok');
    expect(out.data!.map((r) => r.execution_id).sort()).toEqual([...EXEC].sort());
  });
});

describe('a coach failure naming only an RM id is stored, unattached, rather than lost', () => {
  test('project_id NULL, the raw RM id and card kept', async () => {
    const { row, created } = await recordConveyorFailure({
      kind: 'coach_failed',
      projectId: null,
      projectName: null,
      tenantId: TENANT,
      executionId: 'coach-exec-unattached',
      rmProjectId: RM_ID,
      cardId: 'card-1',
      flow: 'cap.kanban_coach.handle_error',
      node: 'Coach result',
      errorClass: 'agent_failed',
      errorText: 'comment failed too',
    });
    expect(created).toBe(true);
    expect(row.project_id).toBeNull();
    expect(row.rm_project_id).toBe(RM_ID);
    expect(row.card_id).toBe('card-1');
  });

  test('a replay is the stored notice (idempotent on tenant + coach execution)', async () => {
    const input = {
      kind: 'coach_failed' as const,
      projectId: null,
      projectName: null,
      tenantId: TENANT,
      executionId: 'coach-exec-replay',
      rmProjectId: RM_ID,
      errorText: 'x',
    };
    const first = await recordConveyorFailure(input);
    const again = await recordConveyorFailure(input);
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
  });
});
