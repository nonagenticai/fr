// tests/integration/routes/kanban/comments.test.ts
// Live Planka integration for the FR kanban comment HTTP routes.
//
// Gated via plankaDescribe (TEST_PLANKA_* env vars). AUTH_BYPASS=true
// (set globally via tests/setup.ts preload) is required so
// validateAuthWithToken returns a stub user whose token is forwarded
// verbatim to Planka's bearer-exchange.
//
// This test calls the route handlers directly (Request in, Response out)
// rather than wiring a full Bun.serve — keeps the test self-contained
// and avoids port allocation.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from '../../../integration/planka/_setup';
import type { PlankaClient } from '../../../../src/services/planka';

// Route handlers (re-exported from the barrel).
import {
  handleListComments,
  handleCreateComment,
} from '../../../../src/routes/kanban/comments';

plankaDescribe('kanban comments routes (live Planka)', () => {
  let setupClient: PlankaClient;
  let projectId: string;
  let cardId: string;

  beforeAll(async () => {
    setupClient = makeTestClient();
    const p = await setupClient.projects.create({
      name: unique('fr-routes-comments-proj'),
      description: 'scratch project for comments route integration',
    });
    projectId = p.id;
    const b = await setupClient.boards.create({
      projectId,
      name: unique('fr-routes-comments-board'),
    });
    const l = await setupClient.lists.create({
      boardId: b.id,
      name: unique('l'),
      position: 65536,
    });
    const c = await setupClient.cards.create({ listId: l.id, name: unique('card') });
    cardId = c.id;
  });

  afterAll(async () => {
    await cleanupProjects(setupClient, [projectId]);
  });

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${process.env.TEST_PLANKA_USER_TOKEN ?? 'unused-in-bypass'}`,
    'Content-Type': 'application/json',
  });

  test('POST → GET /api/kanban/.../comments', async () => {
    // POST comment
    const text = 'integration ' + unique('t');
    const postReq = new Request(`http://fr/api/kanban/cards/${cardId}/comments`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text }),
    });
    const postRes = await handleCreateComment(postReq, cardId);
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string; text: string };
    expect(created.text).toBe(`via @dev@localhost: ${text}`);

    // GET comments
    const getReq = new Request(`http://fr/api/kanban/cards/${cardId}/comments`, {
      headers: authHeaders(),
    });
    const getRes = await handleListComments(getReq, cardId);
    expect(getRes.status).toBe(200);
    const listBody = (await getRes.json()) as { items: Array<{ id: string }> };
    expect(listBody.items.some((c) => c.id === created.id)).toBe(true);
  });
});
