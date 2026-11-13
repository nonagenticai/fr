import { test, expect, beforeAll, afterAll } from 'bun:test';
import { plankaDescribe, makeTestClient, unique, cleanupProjects } from './_setup';
import type { PlankaClient } from '../../../src/services/planka';

plankaDescribe('MembersResource (live Planka)', () => {
  let client: PlankaClient;
  let projectId: string;
  let boardId: string;

  beforeAll(async () => {
    client = makeTestClient();
    const p = await client.projects.create({
      name: unique('fr-plan-members-proj'),
      description: 'scratch project for MembersResource integration test',
    });
    projectId = p.id;
    const b = await client.boards.create({
      projectId,
      name: unique('fr-plan-members-board'),
    });
    boardId = b.id;
  });

  afterAll(async () => {
    await cleanupProjects(client, [projectId]);
  });

  test('listUsers + getUser hit real endpoints', async () => {
    const users = await client.members.listUsers();
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);
    const first = users[0]!;
    const got = await client.members.getUser(first.id);
    expect(got.id).toBe(first.id);
  });

  test('listBoardMembers reads from board detail', async () => {
    const members = await client.members.listBoardMembers(boardId);
    // The board creator is always a member, so this list is non-empty.
    expect(Array.isArray(members)).toBe(true);
    expect(members.length).toBeGreaterThan(0);
  });

  test('listProjectMembers reads from project detail', async () => {
    const users = await client.members.listProjectMembers(projectId);
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);
  });
});
