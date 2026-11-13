// tests/unit/routes/channels-shared.test.ts
//
// Pure-unit coverage for the shared channel create schema that both the
// human route (routes/channels.ts) and the n8n internal-create route
// (routes/assets/internal-create.ts) parse against.

import { describe, expect, test } from 'bun:test';

import { ChannelCreateSchema, ChannelKindEnum } from '../../../src/routes/channels-shared';

describe('channels-shared', () => {
  test('ChannelKindEnum lists the five channel kinds', () => {
    expect(ChannelKindEnum.options).toEqual([
      'teams',
      'email',
      'web',
      'inapp',
      'voice',
    ]);
  });

  test('parses a minimal valid body', () => {
    const parsed = ChannelCreateSchema.parse({ kind: 'web', name: 'hook' });
    expect(parsed.kind).toBe('web');
    expect(parsed.name).toBe('hook');
  });

  test('strips unknown keys (e.g. tenant_id is human-route-only)', () => {
    const parsed = ChannelCreateSchema.parse({
      kind: 'email',
      name: 'inbox',
      tenant_id: '00000000-0000-4000-8000-000000000000',
    });
    expect((parsed as Record<string, unknown>).tenant_id).toBeUndefined();
  });

  test('rejects an unknown kind', () => {
    expect(() =>
      ChannelCreateSchema.parse({ kind: 'carrier-pigeon', name: 'x' }),
    ).toThrow();
  });

  test('rejects a missing/empty name', () => {
    expect(() => ChannelCreateSchema.parse({ kind: 'web' })).toThrow();
    expect(() => ChannelCreateSchema.parse({ kind: 'web', name: '' })).toThrow();
  });

  test('accepts optional dept_id, config, credentials', () => {
    const parsed = ChannelCreateSchema.parse({
      kind: 'teams',
      name: 'pager',
      dept_id: '11111111-1111-4111-8111-111111111111',
      config: { phone: '+1' },
      credentials: 'tok',
    });
    expect(parsed.dept_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed.config).toEqual({ phone: '+1' });
    expect(parsed.credentials).toBe('tok');
  });
});
