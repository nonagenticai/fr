// Integration tests for src/domain/engagement/channel-prefs.ts.
//
// Phase 2 / Bucket C — converted from tests/unit/domain/engagement/channel-prefs.test.ts.
// The unit version stubbed `mock.module('drizzle-orm', ...)` + `mock.module('db/client', ...)`
// with a hand-rolled in-memory fake; assertions on `{__op:'eq'}` sentinels
// proved nothing about real query behavior. This integration version drives
// the same domain functions against a real CI Postgres so the SQL is
// actually executed.
//
// Skip-if-unreachable: mirrors the idempotency.integration pattern.
// DATABASE_URL must point at a Postgres with migration 008 applied.
// Cleanup is bounded to the user-id set this file owns — never `LIKE 'test-%'`.

import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { sql as drizzleSql } from 'drizzle-orm';
import { db, queryClient } from '../../../../src/db/client';
import {
  addPref,
  deletePref,
  findLinkedTenant,
  getPrefsForUser,
  resolveRecipients,
  replacePrefs,
} from '../../../../src/domain/engagement/channel-prefs';

import { config } from '../../../../src/config';
import { classifyRosterMember, pushChannelsFor } from '../../../../src/domain/engagement/approval-routing';
import { createDbSuite } from '../../helpers/db-suite';

const sql = queryClient;

// user_id is a TEXT column — keep these distinct from any other integration
// suite's set so concurrent test runs don't trample each other.
const USER_A = 'channel-prefs-int-user-a';
const USER_B = 'channel-prefs-int-user-b';
const TEST_USER_IDS = [USER_A, USER_B];

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM user_channel_prefs LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[channel-prefs.integration] DB not reachable, skipping. Start fr-postgres with migration 008 applied. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

beforeEach(async () => {
  if (!reachable) return;
  for (const uid of TEST_USER_IDS) {
    await db.execute(
      drizzleSql`DELETE FROM user_channel_prefs WHERE user_id = ${uid}`,
    );
  }
});

const { itDb } = createDbSuite('channel-prefs');

