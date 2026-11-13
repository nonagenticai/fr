// Plan 5 Stage 1.4 — resolveStreamChannels filter unit tests.
//
// Pure function over notification_channels JSONB. No DB needed — keeps
// the test fast + isolated from migration ordering.

import { test, expect, describe } from 'bun:test';

import { resolveStreamChannels } from '../../../../src/services/streams/repository';
import type { StreamNotificationChannel } from '../../../../src/db/schema';

const channels: StreamNotificationChannel[] = [
  { kind: 'teams', target: '+10000000001', on: ['design', 'release'] },
  { kind: 'email', target: 'channel-A', on: ['design', 'rollback'] },
  { kind: 'inapp', target: 'role:dept-manager', on: ['design', 'release', 'done'] },
];

describe('resolveStreamChannels', () => {
  test('returns only channels whose `on` array includes the event', () => {
    const got = resolveStreamChannels({ notification_channels: channels }, 'design');
    expect(got.map((c) => c.kind).sort()).toEqual(['email', 'inapp', 'teams']);
  });
  test('release picks teams + inapp', () => {
    const got = resolveStreamChannels({ notification_channels: channels }, 'release');
    expect(got.map((c) => c.kind).sort()).toEqual(['inapp', 'teams']);
  });
  test('rollback picks email only', () => {
    const got = resolveStreamChannels({ notification_channels: channels }, 'rollback');
    expect(got.map((c) => c.kind)).toEqual(['email']);
  });
  test('done picks inapp only', () => {
    const got = resolveStreamChannels({ notification_channels: channels }, 'done');
    expect(got.map((c) => c.kind).sort()).toEqual(['inapp']);
  });
  test('empty channels returns empty', () => {
    const got = resolveStreamChannels({ notification_channels: [] }, 'design');
    expect(got).toEqual([]);
  });
  test('handles missing notification_channels (legacy stream rows)', () => {
    const got = resolveStreamChannels(
      { notification_channels: undefined as unknown as StreamNotificationChannel[] },
      'design',
    );
    expect(got).toEqual([]);
  });
});
