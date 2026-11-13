// tests/integration/routes/notifications-inapp.integration.test.ts
//
// Integration tests for POST /api/notifications/inapp — the outbound
// admin notification entry point used by n8n improvement-loop done.json
// subflows. Mirrors the skip-if-unreachable pattern used by
// kaizen-log.integration.test.ts.
//
// Asserts:
//   1. Happy path → 202; persists row with direction='outbound', text=body,
//      meta_json carries subject/level/link_url/correlation_id/stream_id.
//   2. Non-internal tenant → 404 (404-not-403 convention; surface stays
//      private from regular tenants).
//   3. Missing required fields → 422 with Zod error details.
//   4. Unicode + long body within limits is preserved verbatim.

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { db, queryClient, inappMessages } from '../../../src/db/client';
import { handleSendInappNotification } from '../../../src/routes/notifications/inapp';
import { withRequestContext } from '../../../src/integrations/_lib/context';
import { INTERNAL_SYSTEM_TENANT_ID } from '../../../src/middleware/internal-tenant-only';

import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('notifications-inapp');

const sql = queryClient;
const TENANT = INTERNAL_SYSTEM_TENANT_ID;
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const RECIPIENT = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const RECIPIENT_2 = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const RECIPIENT_UNICODE = '33333333-3333-4333-8333-cccccccccccc';
const RECIPIENT_OTHER = '44444444-4444-4444-8444-dddddddddddd';
const RECIPIENT_PROMPT = '55555555-5555-4555-8555-eeeeeeeeeeee';

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM inapp_messages LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[notifications-inapp.integration] postgres unreachable — skipping:',
      (err as Error).message,
    );
  }
  if (reachable) {
    process.env.AUTH_BYPASS = 'true';
  }
});

async function cleanup(): Promise<void> {
  if (!reachable) return;
  await db
    .delete(inappMessages)
    .where(
      inArray(inappMessages.user_id, [
        RECIPIENT,
        RECIPIENT_2,
        RECIPIENT_UNICODE,
        RECIPIENT_OTHER,
        RECIPIENT_PROMPT,
      ]),
    );
}

beforeEach(cleanup);
afterAll(cleanup);

const ctx = (tenantId: string) => ({
  correlationId: 'cid-notifications-inapp-test',
  initiator: 'human' as const,
  channel: 'web' as const,
  tenantId,
  bearerToken: 'bypass',
});

function makeReq(body?: unknown): Request {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request('http://t/api/notifications/inapp', init);
}

