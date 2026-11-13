import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('TasksResource (live Planka)', () => {
  let client: PlankaClient;
  let projectId: string;
  let taskListId: string;

  beforeAll(async () => {
    client = makeTestClient();
    const p = await client.projects.create({
      name: unique('fr-plan-tasks-proj'),
      description: 'scratch project for TasksResource integration test',
    });
    projectId = p.id;
    const b = await client.boards.create({ projectId, name: unique('fr-plan-tasks-board') });
    const l = await client.lists.create({ boardId: b.id, name: unique('l'), position: 65536 });
    const c = await client.cards.create({ listId: l.id, name: unique('card') });
    const tl = await client.taskLists.create({ cardId: c.id, name: unique('tl'), position: 65536 });
    taskListId = tl.id;
  });

  afterAll(async () => {
    await cleanupProjects(client, [projectId]);
  });

  test('create → update → delete', async () => {
    const name = unique('fr-plan-task');
    const t = await client.tasks.create({ taskListId, name, position: 65536 });
    expect(t.name).toBe(name);

    const upd = await client.tasks.update(t.id, { isCompleted: true });
    expect((upd as { isCompleted: boolean }).isCompleted).toBe(true);

    await client.tasks.delete(t.id);
  });
});
