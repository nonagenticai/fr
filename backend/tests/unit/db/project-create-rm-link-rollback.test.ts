// tests/unit/db/project-create-rm-link-rollback.test.ts
//
// R351: the RM board link is part of the create. `commitProjectAndLinkRm` is the create's commit
// step (createSingleProject calls it once its Planka board exists): ONE transaction with every fr
// write and, last, the RM POST + board link. When the link cannot be made the create answers
// 502 `rm_project_link_failed`, the fr row is rolled back and the Planka project + board are torn
// down — never logged-and-continued.
//
// Real CI postgres. No test double: the board below is a pure data fixture (ids), RM and Planka are
// the suite's unroutable hosts, and the teardown is observed through fr's OWN failure log lines
// (Planka cannot be reached, so each teardown DELETE is reported by name).
import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, projects } from '../../../src/db/client';
import { commitProjectAndLinkRm, ProjectCreateError } from '../../../src/routes/projects';

const OWNER = '77777777-7777-4777-8777-777777777701';
const TENANT = '77777777-7777-4777-8777-777777777702';
const PLANKA_PROJECT = 'planka-project-rm-link-rollback';
const PLANKA_BOARD = 'planka-board-rm-link-rollback';
const ALL_LISTS = { TODO: 'l1', READY: 'l2', DOING: 'l3', QA: 'l4', DONE: 'l5', BLOCKED: 'l6' };

afterEach(async () => {
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
});

/** Run `fn` with console.error / console.warn / console.log captured; returns the joined lines. */
async function captured(fn: () => Promise<unknown>): Promise<{ err: unknown; log: string }> {
  const lines: string[] = [];
  const keep = { error: console.error, warn: console.warn, log: console.log };
  const grab = (...a: unknown[]) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = grab;
  console.warn = grab;
  console.log = grab;
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    console.error = keep.error;
    console.warn = keep.warn;
    console.log = keep.log;
  }
  return { err, log: lines.join('\n') };
}

function create(projectId: string, listIds: Record<string, string>) {
  return commitProjectAndLinkRm({
    projectId,
    planka: { projectId: PLANKA_PROJECT, boardId: PLANKA_BOARD, listIds },
    rm: {
      tenantId: TENANT,
      title: 'rm link rollback',
      description: null,
      catalogueType: { id: '77777777-7777-4777-8777-7777777777aa' },
      createdByUserId: OWNER,
      intake: { brief: {} } as never,
    },
    writeRow: async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({ id: projectId, owner_id: OWNER, name: 'rm link rollback', status: 'active', project_data: { keycloak_tenant_id: TENANT } })
        .returning();
      return row!;
    },
  });
}

async function rowExists(id: string): Promise<boolean> {
  return (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id))).length > 0;
}

describe('the RM board link fails ⇒ the create fails closed', () => {
  test('a board RM cannot link (no BLOCKED list): 502 rm_project_link_failed, row rolled back, board torn down', async () => {
    const id = crypto.randomUUID();
    const { BLOCKED: _blocked, ...fiveLists } = ALL_LISTS;
    const { err, log } = await captured(() => create(id, fiveLists));
    expect(err).toBeInstanceOf(ProjectCreateError);
    expect((err as ProjectCreateError).httpStatus).toBe(502);
    expect((err as ProjectCreateError).payload.error).toBe('rm_project_link_failed');
    expect(await rowExists(id)).toBe(false);
    expect(log).toContain(`/api/boards/${PLANKA_BOARD}`);
    expect(log).toContain(`/api/projects/${PLANKA_PROJECT}`);
  });

  test('RM unreachable: the same 502 rm_project_link_failed, row rolled back, board torn down', async () => {
    const id = crypto.randomUUID();
    const { err, log } = await captured(() => create(id, ALL_LISTS));
    expect(err).toBeInstanceOf(ProjectCreateError);
    expect((err as ProjectCreateError).httpStatus).toBe(502);
    expect((err as ProjectCreateError).payload.error).toBe('rm_project_link_failed');
    expect(await rowExists(id)).toBe(false);
    expect(log).toContain(`/api/boards/${PLANKA_BOARD}`);
  });

  test('CONTROL: the row the commit writes IS visible inside its transaction (the rollback is what removes it)', async () => {
    const id = crypto.randomUUID();
    let seenInside = false;
    await captured(() =>
      commitProjectAndLinkRm({
        projectId: id,
        planka: { projectId: PLANKA_PROJECT, boardId: PLANKA_BOARD, listIds: {} },
        rm: { tenantId: TENANT, title: 't', description: null, catalogueType: null, createdByUserId: OWNER, intake: { brief: {} } as never },
        writeRow: async (tx) => {
          const [row] = await tx
            .insert(projects)
            .values({ id, owner_id: OWNER, name: 't', status: 'active', project_data: { keycloak_tenant_id: TENANT } })
            .returning();
          seenInside = (await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id))).length === 1;
          return row!;
        },
      }),
    );
    expect(seenInside).toBe(true);
    expect(await rowExists(id)).toBe(false);
  });
});
