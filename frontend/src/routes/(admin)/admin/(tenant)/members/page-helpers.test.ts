import { describe, it, expect } from 'vitest';
import {
  memberLabel,
  roleInWorkspace,
  isAdminRow,
  canRevokeAdmin,
  filterMembers,
  toggledRole,
  isRealmManagedAdmin,
  isRealmLockedAdmin,
  NIL_UUID,
} from './page-helpers';
// `shortId` is no longer defined here — fr#1205 retired this file's private
// copy in favour of the shared helper.
import { shortId } from '$lib/utils/shortId';
import type { WorkspaceMember } from '$lib/api/workspaceMembers';

function member(p: Partial<WorkspaceMember> = {}): WorkspaceMember {
  return {
    user_id: '11111111-2222-3333-4444-555555555555',
    email: null,
    name: null,
    resolved: true,
    workspaces: [
      {
        tenant_id: 'aaaaaaaa-0000-0000-0000-000000000001',
        tenant_name: 'acme',
        role: 'workspace-member',
        granted_at: '2026-08-01T00:00:00Z',
        granted_by: null,
      },
    ],
    ...p,
  };
}

describe('memberLabel never leaks a raw UUID', () => {
  it('prefers email, then name', () => {
    expect(memberLabel(member({ email: 'a@b.test', name: 'Ada' }))).toBe('a@b.test');
    expect(memberLabel(member({ email: null, name: 'Ada' }))).toBe('Ada');
  });

  it('a resolved member with no profile shows a SHORT id, not the full uuid', () => {
    const m = member();
    const label = memberLabel(m);
    expect(label).toBe(shortId(m.user_id));
    // ...spelled out, because `toBe(shortId(...))` alone is self-referential and
    // would pass under ANY derivation, including the leading-8 one fr#1203
    // refuted. The stub is the TAIL 8 of '11111111-2222-3333-4444-555555555555'.
    expect(label).toBe('…55555555');
    expect(label).not.toBe(m.user_id);
    expect(label.length).toBeLessThan(m.user_id.length);
  });

  it('an unresolved grant reads as a deleted account, not as a person', () => {
    const m = member({ resolved: false });
    const label = memberLabel(m);
    expect(label).toContain('Deleted account');
    // The whole point: the raw id must not stand where a name belongs.
    expect(label).not.toBe(m.user_id);
  });

  it('the nil UUID is named as the dev artifact it is', () => {
    // Measured in production: written by a demo seeder that no longer exists.
    // Calling it a "deleted account" would send an operator hunting for a
    // person who was never real.
    expect(memberLabel(member({ user_id: NIL_UUID, resolved: false }))).toBe(
      'Seed artifact (dev placeholder)',
    );
  });
});

describe('roleInWorkspace', () => {
  const withRole = (role: string) =>
    member({ workspaces: [{ ...member().workspaces[0], role }] });

  it('reports the granted role', () => {
    expect(roleInWorkspace(withRole('workspace-member'))).toBe('workspace-member');
    expect(roleInWorkspace(withRole('workspace-admin'))).toBe('workspace-admin');
  });

  it("maps the legacy 'admin' alias onto what it actually grants", () => {
    // The backend still READS 'admin' as workspace-admin. Showing the raw
    // value would invent a third role name for the operator.
    expect(roleInWorkspace(withRole('admin'))).toBe('workspace-admin');
    expect(isAdminRow(withRole('admin'))).toBe(true);
  });

  it('admin wins when a member somehow holds both', () => {
    const m = member({
      workspaces: [
        { ...member().workspaces[0], role: 'workspace-member' },
        { ...member().workspaces[0], role: 'workspace-admin' },
      ],
    });
    expect(roleInWorkspace(m)).toBe('workspace-admin');
  });

  it('returns null for a member with no grant rows', () => {
    expect(roleInWorkspace(member({ workspaces: [] }))).toBeNull();
  });
});

describe('canRevokeAdmin protects the last admin', () => {
  const admin = (id: string) =>
    member({ user_id: id, workspaces: [{ ...member().workspaces[0], role: 'workspace-admin' }] });

  it('refuses when exactly one admin remains', () => {
    // The server answers 409; disabling the control says so BEFORE the click.
    expect(canRevokeAdmin([admin('a'), member({ user_id: 'b' })])).toBe(false);
  });

  it('allows when a second admin exists', () => {
    expect(canRevokeAdmin([admin('a'), admin('b')])).toBe(true);
  });

  it('refuses on an empty list rather than throwing', () => {
    expect(canRevokeAdmin([])).toBe(false);
  });

  it('counts the legacy alias as an admin', () => {
    // Otherwise a workspace whose only admin holds the legacy row looks
    // admin-less, and the UI happily strands it.
    const legacy = member({
      user_id: 'legacy',
      workspaces: [{ ...member().workspaces[0], role: 'admin' }],
    });
    expect(canRevokeAdmin([legacy, admin('a')])).toBe(true);
    expect(canRevokeAdmin([legacy])).toBe(false);
  });
});

describe('toggledRole', () => {
  it('promotes a member and demotes an admin', () => {
    expect(toggledRole(member())).toBe('workspace-admin');
    expect(
      toggledRole(member({ workspaces: [{ ...member().workspaces[0], role: 'workspace-admin' }] })),
    ).toBe('workspace-member');
  });
});

describe('filterMembers', () => {
  const ada = member({ user_id: 'id-ada', email: 'ada@x.test', name: 'Ada' });
  const bob = member({
    user_id: 'id-bob',
    email: 'bob@y.test',
    name: 'Bob',
    workspaces: [{ ...member().workspaces[0], role: 'workspace-admin' }],
  });

  it('returns everything for an empty query', () => {
    expect(filterMembers([ada, bob], '   ')).toHaveLength(2);
  });

  it('matches email, name and id', () => {
    expect(filterMembers([ada, bob], 'ada')).toEqual([ada]);
    expect(filterMembers([ada, bob], 'Bob')).toEqual([bob]);
    expect(filterMembers([ada, bob], 'id-bob')).toEqual([bob]);
  });

  it('matches on role, so "admin" finds the admins', () => {
    expect(filterMembers([ada, bob], 'workspace-admin')).toEqual([bob]);
  });
});

describe('isRealmManagedAdmin (fr#1289)', () => {
  it('is true only for keycloak / both', () => {
    expect(isRealmManagedAdmin(member({ admin_source: 'keycloak' }))).toBe(true);
    expect(isRealmManagedAdmin(member({ admin_source: 'both' }))).toBe(true);
    // Control: a DB-only admin and a row with no source stay manageable here.
    expect(isRealmManagedAdmin(member({ admin_source: 'db' }))).toBe(false);
    expect(isRealmManagedAdmin(member())).toBe(false);
  });
});

describe('isRealmLockedAdmin (fr#1289 part B)', () => {
  it('locks keycloak / both admins while realm_admin_revocable is false', () => {
    expect(isRealmLockedAdmin(member({ admin_source: 'keycloak' }), false)).toBe(true);
    expect(isRealmLockedAdmin(member({ admin_source: 'both' }), false)).toBe(true);
  });
  it('unlocks them once fr can write the realm role', () => {
    expect(isRealmLockedAdmin(member({ admin_source: 'keycloak' }), true)).toBe(false);
    expect(isRealmLockedAdmin(member({ admin_source: 'both' }), true)).toBe(false);
  });
  it('never locks a DB-only admin (control)', () => {
    expect(isRealmLockedAdmin(member({ admin_source: 'db' }), false)).toBe(false);
    expect(isRealmLockedAdmin(member(), false)).toBe(false);
  });
});
