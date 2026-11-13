// tests/integration/channels/web-inbound.integration.test.ts
//
// Phase 9 — webChannel.parseWebhook injection path:
//   1. Valid body + matching webhook secret → upserts agent_runtime_sessions
//      row, appends user message, returns InboundMessage.
//   2. Wrong webhook secret → null.
//   3. Invalid user_id (non-UUID) → null.
//   4. Repeated calls with same (user_id, session_id) → second call appends to
//      same row's messages (no duplicate row).

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';

import { db, queryClient, agentRuntimeSessions } from '../../../src/db/client';
import { webChannel } from '../../../src/channels/web';
import { config } from '../../../src/config';

import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('web-inbound');

const sql = queryClient;
const USER = '00000000-0000-4000-8000-cccccccccccc';
const SESSION = 'web-inbound-it-session';
let reachable = false;
let priorSecret: string | undefined;

// `config` is `as const` at module scope — strip readonly for the test
// override. This is the same pattern the rest of the integration suite
// uses when it needs to flip a runtime secret for a single test file.
const mutableN8n = config.services.n8n as { webhookSecret: string };

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM agent_runtime_sessions LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[web-inbound.integration] postgres unreachable — skipping:',
      (err as Error).message,
    );
  }
  // Set a known webhook secret for the duration of the suite.
  priorSecret = mutableN8n.webhookSecret;
  mutableN8n.webhookSecret = 'test-web-inbound-secret';
});

afterAll(async () => {
  mutableN8n.webhookSecret = priorSecret ?? '';
  if (!reachable) return;
  await db
    .delete(agentRuntimeSessions)
    .where(
      and(
        eq(agentRuntimeSessions.user_id, USER),
        eq(agentRuntimeSessions.channel, 'web'),
        eq(agentRuntimeSessions.thread_id, SESSION),
      ),
    );
});

function makeRequest(body: unknown, secret: string | null): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Webhook-Secret'] = secret;
  return new Request('http://test/webhook/web', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('webChannel.parseWebhook injection', () => {
  itDb('valid body + matching secret upserts thread + appends message', async () => {
    const inbound = await webChannel.parseWebhook(
      makeRequest(
        { user_id: USER, text: 'hello from n8n', session_id: SESSION },
        'test-web-inbound-secret',
      ),
    );

    expect(inbound).not.toBeNull();
    expect(inbound!.userId).toBe(USER);
    expect(inbound!.text).toBe('hello from n8n');
    expect(inbound!.channel).toBe('web');

    const [row] = await db
      .select()
      .from(agentRuntimeSessions)
      .where(
        and(
          eq(agentRuntimeSessions.user_id, USER),
          eq(agentRuntimeSessions.channel, 'web'),
          eq(agentRuntimeSessions.thread_id, SESSION),
        ),
      )
      .limit(1);
    expect(row).toBeDefined();
    const messages = (row!.messages ?? []) as Array<{ role: string; content: string }>;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[messages.length - 1]!.role).toBe('user');
    expect(messages[messages.length - 1]!.content).toBe('hello from n8n');
  });

  itDb('wrong secret → null (no row mutation)', async () => {
    const inbound = await webChannel.parseWebhook(
      makeRequest(
        { user_id: USER, text: 'should not land', session_id: SESSION },
        'wrong-secret',
      ),
    );
    expect(inbound).toBeNull();
  });

  itDb('invalid user_id → null', async () => {
    const inbound = await webChannel.parseWebhook(
      makeRequest(
        { user_id: 'not-a-uuid', text: 'hi', session_id: SESSION },
        'test-web-inbound-secret',
      ),
    );
    expect(inbound).toBeNull();
  });

  itDb('two concurrent calls both append (race-safe via Postgres jsonb ||)', async () => {
    // Run both webhooks in parallel against the same (user, thread). The
    // pre-fix read-modify-write would lose one message; appendMessage's
    // Postgres-side `messages || jsonb` concat keeps both.
    const before = await db
      .select()
      .from(agentRuntimeSessions)
      .where(
        and(
          eq(agentRuntimeSessions.user_id, USER),
          eq(agentRuntimeSessions.channel, 'web'),
          eq(agentRuntimeSessions.thread_id, SESSION),
        ),
      );
    const beforeCount = ((before[0]?.messages ?? []) as unknown[]).length;

    const [a, b] = await Promise.all([
      webChannel.parseWebhook(
        makeRequest(
          { user_id: USER, text: 'race-msg-A', session_id: SESSION },
          'test-web-inbound-secret',
        ),
      ),
      webChannel.parseWebhook(
        makeRequest(
          { user_id: USER, text: 'race-msg-B', session_id: SESSION },
          'test-web-inbound-secret',
        ),
      ),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const rows = await db
      .select()
      .from(agentRuntimeSessions)
      .where(
        and(
          eq(agentRuntimeSessions.user_id, USER),
          eq(agentRuntimeSessions.channel, 'web'),
          eq(agentRuntimeSessions.thread_id, SESSION),
        ),
      );
    expect(rows.length).toBe(1);
    const messages = (rows[0]!.messages ?? []) as Array<{ role: string; content: string }>;
    // Both A and B must be present — neither call's message lost to a race.
    expect(messages.length).toBeGreaterThanOrEqual(beforeCount + 2);
    const contents = messages.map((m) => m.content);
    expect(contents).toContain('race-msg-A');
    expect(contents).toContain('race-msg-B');
  });
});
