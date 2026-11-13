// The two batch pointer-clears — `clear-dangling-board-refs.ts`'s
// `clearProjectBoardRef` and `reconcile-orphaned-projects.ts`'s
// `archiveAndClearBoardRow` — decide to clear from a READ taken earlier (the
// ref list / the orphan list), then UPDATE. Between the two, another writer can
// re-point the row at a new, live board. The `AND planka_board_id = <old>`
// guard in each UPDATE is the only thing that keeps that NEW pointer alive.
//
// These tests run the REAL writers against Postgres: a row still on the old
// board IS cleared (control), and a row already re-pointed at a new board
// before the writer runs keeps its NEW pointer. Remove either guard and the
// re-pointed row is NULLed: red.

import { describe, expect, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { db, projects } from '../../../src/db/client';
import { clearProjectBoardRef } from '../../../src/scripts/clear-dangling-board-refs';
import { archiveAndClearBoardRow } from '../../../scripts/reconcile-orphaned-projects';
import { createDbSuite } from '../../integration/helpers/db-suite';

const { itDb } = createDbSuite('board-pointer-conditional-clear');

const RUN = crypto.randomUUID().slice(0, 8);
const OLD = `old-board-${RUN}`;
const NEW = `new-board-${RUN}`;
const PP = `pp-${RUN}`;
const seeded: string[] = [];

async function seed(board: string, status = 'active'): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({
      owner_id: 'a3000011-0000-4000-8000-00000000000a',
      name: `ptr-clear-${RUN}`,
      repository_url: 'https://example.com/repo',
      status,
      planka_board_id: board,
      planka_project_id: PP,
    })
    .returning({ id: projects.id });
  seeded.push(row!.id);
  return row!.id;
}

async function row(id: string) {
  const [r] = await db
    .select({ board: projects.planka_board_id, status: projects.status })
    .from(projects)
    .where(eq(projects.id, id));
  return r!;
}

const repoint = (id: string) =>
  db.update(projects).set({ planka_board_id: NEW }).where(eq(projects.id, id));

afterAll(async () => {
  if (seeded.length) await db.delete(projects).where(inArray(projects.id, seeded));
});

describe('clear-dangling-board-refs — conditional UPDATE', () => {
  itDb('a row re-pointed after the read keeps its NEW pointer', async () => {
    const id = await seed(OLD, 'archived');
    await repoint(id);
    expect(await clearProjectBoardRef(id, OLD)).toBe(0);
    expect((await row(id)).board).toBe(NEW);
  });

  itDb('control: an un-repointed row IS cleared by the same writer', async () => {
    const id = await seed(OLD, 'archived');
    expect(await clearProjectBoardRef(id, OLD)).toBe(1);
    expect((await row(id)).board).toBeNull();
  });
});

describe('reconcile-orphaned-projects — conditional archive+clear UPDATE', () => {
  itDb('a row re-pointed after the read is neither archived nor cleared', async () => {
    const id = await seed(OLD);
    await repoint(id);
    expect(await archiveAndClearBoardRow(id, OLD)).toBe(0);
    const after = await row(id);
    expect(after.board).toBe(NEW);
    expect(after.status).toBe('active');
  });

  itDb('control: an un-repointed row IS archived and cleared by the same writer', async () => {
    const id = await seed(OLD);
    expect(await archiveAndClearBoardRow(id, OLD)).toBe(1);
    const after = await row(id);
    expect(after.board).toBeNull();
    expect(after.status).toBe('archived');
  });
});
