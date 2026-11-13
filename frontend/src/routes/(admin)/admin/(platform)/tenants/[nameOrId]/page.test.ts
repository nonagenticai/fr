// Pure-logic tests for /admin/tenants/[nameOrId]. No component render — these
// run in the vitest `node` environment alongside the other page-helpers suites.
//
// The assertions that earn their place are the ones about MEANING. Two claims
// this page could make and must not:
//
//   - that a row with no offering code was never provisioned (it means the
//     provenance is UNKNOWN), and
//   - that a tenant with no per-product rows "has nothing" (it means no
//     overrides, so everything falls back to the tenant-wide posture).
//
// Both are one string away from being wrong, and a wrong one is invisible in
// review, so they are asserted here rather than trusted.

import { describe, it, expect } from 'vitest';
import type { TenantOfferingRecord, TenantRecord } from '$lib/api/licenses-admin';
import {
  OFFERINGS_SCOPE_NOTE,
  OFFERING_UNKNOWN_LABEL,
  OFFERING_UNKNOWN_NOTE,
  byoTone,
  describeNoOfferings,
  describeOfferings,
  offeringProvenance,
  overridesTenantDefault,
  productLabel,
  sortOfferings,
  tenantHeading,
  unknownProvenanceCount,
} from './page-helpers';

function offering(p: Partial<TenantOfferingRecord> = {}): TenantOfferingRecord {
  return {
    app_key: 'kanban',
    app_name: 'Kanban',
    byo_mode: 'platform_only',
    offering_code: 'starter',
    created_at: null,
    updated_at: null,
    ...p,
  };
}

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

describe('offeringProvenance', () => {
  it('renders a real code as itself', () => {
    const p = offeringProvenance(offering({ offering_code: 'growth-2026' }));
    expect(p).toEqual({ known: true, label: 'growth-2026' });
  });

  it('a null code is UNKNOWN, never blank and never a dash', () => {
    // The whole point of the page. A blank cell or an em-dash asserts "nothing
    // was provisioned for this product"; null only says we cannot account for
    // what did. The label must be non-empty and must not be punctuation.
    const p = offeringProvenance(offering({ offering_code: null }));
    expect(p.known).toBe(false);
    expect(p.label).toBe(OFFERING_UNKNOWN_LABEL);
    expect(p.label.trim().length).toBeGreaterThan(0);
    expect(['-', '—', '–', 'none', 'None', '']).not.toContain(p.label);
  });

  it('the unknown label says unknown, not none', () => {
    expect(OFFERING_UNKNOWN_LABEL.toLowerCase()).toContain('unknown');
    expect(OFFERING_UNKNOWN_LABEL.toLowerCase()).not.toContain('none');
  });

  it('an empty or whitespace code is unknown too', () => {
    // A blank string is no more an offering code than null is; letting it
    // through would print the exact empty cell this helper exists to prevent.
    expect(offeringProvenance(offering({ offering_code: '' })).known).toBe(false);
    expect(offeringProvenance(offering({ offering_code: '   ' })).known).toBe(false);
  });
});

describe('OFFERING_UNKNOWN_NOTE', () => {
  it('explains BOTH causes and denies the "nothing provisioned" reading', () => {
    // An operator who reads only this note must come away knowing that unknown
    // is not absence, and why a row can be in that state at all.
    const n = OFFERING_UNKNOWN_NOTE.toLowerCase();
    expect(n).toContain('does not mean nothing was provisioned');
    expect(n).toContain('directly');
    expect(n).toContain('backfilled');
  });
});

describe('OFFERINGS_SCOPE_NOTE', () => {
  it('disclaims the billing half that this page does not fetch', () => {
    // Provisioning writes a markup rule and an access charge into
    // billing_service. None of it is on this page, and a table of products
    // under a tenant is exactly what gets forwarded as "their billing".
    const n = OFFERINGS_SCOPE_NOTE.toLowerCase();
    expect(n).toContain('markup rule');
    expect(n).toContain('access charge');
    expect(n).toContain('billing');
    expect(n).toContain('neither is shown here');
  });
});

