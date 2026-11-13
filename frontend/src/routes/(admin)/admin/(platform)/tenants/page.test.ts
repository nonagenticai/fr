// Pure-logic tests for /admin/tenants. No component render — these run in the
// vitest `node` environment alongside the other page-helpers suites.
//
// The assertions that earn their place are the ones about MEANING: the archive
// confirm has to say that nothing is revoked, and the rename confirm has to say
// the name is an identifier. Both are the only warning an operator gets.

import { describe, it, expect } from 'vitest';
import { LicensesAdminCallError, type TenantRecord } from '$lib/api/licenses-admin';
import {
  archivedCount,
  describeTenantArchive,
  describeTenantRename,
  isArchived,
  sortTenants,
  tenantDetailHref,
  tenantNameError,
  tenantNameTakenMessage,
  visibleTenants,
} from './page-helpers';

function tenant(p: Partial<TenantRecord> = {}): TenantRecord {
  return {
    id: 't1',
    name: 'acme',
    keycloak_realm: null,
    byo_mode: 'platform_only',
    created_at: null,
    archived_at: null,
    ...p,
  };
}

describe('isArchived', () => {
  it('a missing archived_at is LIVE, not archived', () => {
    // A licences deployment older than the archive migration omits the field
    // entirely. Reading `undefined` as archived would hide every tenant on
    // such a deployment and render an empty table that looks correct.
    const old = { ...tenant() } as TenantRecord;
    delete (old as { archived_at?: string | null }).archived_at;
    expect(isArchived(old)).toBe(false);
  });

  it('a timestamp is archived', () => {
    expect(isArchived(tenant({ archived_at: '2026-08-27T10:00:00Z' }))).toBe(true);
  });
});

describe('tenantNameError', () => {
  it('accepts the shape the edge can match', () => {
    expect(tenantNameError('acme')).toBeNull();
    expect(tenantNameError('acme-2')).toBeNull();
    expect(tenantNameError('9lives')).toBeNull();
  });

  it('rejects uppercase and underscores', () => {
    // licence-authz compares tenant names literally. `Acme` or `acme_corp`
    // would be accepted by a laxer client and then never match at the edge.
    expect(tenantNameError('Acme')).not.toBeNull();
    expect(tenantNameError('acme_corp')).not.toBeNull();
  });

  it('rejects a leading hyphen', () => {
    expect(tenantNameError('-acme')).not.toBeNull();
  });

  it('reports empty and whitespace-padded names differently', () => {
    // Different fixes: one is "type something", the other is "your paste has a
    // trailing space you cannot see".
    expect(tenantNameError('')).toBe('A name is required.');
    expect(tenantNameError('  ')).toBe('A name is required.');
    expect(tenantNameError(' acme ')).toContain('spaces');
  });

  it('rejects a name longer than the 255-char column', () => {
    expect(tenantNameError('a'.repeat(256))).toContain('255');
    expect(tenantNameError('a'.repeat(255))).toBeNull();
  });
});

describe('visibleTenants', () => {
  const rows = [
    tenant({ id: '1', name: 'acme' }),
    tenant({ id: '2', name: 'zeta', archived_at: '2026-01-01T00:00:00Z' }),
  ];

  it('hides archived tenants by default', () => {
    expect(visibleTenants(rows, { showArchived: false }).map((t) => t.name)).toEqual([
      'acme',
    ]);
  });

  it('shows them when asked, so a restore is reachable', () => {
    // Without this the flag would be a one-way door in the UI: archive it and
    // the only screen that could un-archive it no longer lists it.
    expect(visibleTenants(rows, { showArchived: true })).toHaveLength(2);
  });

  it('filters on name, id and realm', () => {
    const withRealm = [
      tenant({ id: 'aaa-111', name: 'acme', keycloak_realm: 'portal-realm' }),
      tenant({ id: 'bbb-222', name: 'beta', keycloak_realm: null }),
    ];
    expect(
      visibleTenants(withRealm, { showArchived: true, query: 'bbb' }).map((t) => t.name),
    ).toEqual(['beta']);
    expect(
      visibleTenants(withRealm, { showArchived: true, query: 'portal' }).map((t) => t.name),
    ).toEqual(['acme']);
  });

  it('a null realm does not throw the filter', () => {
    expect(
      visibleTenants([tenant({ keycloak_realm: null })], {
        showArchived: true,
        query: 'x',
      }),
    ).toEqual([]);
  });
});

