import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('CardsResource (live Planka)', () => {
  let client: PlankaClient;
  let projectId: string;
  let listId: string;
  let otherListId: string;

  beforeAll(async () => {
    client = makeTestClient();
    const p = await client.projects.create({
      name: unique('fr-plan-cards-proj'),
      description: 'scratch project for CardsResource integration test',
    });
    projectId = p.id;
    const b = await client.boards.create({ projectId, name: unique('fr-plan-cards-board') });
    const l1 = await client.lists.create({ boardId: b.id, name: unique('l1'), position: 65536 });
    const l2 = await client.lists.create({ boardId: b.id, name: unique('l2'), position: 131072 });
    listId = l1.id;
    otherListId = l2.id;
  });

  afterAll(async () => {
    await cleanupProjects(client, [projectId]);
  });

  test('create → get → update → move → duplicate → delete', async () => {
    const name = unique('fr-plan-card');
    const c = await client.cards.create({ listId, name });
    expect(c.name).toBe(name);

    const detail = await client.cards.get(c.id);
    expect(detail.item.id).toBe(c.id);
    expect(detail.included).toBeDefined();

    const upd = await client.cards.update(c.id, { name: name + '-v2', description: 'new desc' });
    expect(upd.name).toBe(name + '-v2');

    const moved = await client.cards.move(c.id, { listId: otherListId, position: 65536 });
    expect((moved as { listId: string }).listId).toBe(otherListId);

    // duplicate() with no caller-supplied name/position must succeed against
    // a real Planka 2.1.0 — Planka requires `position` and the resource
    // injects a default. Regression: previously omitted position → 422
    // E_UNPROCESSABLE_ENTITY → mapped to 400 in the FR API.
    const dup = await client.cards.duplicate(c.id);
    expect(dup.id).not.toBe(c.id);
    expect((dup as { listId?: string }).listId).toBe(otherListId);
    expect(typeof (dup as { position?: number }).position).toBe('number');

    // duplicate() with explicit name + position round-trips both fields.
    const dup2Name = unique('explicit-copy');
    const dup2 = await client.cards.duplicate(c.id, dup2Name, 200000);
    expect(dup2.id).not.toBe(c.id);
    expect(dup2.id).not.toBe(dup.id);
    expect(dup2.name).toBe(dup2Name);
    expect((dup2 as { position?: number }).position).toBe(200000);

    await client.cards.delete(c.id);
    await client.cards.delete(dup.id).catch(() => {});
    await client.cards.delete(dup2.id).catch(() => {});
    await expect(client.cards.get(c.id)).rejects.toThrow();
  });
});