describe('channel-prefs service (integration)', () => {
  itDb('addPref + getPrefsForUser round-trip', async () => {
    await addPref(USER_A, { channel: 'telegram', address: '+15551234', is_default: true });
    await addPref(USER_A, { channel: 'teams', address: 'https://teams/hook' });
    await addPref(USER_B, { channel: 'telegram', address: '+15550000' });

    const prefs = await getPrefsForUser(USER_A);
    expect(prefs.length).toBe(2);
    expect(prefs.every((p) => p.user_id === USER_A)).toBe(true);
    // Defaults first, then newest first — assert ordering against real
    // index, not against a stub's insertion order.
    expect(prefs[0]!.is_default).toBe(true);
    expect(prefs[0]!.channel).toBe('telegram');
  });

  itDb("deletePref only removes the owner's row", async () => {
    await addPref(USER_A, { channel: 'telegram', address: 'a' });
    await addPref(USER_B, { channel: 'telegram', address: 'b' });
    const [a] = await getPrefsForUser(USER_A);
    expect(a).toBeDefined();

    const ok = await deletePref(USER_B, a!.id); // wrong owner
    expect(ok).toBe(false);
    const stillThere = await getPrefsForUser(USER_A);
    expect(stillThere.length).toBe(1);

    const ok2 = await deletePref(USER_A, a!.id);
    expect(ok2).toBe(true);
    const after = await getPrefsForUser(USER_A);
    expect(after.length).toBe(0);
  });

  itDb('resolveRecipients returns enabled channels only', async () => {
    await addPref(USER_A, { channel: 'telegram', address: '+1', enabled: true });
    await addPref(USER_A, { channel: 'teams', address: 'https://hook', enabled: false });
    await addPref(USER_A, { channel: 'websocket', address: 'broadcast', enabled: true });

    const recs = await resolveRecipients(USER_A);
    expect(recs.length).toBe(2);
    expect(recs.map((r) => r.channel).sort()).toEqual(['telegram', 'websocket']);
  });

  itDb('replacePrefs deletes missing rows and inserts new ones', async () => {
    const p1 = await addPref(USER_A, { channel: 'telegram', address: 'a' });
    await addPref(USER_A, { channel: 'teams', address: 'b' });

    // Keep only p1 (by id, with updated address) and add a new email pref.
    // The teams row must be deleted.
    const after = await replacePrefs(USER_A, [
      { id: p1.id, channel: 'telegram', address: 'a-updated', enabled: true },
      { channel: 'email', address: 'a@x' },
    ]);

    expect(after.length).toBe(2);
    expect(after.some((p) => p.channel === 'email')).toBe(true);
    expect(after.some((p) => p.channel === 'teams')).toBe(false);
    const updated = after.find((p) => p.id === p1.id);
    expect(updated?.address).toBe('a-updated');

    // Cross-check via direct DB query — the in-memory fake never validated
    // that the deleted row actually left the table.
    const remainingRows = await sql<{ channel: string }[]>`
      SELECT channel FROM user_channel_prefs WHERE user_id = ${USER_A} ORDER BY channel
    `;
    expect(remainingRows.map((r) => r.channel).sort()).toEqual(['email', 'telegram']);
  });

  itDb('a link pinned to a workspace: findLinkedTenant returns it, fan-out for another workspace skips it', async () => {
    await addPref(USER_B, { channel: 'mcp', address: 'care-bus:t1:b', tenant_id: 'tenant-1' });
    await addPref(USER_B, { channel: 'telegram', address: '42' });

    expect(await findLinkedTenant('mcp', 'care-bus:t1:b', USER_B)).toBe('tenant-1');
    expect(await findLinkedTenant('telegram', '42', USER_B)).toBeNull();
    // Another user's view of the same address is not this user's link.
    expect(await findLinkedTenant('mcp', 'care-bus:t1:b', USER_A)).toBeNull();

    const forT1 = (await resolveRecipients(USER_B, 'tenant-1')).map((r) => r.channel).sort();
    const forT2 = (await resolveRecipients(USER_B, 'tenant-2')).map((r) => r.channel).sort();
    expect(forT1).toEqual(['mcp', 'telegram']);
    expect(forT2).toEqual(['telegram']);
    expect((await resolveRecipients(USER_B)).length).toBe(2);
  });

  itDb('the same address linked for two workspaces is ambiguous (null), never a pick', async () => {
    await addPref(USER_B, { channel: 'mcp', address: 'dup', tenant_id: 'tenant-1' });
    await addPref(USER_B, { channel: 'mcp', address: 'dup', tenant_id: 'tenant-2' });
    expect(await findLinkedTenant('mcp', 'dup', USER_B)).toBeNull();
  });

  itDb('replacePrefs keeps a row\'s tenant_id', async () => {
    const p1 = await addPref(USER_A, { channel: 'mcp', address: 'x', tenant_id: 'tenant-1' });
    const after = await replacePrefs(USER_A, [{ id: p1.id, channel: 'mcp', address: 'x', tenant_id: 'tenant-1', enabled: false }]);
    expect(after[0]?.tenant_id).toBe('tenant-1');
  });

  itDb('approver routing: a link pinned to another workspace does not make the user reachable here', async () => {
    await addPref(USER_A, { channel: 'telegram', address: '4242', tenant_id: 'tenant-1' });
    expect(await pushChannelsFor(USER_A, 'tenant-1')).toEqual(['telegram']);
    expect(await pushChannelsFor(USER_A, 'tenant-2')).toEqual([]);
    expect((await classifyRosterMember(USER_A, 'tenant-2')).verdict).not.toBe('push');
    expect((await classifyRosterMember(USER_A, 'tenant-1')).verdict).toBe('push');
  });

  itDb('approver routing: an mcp link counts as reachable only once fr can deliver to it', async () => {
    const mcp = config.services.mcp as { eventsUrl: string; secret: string };
    const saved = { ...mcp };
    try {
      await addPref(USER_A, { channel: 'mcp', address: 'care-bus:t1:a' });
      Object.assign(mcp, { eventsUrl: '', secret: '' });
      expect(await pushChannelsFor(USER_A, 'tenant-1')).toEqual([]);
      Object.assign(mcp, { eventsUrl: 'https://mcp.test/api/channels/fr/events', secret: 's' });
      expect(await pushChannelsFor(USER_A, 'tenant-1')).toEqual(['mcp']);
    } finally {
      Object.assign(mcp, saved);
    }
  });
});
