// Regression for src/domain/engagement/channel-prefs.ts replacePrefs.
//
// replacePrefs must run its read + deletes + upserts in ONE transaction so a
// mid-batch failure (or a concurrent edit) can never leave a user's channel
// config half-applied — losing a Telegram/email pref silently drops their
// approval notifications. Before the fix the four statements ran unwrapped on
// the pooled db handle.
//
// DB-backed + skip-if-unreachable so CI's `bun test tests/unit/` gates it: the
// stub-db unit tests can't exercise transaction semantics, and tests/integration
// is not run in the gating job. Skip-guard + per-file cleanup scoping.

import { test, expect, beforeAll, beforeEach } from 'bun:test';
import { sql as drizzleSql } from 'drizzle-orm';
import { db, queryClient } from '../../../../src/db/client';
import {
  addPref,
  replacePrefs,
} from '../../../../src/domain/engagement/channel-prefs';

import { createDbSuite } from '../../../integration/helpers/db-suite';

const sql = queryClient;

// Distinct from any other suite's user-id set so concurrent runs don't trample.
const USER = 'channel-prefs-atomic-user';
const TEST_USER_IDS = [USER];

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM user_channel_prefs LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[channel-prefs-atomicity] DB not reachable, skipping. Start fr-postgres with the schema applied. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

beforeEach(async () => {
  if (!reachable) return;
  for (const uid of TEST_USER_IDS) {
    await db.execute(drizzleSql`DELETE FROM user_channel_prefs WHERE user_id = ${uid}`);
  }
});

const { itDb } = createDbSuite('channel-prefs-atomicity');

itDb('replacePrefs rolls back the whole batch when a row fails mid-transaction', async () => {
  // KEEP row (updated in place) + DELETE row (dropped from the payload).
  const keep = await addPref(USER, { channel: 'telegram', address: 'keep-original' });
  await addPref(USER, { channel: 'teams', address: 'drop-me' });

  // Replace: update KEEP, drop the teams row (omitted), and add a NEW row whose
  // NULL address trips `address NOT NULL` — AFTER the delete + update have run.
  // Pre-fix (no transaction) the delete + update persist; post-fix the whole
  // transaction rolls back.
  await expect(
    replacePrefs(USER, [
      { id: keep.id, channel: 'telegram', address: 'keep-updated' },
      { channel: 'email', address: null as unknown as string },
    ]),
  ).rejects.toThrow();

  // Table must be byte-for-byte unchanged.
  const rows = await sql<{ channel: string; address: string }[]>`
    SELECT channel, address FROM user_channel_prefs WHERE user_id = ${USER} ORDER BY channel
  `;
  expect(rows.length).toBe(2);
  const byChannel = new Map(rows.map((r) => [r.channel, r.address]));
  expect(byChannel.get('telegram')).toBe('keep-original'); // update rolled back
  expect(byChannel.get('teams')).toBe('drop-me');        // delete rolled back
  expect(byChannel.has('email')).toBe(false);            // failed insert rolled back
});

itDb('replacePrefs still applies a valid replace-all (semantics unchanged)', async () => {
  const keep = await addPref(USER, { channel: 'telegram', address: 'a' });
  await addPref(USER, { channel: 'teams', address: 'b' });

  const after = await replacePrefs(USER, [
    { id: keep.id, channel: 'telegram', address: 'a-updated', enabled: true },
    { channel: 'email', address: 'c@x' },
  ]);

  expect(after.length).toBe(2);
  expect(after.some((p) => p.channel === 'email')).toBe(true);
  expect(after.some((p) => p.channel === 'teams')).toBe(false);
  expect(after.find((p) => p.id === keep.id)?.address).toBe('a-updated');

  // Cross-check via direct DB query — the deleted teams row actually left.
  const rows = await sql<{ channel: string }[]>`
    SELECT channel FROM user_channel_prefs WHERE user_id = ${USER} ORDER BY channel
  `;
  expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
});
