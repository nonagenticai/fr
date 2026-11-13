// planka-private#24: webhook delivery is opt-in per board, so fr must subscribe
// every board it creates to the n8n instance that serves it — or that board is
// silent. Behaviour over a fake transport: which webhook, which call, and that
// every way of ending up unsubscribed throws.

import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PlankaError, PlankaNotFoundError, type PlankaClient } from '../../../../src/services/planka';
import { createProjectWithDefaultBoard } from '../../../../src/services/planka/intake';
import {
  ensureWebhookSubscription,
  webhookNameFor,
} from '../../../../src/services/planka/webhook-subscription';

// Literal on purpose: not derived from the constants under test.
const KATA = '0195f48b-d000-7000-8000-000000000006';
const V4_CONVEYOR = '5f868d42-03f8-51f0-a93c-3e83070dc196';
const CUSTOMER = '0195f48b-d000-7000-8000-000000000100';

const WEBHOOKS = [
  { id: '11', name: 'n8n-per-flow', boardIds: [] as string[] },
  { id: '22', name: 'kata-n8n-per-flow', boardIds: [] as string[] },
];

function fakeAgent(webhooks = WEBHOOKS, opts: { dropSubscription?: boolean } = {}) {
  const calls: Array<{ op: string; webhookId?: string; boardId?: string }> = [];
  const agent = {
    webhooks: {
      async list() {
        calls.push({ op: 'list' });
        return webhooks;
      },
      async addBoard(webhookId: string, boardId: string) {
        calls.push({ op: 'addBoard', webhookId, boardId });
        const hook = webhooks.find((w) => w.id === webhookId)!;
        return { ...hook, boardIds: opts.dropSubscription ? [] : [...hook.boardIds, boardId] };
      },
    },
  };
  return { agent, calls };
}

describe('webhookNameFor — the owning tenant picks the instance', () => {
  test('kata tenant → kata-n8n', () => expect(webhookNameFor(KATA)).toBe('kata-n8n-per-flow'));
  test('v4 conveyor tenant → conveyor n8n', () => expect(webhookNameFor(V4_CONVEYOR)).toBe('n8n-per-flow'));
  test('customer / unknown tenant → none (fail closed)', () => {
    expect(webhookNameFor(CUSTOMER)).toBeNull();
    expect(webhookNameFor(undefined)).toBeNull();
    expect(webhookNameFor(null)).toBeNull();
  });
});

describe('ensureWebhookSubscription', () => {
  test('a conveyor board is subscribed to the conveyor webhook only', async () => {
    const { agent, calls } = fakeAgent();
    expect(await ensureWebhookSubscription(agent, { boardId: '900', tenantId: V4_CONVEYOR })).toEqual({
      subscribed: 'n8n-per-flow',
    });
    expect(calls.filter((c) => c.op === 'addBoard')).toEqual([{ op: 'addBoard', webhookId: '11', boardId: '900' }]);
  });

  test('a kata board is subscribed to the kata-n8n webhook only', async () => {
    const { agent, calls } = fakeAgent();
    await ensureWebhookSubscription(agent, { boardId: '901', tenantId: KATA });
    expect(calls.filter((c) => c.op === 'addBoard').map((c) => c.webhookId)).toEqual(['22']);
  });

  test('a customer board is subscribed to nothing and makes no call', async () => {
    const { agent, calls } = fakeAgent();
    expect(await ensureWebhookSubscription(agent, { boardId: '902', tenantId: CUSTOMER })).toEqual({
      skipped: 'not_platform',
    });
    expect(calls).toEqual([]);
  });

  test('throws when the named webhook does not exist', async () => {
    const { agent } = fakeAgent([WEBHOOKS[1]!]);
    await expect(ensureWebhookSubscription(agent, { boardId: '903', tenantId: V4_CONVEYOR })).rejects.toThrow(
      /found 0/,
    );
  });

  test('throws when the name is ambiguous', async () => {
    const { agent } = fakeAgent([WEBHOOKS[0]!, { ...WEBHOOKS[0]!, id: '33' }]);
    await expect(ensureWebhookSubscription(agent, { boardId: '904', tenantId: V4_CONVEYOR })).rejects.toThrow(
      /found 2/,
    );
  });

  test('throws when Planka answers without recording the subscription', async () => {
    const { agent } = fakeAgent(WEBHOOKS, { dropSubscription: true });
    await expect(ensureWebhookSubscription(agent, { boardId: '905', tenantId: V4_CONVEYOR })).rejects.toThrow(
      /did not record/,
    );
  });
});

