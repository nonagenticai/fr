// tests/integration/routes/kanban/cards.test.ts
// Live Planka integration for T22 card write routes.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from '../../../integration/planka/_setup';
import type { PlankaClient } from '../../../../src/services/planka';

import {
  handleCreateCard,
  handleUpdateCard,
  handleMoveCard,
  handleDuplicateCard,
  handleDeleteCard,
} from '../../../../src/routes/kanban/cards';

plankaDescribe('kanban card write routes (live Planka)', () => {
  let setupClient: PlankaClient;
  let projectId: string;
  let listId: string;
  let otherListId: string;

  beforeAll(async () => {
    setupClient = makeTestClient();
    const p = await setupClient.projects.create({
      name: unique('fr-routes-cards-proj'),
      description: 'scratch project for card routes',
    });
    projectId = p.id;
    const b = await setupClient.boards.create({ projectId, name: unique('fr-routes-cards-board') });
    const l1 = await setupClient.lists.create({ boardId: b.id, name: unique('l1'), position: 65536 });
    const l2 = await setupClient.lists.create({ boardId: b.id, name: unique('l2'), position: 131072 });
    listId = l1.id;
    otherListId = l2.id;
  });

  afterAll(async () => {
    await cleanupProjects(setupClient, [projectId]);
  });

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${process.env.TEST_PLANKA_USER_TOKEN ?? 'unused-in-bypass'}`,
    'Content-Type': 'application/json',
  });

  test('create → update → move → duplicate → delete via FR routes', async () => {
    const name = unique('fr-routes-card');

    // Create
    const createReq = new Request(`http://fr/api/kanban/lists/${listId}/cards`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name }),
    });
    const createRes = await handleCreateCard(createReq, listId);
    expect(createRes.status).toBe(201);
    const card = (await createRes.json()) as { id: string; name: string };
    expect(card.name).toBe(name);

    // Update
    const updateReq = new Request(`http://fr/api/kanban/cards/${card.id}`, {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ name: name + '-v2' }),
    });
    const updateRes = await handleUpdateCard(updateReq, card.id);
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { name: string };
    expect(updated.name).toBe(name + '-v2');

    // Move
    const moveReq = new Request(`http://fr/api/kanban/cards/${card.id}/move`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ listId: otherListId, position: 65536 }),
    });
    const moveRes = await handleMoveCard(moveReq, card.id);
    expect(moveRes.status).toBe(200);

    // Duplicate
    const dupReq = new Request(`http://fr/api/kanban/cards/${card.id}/duplicate`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name: name + '-copy' }),
    });
    const dupRes = await handleDuplicateCard(dupReq, card.id);
    expect(dupRes.status).toBe(201);
    const duplicated = (await dupRes.json()) as { id: string };

    // Cleanup: delete both
    await handleDeleteCard(new Request(`http://fr/api/kanban/cards/${card.id}`, { method: 'DELETE', headers: authHeaders() }), card.id);
    await handleDeleteCard(new Request(`http://fr/api/kanban/cards/${duplicated.id}`, { method: 'DELETE', headers: authHeaders() }), duplicated.id);
  });
});
