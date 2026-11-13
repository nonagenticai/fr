import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('ProjectsResource (live Planka)', () => {
  let client: PlankaClient;
  const created: string[] = [];

  beforeAll(() => { client = makeTestClient(); });
  afterAll(async () => {
    await cleanupProjects(client, created);
  });

  test('create → get → update → list → delete', async () => {
    const name = unique('fr-plan-proj');
    const p = await client.projects.create({ name, description: 'from plan test' });
    created.push(p.id);
    expect(p.name).toBe(name);

    const got = await client.projects.get(p.id);
    expect(got.id).toBe(p.id);

    const upd = await client.projects.update(p.id, { name: name + '-v2' });
    expect(upd.name).toBe(name + '-v2');

    const list = await client.projects.list();
    expect(list.some((x) => x.id === p.id)).toBe(true);

    await client.projects.delete(p.id);
    created.splice(created.indexOf(p.id), 1);
    await expect(client.projects.get(p.id)).rejects.toThrow();
  });
});