describe('unknownProvenanceCount', () => {
  it('counts only the rows we cannot account for', () => {
    const rows = [
      offering({ app_key: 'a', offering_code: 'x' }),
      offering({ app_key: 'b', offering_code: null }),
      offering({ app_key: 'c', offering_code: null }),
    ];
    expect(unknownProvenanceCount(rows)).toBe(2);
    expect(unknownProvenanceCount([])).toBe(0);
  });
});

describe('describeNoOfferings', () => {
  it('says "no overrides", not "no offerings"', () => {
    // An empty list is a WORKING configuration. "No offerings" reads as "this
    // tenant has nothing", which would send an operator provisioning a tenant
    // that needs nothing done to it.
    const s = describeNoOfferings('byo_required');
    expect(s.toLowerCase()).toContain('no per-product overrides');
    expect(s.toLowerCase()).toContain('falls back');
    expect(s.toLowerCase()).toContain('normal');
  });

  it('names the tenant-wide mode everything falls back to', () => {
    expect(describeNoOfferings('local_allowed')).toContain('local_allowed');
    expect(describeNoOfferings('platform_only')).toContain('platform_only');
  });
});

describe('describeOfferings', () => {
  it('is a plain count when every row has a recorded offering', () => {
    const s = describeOfferings([offering({ app_key: 'a' }), offering({ app_key: 'b' })]);
    expect(s).toContain('2 per-product posture rows');
    expect(s.toLowerCase()).not.toContain('unknown');
  });

  it('surfaces the unknown rows up front rather than cell by cell', () => {
    const s = describeOfferings([
      offering({ app_key: 'a', offering_code: 'x' }),
      offering({ app_key: 'b', offering_code: null }),
    ]);
    expect(s).toContain('1 of 2');
    expect(s.toLowerCase()).toContain('unknown, not absent');
  });

  it('singularises one row', () => {
    expect(describeOfferings([offering()])).toContain('1 per-product posture row.');
  });
});

describe('productLabel', () => {
  it('prefers the name and falls back to the key', () => {
    expect(productLabel(offering({ app_name: 'Kanban', app_key: 'kanban' }))).toBe('Kanban');
    expect(productLabel(offering({ app_name: '', app_key: 'kag' }))).toBe('kag');
  });
});

describe('sortOfferings', () => {
  it('orders by visible label, tiebreaking on the key, without mutating', () => {
    const input = [
      offering({ app_key: 'z', app_name: 'Alpha' }),
      offering({ app_key: 'a', app_name: 'Alpha' }),
      offering({ app_key: 'm', app_name: 'Beta' }),
    ];
    const out = sortOfferings(input);
    expect(out.map((r) => r.app_key)).toEqual(['a', 'z', 'm']);
    expect(input.map((r) => r.app_key)).toEqual(['z', 'a', 'm']);
  });
});

describe('byoTone', () => {
  it('flags byo_required as warning, never danger', () => {
    // byo_required is a deliberate, valid posture — not a fault. It is
    // highlighted only because it hard-fails runs when no key is configured.
    expect(byoTone('byo_required')).toBe('warning');
    expect(byoTone('platform_only')).toBe('neutral');
    expect(byoTone('local_allowed')).toBe('accent');
  });

  it('an unrecognised mode is neutral, not an alarm', () => {
    expect(byoTone('something_new')).toBe('neutral');
  });
});

describe('overridesTenantDefault', () => {
  it('is true only when the row actually changes the posture', () => {
    expect(overridesTenantDefault(offering({ byo_mode: 'byo_required' }), 'platform_only')).toBe(
      true,
    );
    expect(overridesTenantDefault(offering({ byo_mode: 'platform_only' }), 'platform_only')).toBe(
      false,
    );
  });
});

describe('tenantHeading', () => {
  it('appends the realm when there is one', () => {
    expect(tenantHeading(tenant({ name: 'acme', keycloak_realm: 'portal' }))).toBe(
      'acme · portal',
    );
  });

  it('is just the name when the realm is null or blank', () => {
    expect(tenantHeading(tenant({ keycloak_realm: null }))).toBe('acme');
    expect(tenantHeading(tenant({ keycloak_realm: '  ' }))).toBe('acme');
  });
});

