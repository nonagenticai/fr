// tests/integration/domain/notification-prefs-concurrent.integration.test.ts
//
// replaceNotificationPrefs is a replace-all (delete + insert in one
// transaction). Two overlapping calls for one user used to both delete and both
// insert; the second insert then hit notification_prefs_user_event_channel_unique
// and PUT /api/me/notification-prefs answered 500 (seen in the bdd-live lane).
// The per-user advisory lock serialises them. Real Postgres.

import { afterAll, describe, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, notificationPrefs } from '../../../src/db/client';
import { replaceNotificationPrefs } from '../../../src/domain/engagement/notification-prefs';
import { EXECUTION_EVENT_TYPES, NOTIFICATION_CHANNELS } from '../../../src/domain/engagement/event-types';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('notification-prefs-concurrent');

const USER = `prefs-race-${crypto.randomUUID()}`;
const EVENT = EXECUTION_EVENT_TYPES[0]!;

afterAll(async () => {
  await db.delete(notificationPrefs).where(eq(notificationPrefs.user_id, USER)).catch(() => {});
});

describe('replaceNotificationPrefs under concurrency', () => {
  itDb('overlapping replaces for one user all succeed and leave exactly one row per (event, channel)', async () => {
    const rows = NOTIFICATION_CHANNELS.map((channel) => ({ event_type: EVENT, channel, enabled: false }));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => replaceNotificationPrefs(USER, rows)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

    const stored = await db.select().from(notificationPrefs).where(eq(notificationPrefs.user_id, USER));
    expect(stored.length).toBe(NOTIFICATION_CHANNELS.length);
    expect(stored.every((r) => r.enabled === false)).toBe(true);
  });
});
