import { describe, expect, test } from 'bun:test';
import {
  getTenantId,
  getUserId,
  getBearerToken,
  getCorrelationId,
  getProjectId,
  setProjectId,
  withRequestContext,
} from '../../../../src/integrations/_lib/context';

describe('AsyncLocalStorage accessors', () => {
  test('getUserId returns the userId seeded by withRequestContext', async () => {
    let observed: string | undefined;
    await withRequestContext(
      {
        correlationId: 'cid-1',
        initiator: 'human',
        channel: 'web',
        tenantId: 'tenant-abc',
        userId: 'user-uuid-123',
      },
      async () => {
        observed = getUserId();
      },
    );
    expect(observed).toBe('user-uuid-123');
  });

  test('getUserId is undefined when no ALS frame is active', () => {
    expect(getUserId()).toBeUndefined();
  });

  test('getUserId is undefined inside a frame that did not seed userId', async () => {
    let observed: string | undefined = 'sentinel';
    await withRequestContext(
      {
        correlationId: 'cid-2',
        initiator: 'human',
        channel: 'web',
        tenantId: 'tenant-only',
      },
      async () => {
        observed = getUserId();
      },
    );
    expect(observed).toBeUndefined();
  });

  test('getUserId, getTenantId, getBearerToken, getCorrelationId all read from the same frame', async () => {
    const snapshot: Record<string, string | undefined> = {};
    await withRequestContext(
      {
        correlationId: 'cid-3',
        initiator: 'agent',
        channel: 'telegram',
        bearerToken: 'tok',
        tenantId: 'tenant-xyz',
        userId: 'user-456',
      },
      async () => {
        snapshot.cid = getCorrelationId();
        snapshot.tenant = getTenantId();
        snapshot.user = getUserId();
        snapshot.bearer = getBearerToken();
      },
    );
    expect(snapshot.cid).toBe('cid-3');
    expect(snapshot.tenant).toBe('tenant-xyz');
    expect(snapshot.user).toBe('user-456');
    expect(snapshot.bearer).toBe('tok');
  });

  test('parallel frames do not leak userId into each other', async () => {
    const observed: Array<{ expected: string; actual: string | undefined }> = [];
    await Promise.all(
      ['u-a', 'u-b', 'u-c', 'u-d'].map((userId) =>
        withRequestContext(
          {
            correlationId: `cid-${userId}`,
            initiator: 'human',
            channel: 'web',
            userId,
          },
          async () => {
            await new Promise((r) => setTimeout(r, Math.random() * 5));
            observed.push({ expected: userId, actual: getUserId() });
          },
        ),
      ),
    );
    for (const { expected, actual } of observed) {
      expect(actual).toBe(expected);
    }
  });
});

describe('setProjectId / getProjectId', () => {
  test('setProjectId publishes a value that getProjectId then reads', async () => {
    let observed: string | undefined;
    await withRequestContext(
      { correlationId: 'cid-p1', initiator: 'human', channel: 'web' },
      async () => {
        setProjectId('proj-1');
        observed = getProjectId();
      },
    );
    expect(observed).toBe('proj-1');
  });

  test('FILL-IF-EMPTY: a second setProjectId call does not overwrite the first', async () => {
    let observed: string | undefined;
    await withRequestContext(
      { correlationId: 'cid-p2', initiator: 'human', channel: 'web' },
      async () => {
        setProjectId('first-resolver');
        setProjectId('second-unrelated-lookup');
        observed = getProjectId();
      },
    );
    expect(observed).toBe('first-resolver');
  });

  test('setProjectId(undefined) is a no-op', async () => {
    let observed: string | undefined;
    await withRequestContext(
      { correlationId: 'cid-p3', initiator: 'human', channel: 'web' },
      async () => {
        setProjectId(undefined);
        observed = getProjectId();
      },
    );
    expect(observed).toBeUndefined();
  });

  test('setProjectId outside an ALS frame does not throw', () => {
    expect(() => setProjectId('proj-x')).not.toThrow();
  });

  test('getProjectId is undefined when no ALS frame is active', () => {
    expect(getProjectId()).toBeUndefined();
  });
});