describe('POST /api/notifications/inapp', () => {
  itDb('happy path → 202, persists outbound row with payload mapped into meta_json', async () => {
    const payload = {
      recipientUserId: RECIPIENT,
      subject: 'Improvement promoted',
      body: 'Your kaizen card #42 was promoted to production.',
      level: 'info' as const,
      linkUrl: 'https://fr.nonagentic.ai/cards/42',
      correlationId: 'cid-imp-42',
      streamId: '66666666-6666-4666-8666-ffffffffffff',
    };

    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(makeReq(payload)),
    );
    expect(resp.status).toBe(202);
    const json = (await resp.json()) as { id: string; queued: boolean };
    expect(json.queued).toBe(true);
    expect(typeof json.id).toBe('string');
    expect(json.id.length).toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(inappMessages)
      .where(eq(inappMessages.id, json.id));
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.user_id).toBe(RECIPIENT);
    expect(row.direction).toBe('outbound');
    expect(row.text).toBe(payload.body);
    expect(row.correlation_id).toBe(payload.correlationId);

    const meta = row.meta_json as Record<string, unknown>;
    expect(meta['kind']).toBe('admin-notification');
    expect(meta['subject']).toBe(payload.subject);
    expect(meta['level']).toBe('info');
    expect(meta['link_url']).toBe(payload.linkUrl);
    expect(meta['correlation_id']).toBe(payload.correlationId);
    expect(meta['stream_id']).toBe(payload.streamId);
    expect(meta['posted_by_tenant']).toBe(TENANT);
  });

  itDb('default level is info when omitted, optional fields drop cleanly', async () => {
    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT_2,
          subject: 'Heads up',
          body: 'Plain note, no link.',
        }),
      ),
    );
    expect(resp.status).toBe(202);
    const json = (await resp.json()) as { id: string };
    const rows = await db
      .select()
      .from(inappMessages)
      .where(eq(inappMessages.id, json.id));
    const row = rows[0]!;
    expect(row.correlation_id).toBeNull();
    const meta = row.meta_json as Record<string, unknown>;
    expect(meta['level']).toBe('info');
    expect(meta['link_url']).toBeUndefined();
    expect(meta['stream_id']).toBeUndefined();
    expect(meta['correlation_id']).toBeUndefined();
  });

  itDb('a deleted improvement tenant (prompt-improvement, 2026-11-03) → 404', async () => {
    const resp = await withRequestContext(ctx('0195f48b-d000-7000-8000-000000000004'), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT_PROMPT,
          subject: 'Prompt loop notice',
          body: 'A prompt was rolled back.',
          level: 'warn',
        }),
      ),
    );
    expect(resp.status).toBe(404);
    const rows = await db.select().from(inappMessages).where(eq(inappMessages.user_id, RECIPIENT_PROMPT));
    expect(rows.length).toBe(0);
  });

  itDb('non-internal tenant → 404 (privacy: surface stays hidden)', async () => {
    const resp = await withRequestContext(ctx(OTHER_TENANT), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT_OTHER,
          subject: 'Should not happen',
          body: 'forbidden caller',
        }),
      ),
    );
    expect(resp.status).toBe(404);

    // And no row was written.
    const rows = await db
      .select()
      .from(inappMessages)
      .where(eq(inappMessages.user_id, RECIPIENT_OTHER));
    expect(rows.length).toBe(0);
  });

  itDb('missing recipientUserId → 422 with Zod error details', async () => {
    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(
        makeReq({
          subject: 'No recipient',
          body: 'oops',
        }),
      ),
    );
    expect(resp.status).toBe(422);
    const json = (await resp.json()) as {
      error: string;
      details: Array<{ path: (string | number)[]; message: string }>;
    };
    expect(json.error).toBe('Validation error');
    expect(Array.isArray(json.details)).toBe(true);
    const paths = json.details.map((d) => d.path.join('.'));
    expect(paths).toContain('recipientUserId');
  });

  itDb('missing subject → 422', async () => {
    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT,
          body: 'no subject here',
        }),
      ),
    );
    expect(resp.status).toBe(422);
  });

  itDb('missing body → 422', async () => {
    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT,
          subject: 'No body',
        }),
      ),
    );
    expect(resp.status).toBe(422);
  });

  itDb('invalid JSON body → 422', async () => {
    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(makeReq('this-is-not-json{')),
    );
    expect(resp.status).toBe(422);
  });

  itDb('linkUrl that is not a URL → 422', async () => {
    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT,
          subject: 'Bad link',
          body: 'has a non-URL link',
          linkUrl: 'not-a-url',
        }),
      ),
    );
    expect(resp.status).toBe(422);
  });

  itDb('unicode + long body within limits is preserved verbatim', async () => {
    const subject = '完了 — Kaizen ✅ ⚙️ 重要';
    // 9_500 JS-string-length chars of mixed BMP + supplementary-plane
    // content; well under the 10_000 limit. Includes emoji (surrogate
    // pairs → 2 string-length units each) + CJK + RTL Arabic.
    const chunk =
      'Δέλτα ロールバック ✓ مرحبا 🚀🎯 — line ends with newline.\n';
    const body = chunk.repeat(Math.ceil(9_500 / chunk.length)).slice(0, 9_500);
    expect(body.length).toBe(9_500);

    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT_UNICODE,
          subject,
          body,
          level: 'error',
        }),
      ),
    );
    expect(resp.status).toBe(202);
    const json = (await resp.json()) as { id: string };
    const rows = await db
      .select()
      .from(inappMessages)
      .where(eq(inappMessages.id, json.id));
    const row = rows[0]!;
    expect(row.text).toBe(body);
    expect(row.text.length).toBe(9_500);
    const meta = row.meta_json as Record<string, unknown>;
    expect(meta['subject']).toBe(subject);
    expect(meta['level']).toBe('error');
  });

  itDb('body over 10_000 chars → 422', async () => {
    const tooLong = 'x'.repeat(10_001);
    const resp = await withRequestContext(ctx(TENANT), () =>
      handleSendInappNotification(
        makeReq({
          recipientUserId: RECIPIENT,
          subject: 'Way too long',
          body: tooLong,
        }),
      ),
    );
    expect(resp.status).toBe(422);
  });
});
