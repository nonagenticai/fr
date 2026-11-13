// Integration test for E-13 agent-core session-refresh wrapper.
//
// Requires the local fr-postgres container (docker compose ... up -d) with
// migration 013 applied. Skips gracefully if the service's DB isn't reachable.

// AGENT_SESSION_SIGNING_KEY must be set BEFORE the session-refresh module is
// imported, because signingKey() is read lazily but the test that signs an
// access token in `issueSession` will fail closed without it. Setting it via
// `??=` here keeps prod boot-time validation intact (production does NOT
// import this test file).
process.env.AGENT_SESSION_SIGNING_KEY ??=
  'test-only-signing-key-must-be-thirty-two-chars';

import {
  test,
  expect,
  describe,
  beforeAll,
  beforeEach,
} from 'bun:test';
import { sql } from 'drizzle-orm';
import { db, queryClient } from '../../../src/db/client';
import {
  issueSession,
  refreshSession,
  revokeSession,
  validateAccessToken,
} from '../../../src/agent-core/session-refresh';
import { findById } from '../../../src/agent-core/session-store';

import { createDbSuite } from '../helpers/db-suite';

let reachable = false;

beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM agent_sessions LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[session-refresh.integration] DB not reachable, skipping. Start fr-postgres with migration 013 applied. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

beforeEach(async () => {
  if (reachable) {
    await db.execute(
      sql`DELETE FROM agent_sessions WHERE user_id LIKE 'test-%'`,
    );
  }
});

const { itDb } = createDbSuite('session-refresh');

describe('agent session refresh', () => {
  itDb('issues a new session and returns raw refresh + access tokens', async () => {
    const result = await issueSession({ userId: 'test-user-1', ttlSeconds: 3600 });
    expect(result.refreshToken).toMatch(/^[a-f0-9]{64}$/); // 256-bit hex
    expect(typeof result.accessToken).toBe('string');
    expect(result.accessToken.length).toBeGreaterThan(0);
    expect(typeof result.sessionId).toBe('string');
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  itDb('refreshes a session: rotates the refresh token, marks old as replaced_by', async () => {
    const a = await issueSession({ userId: 'test-user-2' });
    const b = await refreshSession(a.refreshToken);
    expect(b.refreshToken).not.toBe(a.refreshToken);
    expect(b.sessionId).not.toBe(a.sessionId);
    const old = await db.execute(
      sql`SELECT replaced_by FROM agent_sessions WHERE id = ${a.sessionId}`,
    );
    const rows = old as unknown as Array<{ replaced_by: string | null }>;
    expect(rows[0]?.replaced_by).toBe(b.sessionId);
  });

  itDb('rejects refresh of a replaced (replayed) token', async () => {
    const a = await issueSession({ userId: 'test-user-3' });
    await refreshSession(a.refreshToken);
    await expect(refreshSession(a.refreshToken)).rejects.toThrow(
      /replayed|already used/i,
    );
  });

  itDb('rejects refresh of a revoked session', async () => {
    const a = await issueSession({ userId: 'test-user-4' });
    await revokeSession(a.sessionId);
    await expect(refreshSession(a.refreshToken)).rejects.toThrow(/revoked/i);
  });

  itDb('rejects refresh of an expired session', async () => {
    const a = await issueSession({ userId: 'test-user-5', ttlSeconds: -1 });
    await expect(refreshSession(a.refreshToken)).rejects.toThrow(/expired/i);
  });

  itDb('validateAccessToken returns userId for a valid JWT', async () => {
    const a = await issueSession({ userId: 'test-user-6' });
    const claims = await validateAccessToken(a.accessToken);
    expect(claims.userId).toBe('test-user-6');
    expect(claims.sessionId).toBe(a.sessionId);
  });

  itDb('validateAccessToken rejects forged JWT', async () => {
    await expect(validateAccessToken('not.a.jwt')).rejects.toThrow();
  });

  itDb('revokeSession is idempotent', async () => {
    const a = await issueSession({ userId: 'test-user-7' });
    // Precondition: a freshly issued session is NOT revoked. Without this the
    // "revoked after the first call" assertion below could pass on a session
    // that was born revoked.
    const before = await findById(a.sessionId);
    expect(before?.revoked_at).toBeNull();

    await revokeSession(a.sessionId);
    const afterFirst = await findById(a.sessionId);
    expect(afterFirst?.revoked_at).toBeInstanceOf(Date);

    await revokeSession(a.sessionId);
    const afterSecond = await findById(a.sessionId);
    // Idempotent means the state is IDENTICAL, not merely "still revoked":
    // markRevoked()'s `isNull(revoked_at)` guard is the thing under test, and
    // dropping it would re-stamp revoked_at to a later instant — silently
    // extending an audit timestamp that operators read as "when was this
    // session killed".
    expect(afterSecond?.revoked_at).toBeInstanceOf(Date);
    expect(afterSecond!.revoked_at!.getTime()).toBe(
      afterFirst!.revoked_at!.getTime(),
    );
    // No resurrection / no duplicate row: revoking twice must not leave the
    // user with a second, live session row.
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM agent_sessions WHERE user_id = 'test-user-7'`,
    )) as unknown as Array<{ c: number }>;
    expect(rows[0]?.c).toBe(1);
    // And the revocation is still ENFORCED after the second call.
    await expect(refreshSession(a.refreshToken)).rejects.toThrow(/revoked/i);
  });
});
