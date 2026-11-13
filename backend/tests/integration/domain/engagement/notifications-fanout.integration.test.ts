// Integration tests for NotificationService.fanOutToUser.
//
// Phase 2 / Bucket C — converted from
// tests/unit/domain/engagement/notifications-fanout.test.ts. The unit
// version stubbed `mock.module('drizzle-orm', ...)` + `mock.module('db/client', ...)`
// with hand-rolled in-memory query state. Assertions about
// "engagement_deliveries was inserted with status=sent" only proved the
// stub captured the values it was handed — not that the SQL is valid.
// This integration version exercises the real `db.insert(...)` path
// against CI Postgres and inspects the actual rows written.

import { expect, describe, beforeAll, beforeEach } from 'bun:test';
import { sql as drizzleSql } from 'drizzle-orm';
import {
  db,
  queryClient,
} from '../../../../src/db/client';
import { addPref } from '../../../../src/domain/engagement/channel-prefs';
import {
  NotificationService,
  type ApprovalWithDetails,
} from '../../../../src/domain/engagement/notifications';

import { createDbSuite } from '../../helpers/db-suite';

const sql = queryClient;

// Distinct user_id namespace so concurrent integration suites don't
// interfere. user_id is TEXT in user_channel_prefs and engagement_deliveries.
const USER_D = 'fanout-int-user-d';
const TEST_USER_IDS = [USER_D];

let reachable = false;

const approval: ApprovalWithDetails = {
  // engagement_id is TEXT, but the `approval.id` we pass is also written
  // into engagement_deliveries.engagement_id — pin a stable UUID so cleanup
  // and cross-row queries are deterministic.
  id: 'aaaaaaaa-1111-4111-8111-fanout000000',
  project_id: null,
  description: 'fanout integration approval',
  card_id: null,
  callback_path: null,
  source: 'web',
  metadata: null,
  status: 'pending',
  expires_at: new Date(Date.now() + 86400000),
  requester_id: 'fanout-int-requester',
};

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM engagement_deliveries LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[notifications-fanout.integration] DB not reachable, skipping. Start fr-postgres with migration 008 applied. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

beforeEach(async () => {
  if (!reachable) return;
  for (const uid of TEST_USER_IDS) {
    await db.execute(
      drizzleSql`DELETE FROM engagement_deliveries WHERE recipient_user_id = ${uid}`,
    );
    await db.execute(
      drizzleSql`DELETE FROM user_channel_prefs WHERE user_id = ${uid}`,
    );
  }
});

const { itDb } = createDbSuite('notifications-fanout');

interface DeliveryRow {
  id: string;
  channel: string;
  recipient_user_id: string | null;
  status: string;
  error: string | null;
}

async function deliveriesFor(userId: string): Promise<DeliveryRow[]> {
  return await sql<DeliveryRow[]>`
    SELECT id, channel, recipient_user_id, status, error
      FROM engagement_deliveries
     WHERE recipient_user_id = ${userId}
     ORDER BY created_at ASC
  `;
}

describe('NotificationService.fanOutToUser (integration)', () => {
  itDb('unregistered channel records a failed delivery, does not throw', async () => {
    const svc = new NotificationService();
    await addPref(USER_D, { channel: 'carrier-pigeon', address: 'coop', enabled: true });

    await svc.fanOutToUser(approval, USER_D);

    const rows = await deliveriesFor(USER_D);
    const failed = rows.filter((r) => r.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.channel).toBe('carrier-pigeon');
    expect(failed[0]!.error).toContain('not registered');
  });
});
