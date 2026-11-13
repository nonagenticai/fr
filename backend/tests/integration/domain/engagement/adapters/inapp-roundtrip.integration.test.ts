// E-10: in-app channel roundtrip integration test.
//
// Requires the local fr-postgres container with migration 015 applied.
// Skips gracefully if the DB / table isn't reachable.
//
// Verifies:
//   - InAppAdapter.sendMessage writes a real outbound row.
//   - inappChannel.parseWebhook persists a real inbound row.
//   - GET-equivalent listing (raw SQL) returns both, newest first.
import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { queryClient } from '../../../../../src/db/client';
import { inappAdapter } from '../../../../../src/domain/engagement/adapters/inapp';
import { inappChannel } from '../../../../../src/channels/inapp';

import { createDbSuite } from '../../../helpers/db-suite';

const sql = queryClient;
let reachable = false;

const USER_ID = '11111111-2222-3333-4444-555555555555';

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM inapp_messages LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[inapp-roundtrip] DB not reachable, skipping. Start fr-postgres with migration 015 applied. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

beforeEach(async () => {
  if (reachable) {
    await sql`DELETE FROM inapp_messages WHERE user_id = ${USER_ID}::uuid`;
  }
});

const { itDb } = createDbSuite('inapp-roundtrip');

describe('inapp roundtrip', () => {
  itDb('outbound: adapter.sendMessage writes a row visible via SQL', async () => {
    const res = await inappAdapter.sendMessage(USER_ID, {
      kind: 'text',
      correlationId: 'cid-out-1',
      text: 'agent says hi',
    });
    expect(res.success).toBe(true);

    const rows = await sql<{ direction: string; text: string; correlation_id: string | null }[]>`
      SELECT direction, text, correlation_id
        FROM inapp_messages
       WHERE user_id = ${USER_ID}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.direction).toBe('outbound');
    expect(rows[0]!.text).toBe('agent says hi');
    expect(rows[0]!.correlation_id).toBe('cid-out-1');
  });

  itDb('inbound: channel.parseWebhook writes a row + returns InboundMessage', async () => {
    const req = new Request('http://test/api/inapp/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: USER_ID,
        text: 'user typed something',
        correlationId: 'cid-in-1',
      }),
    });
    const msg = await inappChannel.parseWebhook(req);
    expect(msg).not.toBeNull();
    expect(msg!.userId).toBe(USER_ID);
    expect(msg!.text).toBe('user typed something');
    expect(msg!.correlationId).toBe('cid-in-1');

    const rows = await sql<{ direction: string; text: string }[]>`
      SELECT direction, text FROM inapp_messages WHERE user_id = ${USER_ID}::uuid
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.direction).toBe('inbound');
    expect(rows[0]!.text).toBe('user typed something');
  });

  itDb('list query returns outbound + inbound newest-first', async () => {
    // Write outbound first.
    await inappAdapter.sendMessage(USER_ID, {
      kind: 'text', correlationId: 'cid-out', text: 'first (outbound)',
    });
    // Then inbound via channel.
    const req = new Request('http://test/api/inapp/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, text: 'second (inbound)' }),
    });
    await inappChannel.parseWebhook(req);

    const rows = await sql<{ direction: string; text: string }[]>`
      SELECT direction, text
        FROM inapp_messages
       WHERE user_id = ${USER_ID}::uuid
    ORDER BY created_at DESC
    `;
    expect(rows.length).toBe(2);
    // Newest-first: inbound (written second) appears first.
    expect(rows[0]!.direction).toBe('inbound');
    expect(rows[0]!.text).toBe('second (inbound)');
    expect(rows[1]!.direction).toBe('outbound');
    expect(rows[1]!.text).toBe('first (outbound)');
  });

  itDb('parseWebhook returns null and writes nothing on bad payload', async () => {
    const req = new Request('http://test/api/inapp/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'not-a-uuid', text: 'x' }),
    });
    const msg = await inappChannel.parseWebhook(req);
    expect(msg).toBeNull();

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM inapp_messages WHERE user_id = ${USER_ID}::uuid
    `;
    expect(rows[0]!.count).toBe('0');
  });
});
