// assetScopeCapability.test.ts
//
// Unit-level pins for the three-state capability join used by
// /library/[type]. This suite proves the states themselves,
// including the branches the page cannot currently reach.

import { describe, it, expect } from 'vitest';
import {
  workspaceAdminCapability,
  deptManagerArm,
  anyOf,
  type Capability,
} from './assetScopeCapability';

const base = {
  loaded: true,
  error: undefined as string | undefined,
  activeRole: 'workspace-member' as string | undefined,
  claimRoles: [] as readonly string[] | undefined,
};

describe('workspaceAdminCapability', () => {
  // ⚔️ KILLED BY: `return 'permitted'` (the old `$derived(true)` in function
  // form) — the whole point of the module.
  // ⚔️ ALSO KILLED BY: treating a present-but-empty `claimRoles` as UNREAD, i.e.
  // `if (!i.claimRoles?.length) return 'unknown'`. `[]` is written out here
  // rather than inherited from `base` because that is the load-bearing half of
  // the pair with the `undefined` case below: an empty claims array is a
  // signed-in user whose realm roles were READ and hold no admin value, so it
  // is a genuine measurement and may earn a `denied`.
  it('denies a member whose role the backend actually returned', () => {
    expect(workspaceAdminCapability({ ...base, claimRoles: [] })).toBe(
      'denied',
    );
  });

  // ⚔️ KILLED BY: restoring the optional-chain fall-through
  // (`if (i.claimRoles?.some(...)) return 'permitted';` with nothing after it).
  // That expression is merely FALSY for `undefined`, so execution reached the DB
  // arm and — with `loaded: true`, no `error`, and a non-admin `activeRole` —
  // returned `denied` while the Keycloak claim arm had never been read at all.
  // `isWorkspaceAdminVia` (backend/src/services/user-roles.ts:284-296) checks
  // that claim FIRST and returns true with no DB round trip, so a claim-only
  // admin whose claims had not resolved was handed a known-false `denied`.
  // ⚔️ NOT killed by returning `unknown` unconditionally — that is what the
  // `claimRoles: []` assertion above exists to catch. The two must be read as a
  // pair; either one alone is satisfiable by a collapse of the other.
  it('is unknown — NOT denied — when the Keycloak claim arm was never read', () => {
    expect(
      workspaceAdminCapability({
        loaded: true,
        error: undefined,
        activeRole: 'workspace-member',
        claimRoles: undefined,
      }),
    ).toBe('unknown');
  });

  // ⚔️ KILLED BY: inverting or hardcoding the gate to 'denied'.
  it('permits the workspace-admin grant', () => {
    expect(
      workspaceAdminCapability({ ...base, activeRole: 'workspace-admin' }),
    ).toBe('permitted');
  });

  // ⚔️ KILLED BY: dropping the legacy alias from ADMIN_ROLE_VALUES.
  // `isWorkspaceAdminVia` (backend user-roles.ts:294-295) still accepts it.
  it("permits the legacy 'admin' alias", () => {
    expect(workspaceAdminCapability({ ...base, activeRole: 'admin' })).toBe(
      'permitted',
    );
  });

  // ⚔️ KILLED BY: dropping 'admin' from ADMIN_ROLE_VALUES — and, unlike the
  // assertion above, by dropping it from the CLAIM arm specifically. The case
  // above reaches the alias through `activeRole` (the DB arm), so a mutation
  // that narrowed only the claim comparison would leave it green. The backend
  // reads the alias in BOTH places: `user.roles.includes('admin')` at
  // user-roles.ts:291 and the `hasRoleFn(..., 'admin')` fallback at :295.
  it("permits the legacy 'admin' alias when it arrives as a Keycloak claim", () => {
    expect(workspaceAdminCapability({ ...base, claimRoles: ['admin'] })).toBe(
      'permitted',
    );
  });

  // ⚔️ KILLED BY: defaulting a missing role to 'permitted' OR to 'denied'.
  // Both mutations flip this single assertion, in opposite directions.
  it('is unknown — not denied, not permitted — when the role never arrived', () => {
    expect(
      workspaceAdminCapability({
        loaded: false,
        error: undefined,
        activeRole: undefined,
        claimRoles: undefined,
      }),
    ).toBe('unknown');
  });

  // ⚔️ KILLED BY: ignoring `error`. A 503 on /api/me/workspaces is not a
  // verdict about the caller's role; reading it as one denies real admins.
  it('is unknown when the workspace read FAILED, even with a role in hand', () => {
    expect(
      workspaceAdminCapability({ ...base, error: 'workspaces fetch 503' }),
    ).toBe('unknown');
  });

  // ⚔️ KILLED BY: deleting the claim arm. `isWorkspaceAdminVia` checks the
  // Keycloak claim FIRST and returns without a DB round trip, so a
  // claim-carrying admin must not be gated behind the workspace list.
  // ⚔️ ALSO KILLED BY: ordering the new `claimRoles === undefined` guard BEFORE
  // the claim-permit check, or requiring `loaded` before consulting claims —
  // either would turn this present, decisive claim into `unknown`.
  it('permits on the Keycloak claim alone, before the list has loaded', () => {
    expect(
      workspaceAdminCapability({
        loaded: false,
        error: undefined,
        activeRole: undefined,
        claimRoles: ['workspace-admin'],
      }),
    ).toBe('permitted');
  });

  // ⚔️ KILLED BY: treating the synthetic roles as admin. accessible-tenants.ts
  // is explicit: "no synthetic value confers anything: every backend gate
  // reads `user_roles`". A super-admin browsing another workspace, or a user
  // on their own workspace row, is genuinely 403ed by promote.ts.
  it.each(['own_workspace', 'super_admin_scope'])(
    'denies the synthetic role %s, which confers nothing server-side',
    (role) => {
      expect(workspaceAdminCapability({ ...base, activeRole: role })).toBe(
        'denied',
      );
    },
  );
});

describe('deptManagerArm', () => {
  it.each([
    ['dept-admin', 'permitted'],
    ['dept-manager', 'permitted'],
  ])('permits %s', (role, want) => {
    expect(deptManagerArm(role)).toBe(want as Capability);
  });

  // ⚔️ KILLED BY: returning 'denied' for a missing/low dept role.
  // `auth.fetchDeptRoles()` catches a failed read and assigns `{}`, and `{}`
  // is ALSO the honest response for a user with zero memberships — so the
  // absence of a key is ambiguous at the client and cannot be a verdict.
  it.each(['dept-member', 'dept-viewer', undefined])(
    'is unknown, never denied, for %s',
    (role) => {
      expect(deptManagerArm(role)).toBe('unknown');
    },
  );
});

describe('anyOf', () => {
  // ⚔️ KILLED BY: an AND-shaped join. The backend predicates are ORs —
  // workspace-admin alone is sufficient in all four handlers.
  it('permits when any single arm permits', () => {
    expect(anyOf('denied', 'permitted')).toBe('permitted');
    expect(anyOf('unknown', 'permitted')).toBe('permitted');
  });

  // ⚔️ KILLED BY: collapsing unknown into denied (`arms.every(a => a !==
  // 'permitted')`). One unreadable arm cannot deny an OR.
  it('is unknown when one arm is denied and the other unreadable', () => {
    expect(anyOf('denied', 'unknown')).toBe('unknown');
  });

  // ⚔️ KILLED BY: collapsing unknown into permitted — which would reinstate
  // the original defect wherever an arm is unreadable.
  it('denies only when EVERY arm is known-false', () => {
    expect(anyOf('denied', 'denied')).toBe('denied');
  });
});
