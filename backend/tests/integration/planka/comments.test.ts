import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('CommentsResource (live Planka)', () => {
  let client: PlankaClient;
  let projectId: string;
  let cardId: string;

  beforeAll(async () => {
    client = makeTestClient();
    const p = await client.projects.create({
      name: unique('fr-plan-comments-proj'),
      description: 'scratch project for CommentsResource integration test',
    });
    projectId = p.id;
    const b = await client.boards.create({ projectId, name: unique('fr-plan-comments-board') });
    const l = await client.lists.create({ boardId: b.id, name: unique('l'), position: 65536 });
    const c = await client.cards.create({ listId: l.id, name: unique('card') });
    cardId = c.id;
  });

  afterAll(async () => {
    await cleanupProjects(client, [projectId]);
  });

  test('create → listForCard → update → delete', async () => {
    const text = 'hello from integration ' + unique('t');
    const cm = await client.comments.create({ cardId, text });
    expect(cm.text).toBe(text);

    const all = await client.comments.listForCard(cardId);
    expect(all.some((x) => x.id === cm.id)).toBe(true);

    const upd = await client.comments.update(cm.id, { text: text + ' (edited)' });
    expect(upd.text).toBe(text + ' (edited)');

    await client.comments.delete(cm.id);
    const after = await client.comments.listForCard(cardId);
    expect(after.some((x) => x.id === cm.id)).toBe(false);
  });
});
