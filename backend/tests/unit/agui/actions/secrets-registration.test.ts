/**
 * AG-UI secrets.* registration shape — metadata-only surface.
 *
 * Key invariant: secrets.get is NOT registered, because
 * `SecretRetrieveResponse` exposes plaintext values. Only `secrets.list`
 * (metadata) ships, and it requires tenant-role:admin.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerSecretsActions } from '../../../../src/agui/actions/secrets';

beforeAll(() => {
  registerSecretsActions();
});

describe('secrets.* AG-UI registration shape', () => {
  test('only secrets.list is registered (no secrets.get — would leak plaintext)', () => {
    const names = listActions()
      .filter((a) => a.name.startsWith('secrets.'))
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(['secrets.list']);
  });

  test('secrets.list is read-kind with auto approval', () => {
    const action = listActions().find((a) => a.name === 'secrets.list');
    expect(action).toBeDefined();
    expect(action!.kind).toBe('read');
    expect(action!.approval.type).toBe('auto');
  });

  test('secrets.list requires tenant-role:admin (cannot be `public`)', () => {
    const action = listActions().find((a) => a.name === 'secrets.list');
    expect(action!.rbac).toBeDefined();
    expect(action!.rbac).toEqual({ type: 'tenant-role', role: 'admin' });
  });

  test('description mentions metadata-only / no plaintext', () => {
    const action = listActions().find((a) => a.name === 'secrets.list');
    expect(action!.description).toMatch(/METADATA ONLY|plaintext/i);
  });
});