describe('sortTenants', () => {
  it('puts live tenants above archived ones, each block alphabetical', () => {
    const sorted = sortTenants([
      tenant({ id: '1', name: 'zeta' }),
      tenant({ id: '2', name: 'beta', archived_at: '2026-01-01T00:00:00Z' }),
      tenant({ id: '3', name: 'acme' }),
    ]);
    expect(sorted.map((t) => t.name)).toEqual(['acme', 'zeta', 'beta']);
  });

  it('does not mutate its input', () => {
    const input = [tenant({ id: '1', name: 'zeta' }), tenant({ id: '2', name: 'acme' })];
    sortTenants(input);
    expect(input.map((t) => t.name)).toEqual(['zeta', 'acme']);
  });
});

describe('archivedCount', () => {
  it('counts only archived rows', () => {
    expect(
      archivedCount([
        tenant({ id: '1' }),
        tenant({ id: '2', archived_at: '2026-01-01T00:00:00Z' }),
      ]),
    ).toBe(1);
  });
});

describe('describeTenantArchive', () => {
  it('says outright that archiving revokes nothing', () => {
    // The whole reason this is a tested helper. An operator who believes
    // archive revokes access will use it as a kill switch that does not kill.
    const msg = describeTenantArchive(tenant({ name: 'acme' }));
    expect(msg).toContain('REVOKES NOTHING');
    expect(msg).toContain('keeps working');
    expect(msg).toContain('acme');
  });

  it('says what DOES change, so it does not read as a no-op either', () => {
    const msg = describeTenantArchive(tenant());
    expect(msg).toContain('pick-lists');
    expect(msg.toLowerCase()).toContain('do not provision');
  });

  it('says it is reversible', () => {
    // An operator who reads archive as "delete" simply never uses it, and the
    // pick-lists stay full of dead tenants — the problem this screen exists to
    // solve.
    expect(describeTenantArchive(tenant())).toContain('restore it at any time');
  });

  it('flips to restore wording for an already-archived tenant', () => {
    const msg = describeTenantArchive(
      tenant({ name: 'acme', archived_at: '2026-01-01T00:00:00Z' }),
    );
    expect(msg).toContain('Restore');
    expect(msg).not.toContain('Archive “acme”');
  });
});

describe('describeTenantRename', () => {
  it('shows both names', () => {
    const msg = describeTenantRename(tenant({ name: 'acme' }), 'acme-corp');
    expect(msg).toContain('acme');
    expect(msg).toContain('acme-corp');
  });

  it('warns that the name is an identifier', () => {
    // `/tenants/{name_or_id}` resolves by name and the edge compares names
    // literally, so a rename silently breaks anything addressing the old one.
    const msg = describeTenantRename(tenant(), 'new-name');
    expect(msg).toContain('identifier');
  });

  it('trims the proposed name in the copy', () => {
    // The operator must see the name that will actually be sent, not their
    // paste's trailing space.
    expect(describeTenantRename(tenant(), ' new-name ')).toContain('“new-name”');
  });
});

describe('tenantDetailHref', () => {
  it('addresses the tenant by id, so a rename cannot break the link', () => {
    // The detail endpoint resolves name OR id, but the name is mutable from
    // this very table, one button away. A name-built href 404s the moment the
    // tenant is renamed, and a bookmarked one 404s forever.
    expect(tenantDetailHref(tenant({ id: 'abc-123', name: 'acme' }))).toBe(
      '/admin/tenants/abc-123',
    );
  });

  it('encodes the id', () => {
    expect(tenantDetailHref({ id: 'a b/c' })).toBe('/admin/tenants/a%20b%2Fc');
  });
});

describe('tenantNameTakenMessage', () => {
  it('a 409 tenant_name_taken yields the server sentence for the create form', () => {
    const err = new LicensesAdminCallError(
      "createTenant: 409 — fr already has a licences tenant named 'acme'.",
      409,
      'tenant_name_taken',
      "fr already has a licences tenant named 'acme'.",
    );
    expect(tenantNameTakenMessage(err)).toBe("fr already has a licences tenant named 'acme'.");
  });

  it('falls back to a fixed sentence when the server gave none', () => {
    const err = new LicensesAdminCallError('createTenant: 409', 409, 'tenant_name_taken', '');
    expect(tenantNameTakenMessage(err)).toMatch(/already has a licences tenant with this name/);
  });

  it('any other failure is NOT a name conflict (it goes to the page banner)', () => {
    expect(tenantNameTakenMessage(new Error('createTenant: 409 — x'))).toBeNull();
    expect(
      tenantNameTakenMessage(new LicensesAdminCallError('m', 409, 'tenant_owned_by_other_app', 'd')),
    ).toBeNull();
    expect(tenantNameTakenMessage(new LicensesAdminCallError('m', 502, 'tenant_name_taken', 'd'))).toBeNull();
    expect(tenantNameTakenMessage('nope')).toBeNull();
  });
});
