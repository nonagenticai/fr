import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('ListsResource (live Planka)', () => {
  let client: PlankaClient;
  let projectId: string;
  let boardId: string;

  beforeAll(async () => {
    client = makeTestClient();
    const p = await client.projects.create({
      name: unique('fr-plan-lists-proj'),
      description: 'scratch project for ListsResource integration test',
    });
    projectId = p.id;
    const b = await client.boards.create({ projectId, name: unique('fr-plan-lists-board') });
    boardId = b.id;
  });

  afterAll(async () => {
    await cleanupProjects(client, [projectId]);
  });

  test('create → update → listByBoard → delete', async () => {
    const name = unique('fr-plan-list');
    const l = await client.lists.create({ boardId, name, position: 65536 });
    expect(l.name).toBe(name);

    const upd = await client.lists.update(l.id, { name: name + '-v2' });
    expect(upd.name).toBe(name + '-v2');

    const all = await client.lists.listByBoard(boardId);
    expect(all.some((x) => x.id === l.id)).toBe(true);

    await client.lists.delete(l.id);
    const after = await client.lists.listByBoard(boardId);
    expect(after.some((x) => x.id === l.id)).toBe(false);
  });
});
