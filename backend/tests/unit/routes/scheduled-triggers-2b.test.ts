// tests/unit/routes/scheduled-triggers-2b.test.ts
//
// Plan 2-B route validation: connector_config + payload_mapper at save time.
// Tests the pure validation logic that rejects before any DB call.

import { describe, expect, test } from 'bun:test';
import { handleCreateScheduledTrigger } from '../../../src/routes/scheduled-triggers';
import { handleError } from '../../../src/utils/errors';

// AUTH_BYPASS=true is set globally by tests/setup.ts and relied on by
// many later test files in the same `bun test` process. Do NOT toggle it
// here — deleting it in `afterAll` previously poisoned every downstream
// test that called validateAuth without an explicit mock.

// Mirrors server.ts's global error handler — convert thrown AppError to Response.
async function call(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return handleError(err);
  }
}

function makeJsonReq(body: unknown): Request {
  return new Request('http://test/api/scheduled-triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validConnectorConfig = {
  kind: 'rss',
  secret_id: null,
  feed_url: 'https://example.com/rss',
  max_items: 50,
};

const validBase = {
  project_id: '00000000-0000-4000-8000-000000000001',
  name: 'test-trigger',
  cron: '* * * * *',
  timezone: 'UTC',
  source_connector: 'rss',
  connector_config: validConnectorConfig,
  card_template: { card_type: 'work_intake_record' },
  payload_mapper: { card_title: '$.title' },
};

describe('POST /api/scheduled-triggers — Plan 2-B validation', () => {
  test('rejects payload_mapper with filter expression [?(@.x)] → 400', async () => {
    const res = await call(() =>
      handleCreateScheduledTrigger(
        makeJsonReq({
          ...validBase,
          payload_mapper: { filtered: '$.items[?(@.active)]' },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    const msg = (body.error ?? body.message ?? '').toLowerCase();
    expect(msg).toMatch(/forbidden|payload_mapper/);
  });

  test('rejects payload_mapper with script expression [(@.length-1)] → 400', async () => {
    const res = await call(() =>
      handleCreateScheduledTrigger(
        makeJsonReq({
          ...validBase,
          payload_mapper: { last: '$.items[(@.length-1)]' },
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  test('rejects connector_config with missing required field (feed_url) → 400', async () => {
    const res = await call(() =>
      handleCreateScheduledTrigger(
        makeJsonReq({
          ...validBase,
          connector_config: {
            kind: 'rss',
            secret_id: null,
            // feed_url intentionally missing
          },
        }),
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    const msg = (body.error ?? body.message ?? '').toLowerCase();
    expect(msg).toMatch(/connector_config/);
  });

  test('rejects connector_config with unknown kind → 400', async () => {
    const res = await call(() =>
      handleCreateScheduledTrigger(
        makeJsonReq({
          ...validBase,
          source_connector: 'rss',
          connector_config: {
            kind: 'imap', // not in ConnectorConfig discriminated union
            secret_id: null,
          },
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  test('accepts valid connector_config + valid payload_mapper (passes validation, fails at DB)', async () => {
    // This will fail at DB lookup (no such project_id in test env) but passes validation gates.
    // We expect 4xx (NOT 400) — DB 404 is acceptable, 400 would mean validation failed.
    const res = await call(() =>
      handleCreateScheduledTrigger(makeJsonReq(validBase)),
    );
    // 400 = validation rejected (BAD — means our valid config was flagged)
    // 404 = project not found (OK — means validation passed, DB rejected)
    // Anything except 400 for the validation tests confirms the mapper and config are accepted
    expect(res.status).not.toBe(400);
  });
});
