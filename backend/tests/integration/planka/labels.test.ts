import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('LabelsResource (live Planka)', () => {
  let client: PlankaClient;
  let projectId: string;
  let boardId: string;
  let cardId: string;

  beforeAll(async () => {
    client = makeTestClient();
    const p = await client.projects.create({
      name: unique('fr-plan-labels-proj'),
      description: 'scratch project for LabelsResource integration test',
    });
    projectId = p.id;
    const b = await client.boards.create({ projectId, name: unique('fr-plan-labels-board') });
    boardId = b.id;
    const l = await client.lists.create({ boardId, name: unique('l'), position: 65536 });
    const c = await client.cards.create({ listId: l.id, name: unique('card') });
    cardId = c.id;
  });

  afterAll(async () => {
    await cleanupProjects(client, [projectId]);
  });

  test('create → update → attach → detach → delete', async () => {
    const name = unique('fr-plan-label');
    const lb = await client.labels.create({
      boardId,
      name,
      color: 'berry-red',
      position: 65536,
    });
    expect(lb.name).toBe(name);

    const upd = await client.labels.update(lb.id, { name: name + '-v2' });
    expect(upd.name).toBe(name + '-v2');

    await client.labels.attach(cardId, lb.id);
    const detail = await client.cards.get(cardId);
    expect((detail.included.cardLabels ?? []).some((x) => x.labelId === lb.id)).toBe(true);

    await client.labels.detach(cardId, lb.id);
    const detail2 = await client.cards.get(cardId);
    expect((detail2.included.cardLabels ?? []).some((x) => x.labelId === lb.id)).toBe(false);

    await client.labels.delete(lb.id);
  });
});