describe('ensureWebhookSubscription — errors are PlankaErrors (502 planka_intake_failed)', () => {
  test('a missing webhook', async () => {
    const { agent } = fakeAgent([]);
    await expect(ensureWebhookSubscription(agent, { boardId: '906', tenantId: KATA })).rejects.toBeInstanceOf(
      PlankaError,
    );
  });

  test('a Planka without the subscription route (404) propagates as a PlankaError', async () => {
    const { agent } = fakeAgent();
    agent.webhooks.addBoard = async () => {
      throw new PlankaNotFoundError('not found', { status: 404, path: '/api/webhooks/11/boards' });
    };
    await expect(ensureWebhookSubscription(agent, { boardId: '907', tenantId: V4_CONVEYOR })).rejects.toBeInstanceOf(
      PlankaError,
    );
  });
});

// The intake is the path every fr project create and kata open takes. Removing
// the subscription call from it must turn these red.
function fakeIntakeAgent(webhooks = WEBHOOKS) {
  const { agent: hooks, calls } = fakeAgent(webhooks);
  const deleted: string[] = [];
  const agent = {
    projects: {
      create: async () => ({ id: 'p1', name: 'x' }),
      delete: async (id: string) => void deleted.push(`project:${id}`),
    },
    boards: {
      create: async () => ({ id: 'b1', name: 'x' }),
      delete: async (id: string) => void deleted.push(`board:${id}`),
    },
    members: { addBoardMember: async () => ({}) },
    lists: { create: async (i: { name: string }) => ({ id: `l-${i.name}` }) },
    labels: { create: async () => ({ id: 'lab' }) },
    webhooks: hooks.webhooks,
  } as unknown as PlankaClient;
  return { agent, calls, deleted };
}

const SPEC = { template: 'default', lists: [{ name: 'TODO' }], labels: [], fieldGroups: [] };

describe('createProjectWithDefaultBoard subscribes the new board', () => {
  test('a conveyor-tenant board is subscribed to the conveyor webhook', async () => {
    const { agent, calls } = fakeIntakeAgent();
    await createProjectWithDefaultBoard(agent, { name: 'x' }, V4_CONVEYOR, SPEC as never);
    expect(calls.filter((c) => c.op === 'addBoard')).toEqual([{ op: 'addBoard', webhookId: '11', boardId: 'b1' }]);
  });

  test('a kata-tenant board is subscribed to the kata-n8n webhook', async () => {
    const { agent, calls } = fakeIntakeAgent();
    await createProjectWithDefaultBoard(agent, { name: 'x' }, KATA, SPEC as never);
    expect(calls.filter((c) => c.op === 'addBoard').map((c) => c.webhookId)).toEqual(['22']);
  });

  test('a failed subscription tears the project down and fails the create', async () => {
    const { agent, deleted } = fakeIntakeAgent([]);
    await expect(createProjectWithDefaultBoard(agent, { name: 'x' }, V4_CONVEYOR, SPEC as never)).rejects.toBeInstanceOf(
      PlankaError,
    );
    expect(deleted).toEqual(['board:b1', 'project:p1']);
  });
});

describe('the asset-stream board path subscribes too', () => {
  const src = readFileSync(join(import.meta.dir, '../../../../src/services/streams/provisioner.ts'), 'utf8');

  test('createStreamBoard calls ensureWebhookSubscription right after the conveyor grant', () => {
    const grant = src.indexOf('await ensureConveyorMembership(agent, { boardId: board.id, tenantId });');
    const sub = src.indexOf('await ensureWebhookSubscription(agent, { boardId: board.id, tenantId });');
    expect(grant).toBeGreaterThan(-1);
    expect(sub).toBeGreaterThan(grant);
  });

  test('a failed subscription deletes the stream board before rethrowing', () => {
    const sub = src.indexOf('await ensureWebhookSubscription(agent, { boardId: board.id, tenantId });');
    const tail = src.slice(sub, sub + 600);
    expect(tail).toMatch(/catch \(err\) \{[\s\S]*await agent\.boards\.delete\(board\.id\);[\s\S]*throw err;/);
  });
});
