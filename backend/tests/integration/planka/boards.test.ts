import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('BoardsResource (live Planka)', () => {
  let client: PlankaClient;
  let projectId: string;

  beforeAll(async () => {
    client = makeTestClient();
    const p = await client.projects.create({
      name: unique('fr-plan-boards-proj'),
      description: 'scratch project for BoardsResource integration test',
    });
    projectId = p.id;
  });

  afterAll(async () => {
    // Planka refuses to delete a project that still has boards — cleanupProjects
    // deletes boards first and throws if anything is left behind.
    await cleanupProjects(client, [projectId]);
  });

  test('create → get → update → listByProject → delete', async () => {
    const name = unique('fr-plan-board');
    const b = await client.boards.create({ projectId, name });
    expect(b.name).toBe(name);

    const detail = await client.boards.get(b.id);
    expect(detail.item.id).toBe(b.id);
    expect(detail.included).toBeDefined();

    const upd = await client.boards.update(b.id, { name: name + '-v2' });
    expect(upd.name).toBe(name + '-v2');

    const list = await client.boards.listByProject(projectId);
    expect(list.some((x) => x.id === b.id)).toBe(true);

    await client.boards.delete(b.id);
    await expect(client.boards.get(b.id)).rejects.toThrow();
  });
});
