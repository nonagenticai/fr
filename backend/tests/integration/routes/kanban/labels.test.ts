// tests/integration/routes/kanban/labels.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from '../../../integration/planka/_setup';
import type { PlankaClient } from '../../../../src/services/planka';

import { handleAttachLabel, handleDetachLabel } from '../../../../src/routes/kanban/labels';

plankaDescribe('kanban label routes (live Planka)', () => {
  let setupClient: PlankaClient;
  let projectId: string;
  let boardId: string;
  let cardId: string;
  let labelId: string;

  beforeAll(async () => {
    setupClient = makeTestClient();
    const p = await setupClient.projects.create({
      name: unique('fr-routes-labels-proj'),
      description: 'scratch project for label routes',
    });
    projectId = p.id;
    const b = await setupClient.boards.create({ projectId, name: unique('fr-routes-labels-board') });
    boardId = b.id;
    const l = await setupClient.lists.create({ boardId: b.id, name: unique('l'), position: 65536 });
    const c = await setupClient.cards.create({ listId: l.id, name: unique('card') });
    cardId = c.id;
    // Labels are created in Planka itself (fr's label create route was removed
    // 2026-10-10); fr only attaches/detaches an existing board label.
    const lab = await setupClient.labels.create({ boardId: b.id, name: unique('lab'), color: 'berry-red' });
    labelId = lab.id;
  });

  afterAll(async () => {
    await cleanupProjects(setupClient, [projectId]);
  });

  const h = (): Record<string, string> => ({
    Authorization: `Bearer unused-in-bypass`,
    'Content-Type': 'application/json',
  });

  test('attach → detach an existing board label', async () => {
    const attachRes = await handleAttachLabel(
      new Request(`http://fr/api/kanban/cards/${cardId}/labels/${labelId}`, {
        method: 'POST', headers: h(),
      }),
      cardId, labelId,
    );
    expect(attachRes.status).toBe(204);

    const detachRes = await handleDetachLabel(
      new Request(`http://fr/api/kanban/cards/${cardId}/labels/${labelId}`, {
        method: 'DELETE', headers: h(),
      }),
      cardId, labelId,
    );
    expect(detachRes.status).toBe(204);
  });
});
