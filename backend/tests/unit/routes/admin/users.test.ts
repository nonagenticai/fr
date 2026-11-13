// tests/unit/routes/admin/users.test.ts
//
// fr could not answer "who has access, and where?". Keycloak's search needs
// >=2 characters and cannot enumerate, so the only path to a person was a
// typeahead inside the grants form. Eleven people hold `workspace-admin` in
// production and nothing listed them.
//
// Pure grouping only — no DB, no Keycloak.

import { test, expect, describe } from 'bun:test';
import { groupGrantsByUser } from '../../../../src/routes/admin/users';
import type { RoleGrant } from '../../../../src/services/user-roles';

const grant = (p: Partial<RoleGrant>): RoleGrant => ({
  user_id: 'u1',
  tenant_id: 't1',
  tenant_name: 'Acme',
  role: 'workspace-admin',
  granted_at: '2026-01-01T00:00:00.000Z',
  granted_by: 'admin',
  ...p,
});

const person = (id: string, email: string, name: string) => ({ id, email, name });

describe('groupGrantsByUser', () => {
  test('folds several workspaces into one person', () => {
    const out = groupGrantsByUser(
      [
        grant({ user_id: 'u1', tenant_id: 't1', tenant_name: 'Acme' }),
        grant({ user_id: 'u1', tenant_id: 't2', tenant_name: 'Beta' }),
      ],
      { u1: person('u1', 'a@x.com', 'A') },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.workspaces.map((w) => w.tenant_name)).toEqual(['Acme', 'Beta']);
  });

  test('keeps the SAME person distinct per workspace role', () => {
    // The case a realm-wide role cannot express: admin here, member there.
    const out = groupGrantsByUser(
      [
        grant({ tenant_id: 't1', tenant_name: 'Acme', role: 'workspace-admin' }),
        grant({ tenant_id: 't2', tenant_name: 'Beta', role: 'workspace-member' }),
      ],
      { u1: person('u1', 'a@x.com', 'A') },
    );
    expect(out[0]!.workspaces.map((w) => w.role)).toEqual([
      'workspace-admin',
      'workspace-member',
    ]);
  });

  test('a grant Keycloak cannot resolve is LISTED, not dropped', () => {
    // A dangling grant (deleted account, wrong realm) is real access that
    // still passes the backend gate. Hiding it would hide access.
    const out = groupGrantsByUser([grant({ user_id: 'ghost' })], {});
    expect(out).toHaveLength(1);
    expect(out[0]!.resolved).toBe(false);
    expect(out[0]!.email).toBeNull();
    expect(out[0]!.user_id).toBe('ghost');
  });

  test('unresolved rows sort last so they do not bury the readable list', () => {
    const out = groupGrantsByUser(
      [grant({ user_id: 'ghost' }), grant({ user_id: 'u1' })],
      { u1: person('u1', 'a@x.com', 'A') },
    );
    expect(out.map((u) => u.user_id)).toEqual(['u1', 'ghost']);
  });

  test('people are ordered by email so the list is stable between reads', () => {
    const out = groupGrantsByUser(
      [grant({ user_id: 'b' }), grant({ user_id: 'a' })],
      { a: person('a', 'zeta@x.com', 'Z'), b: person('b', 'alpha@x.com', 'A') },
    );
    expect(out.map((u) => u.email)).toEqual(['alpha@x.com', 'zeta@x.com']);
  });

  test('workspaces are ordered by name, not by insertion', () => {
    const out = groupGrantsByUser(
      [
        grant({ tenant_id: 't1', tenant_name: 'Zulu' }),
        grant({ tenant_id: 't2', tenant_name: 'Alpha' }),
      ],
      { u1: person('u1', 'a@x.com', 'A') },
    );
    expect(out[0]!.workspaces.map((w) => w.tenant_name)).toEqual(['Alpha', 'Zulu']);
  });

  test('a null tenant_name falls back to the id rather than sorting as empty', () => {
    // Legacy rows and the bootstrap tenant carry no name; they must still order
    // deterministically instead of clustering at the top as ''.
    const out = groupGrantsByUser(
      [
        grant({ tenant_id: 'ffff', tenant_name: null }),
        grant({ tenant_id: 'aaaa', tenant_name: null }),
      ],
      { u1: person('u1', 'a@x.com', 'A') },
    );
    expect(out[0]!.workspaces.map((w) => w.tenant_id)).toEqual(['aaaa', 'ffff']);
  });

  test('no grants is an empty list, not a fabricated row', () => {
    expect(groupGrantsByUser([], {})).toEqual([]);
  });

  test('a resolved person with no email still sorts by name', () => {
    const out = groupGrantsByUser(
      [grant({ user_id: 'u1' }), grant({ user_id: 'u2' })],
      {
        u1: { id: 'u1', email: null, name: 'Zed' },
        u2: { id: 'u2', email: null, name: 'Ann' },
      },
    );
    expect(out.map((u) => u.name)).toEqual(['Ann', 'Zed']);
  });
});
