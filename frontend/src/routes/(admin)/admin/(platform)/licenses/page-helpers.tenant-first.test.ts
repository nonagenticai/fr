// Pure-logic coverage for the TENANT-FIRST grants console (page-helpers.ts).
// vitest `environment: 'node'` — no DOM, no component render.
//
// EVERY case below names the mutation that must kill it. A test whose assertion
// survives the defect it claims to guard is a green light for the defect.

import { describe, it, expect } from 'vitest';
import {
  seatCountReadback,
  seatBasisDisclosure,
  seatCountScope,
  seatCountArchived,
  offeringProvenance,
  tenantEvidence,
  canAddSeat,
  licensesForTenant,
} from './page-helpers';
import type { LicenseRecord, TenantSeatCount } from '$lib/api/licenses-admin';

const count = (over: Partial<TenantSeatCount> = {}): TenantSeatCount => ({
  seats: 12,
  subjects: 9,
  human_subjects: 7,
  service_subjects: 1,
  unresolved_subjects: 1,
  basis: 'human_subjects',
  period_start: '2026-09-01T00:00:00Z',
  period_end: '2026-09-30T23:59:59Z',
  ...over,
});

const lic = (over: Partial<LicenseRecord> = {}): LicenseRecord =>
  ({
    id: 'l1',
    subject_id: 'sub-1',
    tenant_id: 't-1',
    app_id: 'a1',
    plan_id: 'p1',
    region_id: null,
    status: 'active',
    starts_at: '2026-01-01T00:00:00Z',
    expires_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    revoked_at: null,
    metadata: null,
    ...over,
  }) as LicenseRecord;

// ---------------------------------------------------------------------------

describe('seatCountReadback — an unreadable denominator is UNKNOWN, never zero', () => {
  it('reports unknown when the read rejected', () => {
    // KILLS: `catch { count = 0 }`. That line turns a failed GET into a claim
    // about BILLING — "this tenant has no seats" — and the caller cannot tell
    // it apart from a tenant that genuinely has none.
    const r = seatCountReadback({
      tenantId: 't-1',
      busy: false,
      error: 'getTenantSeatCount: 502',
      count: null,
    });
    expect(r.kind).toBe('unknown');
    expect(r).not.toHaveProperty('count');
  });

  it('reports unknown when there is neither an error nor a payload', () => {
    // KILLS: a `?? 0` / `count ?? {seats: 0, …}` default anywhere on this path.
    // "Not read yet" is not zero either; only a payload produces a number.
    expect(
      seatCountReadback({ tenantId: 't-1', busy: false, error: null, count: null }).kind,
    ).toBe('unknown');
  });

  it('an error outranks a stale payload still in hand', () => {
    // KILLS: reordering the checks so a previous tenant's (or a pre-refresh)
    // count is rendered next to a failed read. Stale numbers are worse than
    // unknown ones: they look current.
    expect(
      seatCountReadback({ tenantId: 't-1', busy: false, error: 'boom', count: count() }).kind,
    ).toBe('unknown');
  });

  it('loading outranks a stale payload', () => {
    expect(
      seatCountReadback({ tenantId: 't-1', busy: true, error: null, count: count() }).kind,
    ).toBe('loading');
  });

  it('distinguishes "no tenant chosen" from "chosen and unreadable"', () => {
    // KILLS: collapsing idle into unknown. Only one of the two is an incident;
    // an operator who has not picked a tenant yet must not see a warning.
    expect(
      seatCountReadback({ tenantId: null, busy: false, error: 'boom', count: null }).kind,
    ).toBe('idle');
    expect(
      seatCountReadback({ tenantId: 't-1', busy: false, error: 'boom', count: null }).kind,
    ).toBe('unknown');
  });

  it('returns the payload when there is one', () => {
    const r = seatCountReadback({ tenantId: 't-1', busy: false, error: null, count: count() });
    expect(r).toEqual({ kind: 'ok', count: count() });
  });

  it('a genuine ZERO from upstream is ok, not unknown', () => {
    // The control that gives the four cases above their meaning: zero IS a real
    // answer when a payload says so. Without this, "never render 0" could be
    // satisfied by never rendering a true zero either.
    const r = seatCountReadback({
      tenantId: 't-1',
      busy: false,
      error: null,
      count: count({ seats: 0, subjects: 0, human_subjects: 0, service_subjects: 0, unresolved_subjects: 0 }),
    });
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.count.human_subjects).toBe(0);
  });
});

describe('seatBasisDisclosure — the three classes partition subjects', () => {
  it('shows human_subjects as the billable basis', () => {
    expect(seatBasisDisclosure(count()).billable).toBe(7);
  });

  it('discloses unresolved_subjects SEPARATELY, never folded in', () => {
    // KILLS: `human_subjects + unresolved_subjects` (over-bills) and
    // `service_subjects + unresolved_subjects` (hides the ambiguity). Either
    // fold makes the billable number unauditable.
    const d = seatBasisDisclosure(count({ human_subjects: 7, service_subjects: 1, unresolved_subjects: 1 }));
    expect(d.billable).toBe(7);
    expect(d.excluded.map((x) => x.key)).toEqual(['service', 'unresolved']);
    expect(d.excluded.find((x) => x.key === 'unresolved')?.value).toBe(1);
    expect(d.excluded.find((x) => x.key === 'service')?.value).toBe(1);
  });

  it('emits the unresolved line even when it is ZERO', () => {
    // KILLS: `if (unresolved > 0)` around the disclosure. Hiding the cell when
    // empty teaches the reader that the other two always add up — so the one
    // time they do not, nobody looks.
    const d = seatBasisDisclosure(count({ subjects: 8, human_subjects: 7, service_subjects: 1, unresolved_subjects: 0 }));
    const line = d.excluded.find((x) => x.key === 'unresolved');
    expect(line).toBeDefined();
    expect(line?.value).toBe(0);
  });

  it('flags upstream arithmetic that does not partition, instead of reconciling it', () => {
    // KILLS: `subjects = human + service + unresolved` (recomputing the total
    // locally) or clamping the difference into one of the classes. Either one
    // makes a broken upstream look consistent.
    const d = seatBasisDisclosure(count({ subjects: 20, human_subjects: 7, service_subjects: 1, unresolved_subjects: 1 }));
    expect(d.partitionMismatch).toContain('20');
    expect(d.partitionMismatch).toContain('9');
  });

  it('stays silent when the partition holds', () => {
    expect(seatBasisDisclosure(count()).partitionMismatch).toBeNull();
  });

  it('keeps licence rows and subjects as separate numbers', () => {
    // `seats` >= `subjects`: one person may hold several licences in a tenant.
    // KILLS: rendering `seats` as the billable basis.
    const d = seatBasisDisclosure(count({ seats: 12, subjects: 9 }));
    expect(d.seats).toBe(12);
    expect(d.subjects).toBe(9);
    expect(d.billable).not.toBe(d.seats);
  });
});

describe('seatCountScope — an unscoped figure must say it is all-apps', () => {
  it('reports all-apps when app_key is null', () => {
    // KILLS: dropping the scope label, and defaulting `app_key` to a product.
    // Without `?app=` upstream aggregates EVERY app the tenant holds; rendered
    // unlabelled beside a list of product names it reads as a per-product seat
    // count. Upstream: "Without it a tenant's licences for every other app
    // inflate a per-product seat count."
    const s = seatCountScope({ app_key: null });
    expect(s.kind).toBe('all_apps');
    expect(s.label).toContain('all apps');
  });

  it('reports all-apps when app_key is ABSENT, not just null', () => {
    // KILLS: `app_key === null` as the test. An older licences deployment omits
    // the field entirely, and `undefined !== null` would fall through to the
    // per-product branch — labelling an aggregate as one product's count, which
    // is the exact lie this helper exists to stop.
    expect(seatCountScope({}).kind).toBe('all_apps');
  });

  it('treats an empty-string app_key as unscoped', () => {
    expect(seatCountScope({ app_key: '' }).kind).toBe('all_apps');
  });

  it('names the product when the count IS scoped', () => {
    // The control that keeps the three cases above honest: if the label were
    // hardcoded to "all apps", this would fail. It proves the label is DRIVEN by
    // the payload rather than asserted by the call site.
    const s = seatCountScope({ app_key: 'commonpractice' });
    expect(s.kind).toBe('one_app');
    expect(s.kind === 'one_app' && s.appKey).toBe('commonpractice');
    expect(s.label).toContain('commonpractice');
    expect(s.label).not.toContain('all apps');
  });

  it('is carried on the disclosure, so the renderer cannot forget it', () => {
    expect(seatBasisDisclosure(count()).scope.kind).toBe('all_apps');
    expect(seatBasisDisclosure(count({ app_key: 'fr' })).scope.kind).toBe('one_app');
  });
});

describe('seatCountArchived — a zero must stay attributable', () => {
  it('believes the tenant_archived flag', () => {
    // KILLS: rendering an archived tenant's 0 as a bare 0, indistinguishable
    // from a live tenant with no seats. Different facts, different remedies.
    expect(seatCountArchived({ tenant_archived: true, basis: 'active_licences' })).toBe(true);
  });

  it('ALSO believes basis === tenant_archived on its own', () => {
    // Two independent signals carry this one fact. KILLS: reading only the flag
    // — a deployment that sets the basis but not the boolean would silently lose
    // the caveat, and the expensive direction of error is missing it.
    expect(seatCountArchived({ tenant_archived: undefined, basis: 'tenant_archived' })).toBe(true);
  });

  it('is false for a live tenant, including one with genuinely zero seats', () => {
    // The control: the caveat must not appear on every tenant, or it says nothing.
    expect(seatCountArchived({ tenant_archived: false, basis: 'active_licences' })).toBe(false);
    expect(seatCountArchived({ basis: 'active_licences' })).toBe(false);
  });
});

describe('offeringProvenance — null code is UNKNOWN, not absence', () => {
  it('reports unknown for a null offering_code', () => {
    // KILLS: `row.offering_code ?? ''` / `?? '—'` / any falsy-to-blank render.
    // The row IS provisioned; only which offering produced it was never
    // recorded (posture set directly, or predating licences migration 025).
    expect(offeringProvenance({ offering_code: null })).toEqual({ known: false });
  });

  it('passes a real code through', () => {
    expect(offeringProvenance({ offering_code: 'starter-2026' })).toEqual({
      known: true,
      code: 'starter-2026',
    });
  });

  it('treats an empty-string code as unknown too, not as a code', () => {
    // An empty code is no more informative than null and must not render as a
    // present-but-blank value.
    expect(offeringProvenance({ offering_code: '' })).toEqual({ known: false });
  });
});

describe('tenantEvidence — corroboration, never a precondition', () => {
  it('reports unknown when the person carries no tenant attribute', () => {
    expect(tenantEvidence({ tenant_id: null }, 't-1')).toEqual({ kind: 'unknown' });
    expect(tenantEvidence({}, 't-1')).toEqual({ kind: 'unknown' });
  });

  it('reports a mismatch with BOTH ids, so the operator can judge it', () => {
    expect(tenantEvidence({ tenant_id: 't-other' }, 't-1')).toEqual({
      kind: 'mismatch',
      personTenantId: 't-other',
      targetTenantId: 't-1',
    });
  });

  it('reports a match', () => {
    expect(tenantEvidence({ tenant_id: 't-1' }, 't-1')).toEqual({ kind: 'match', tenantId: 't-1' });
  });

  it('is "none" before there is anything to corroborate', () => {
    expect(tenantEvidence(null, 't-1').kind).toBe('none');
    expect(tenantEvidence({ tenant_id: 't-1' }, null).kind).toBe('none');
  });
});

describe('canAddSeat — tenant first, and evidence is NOT a gate', () => {
  const ready = {
    tenantId: 't-1',
    subjectId: 'sub-1',
    appId: 'a1',
    planId: 'p1',
    busy: false,
  };

  it('refuses without a tenant even when everything else is chosen', () => {
    // KILLS: restoring the person-first order. Under the old flow the tenant was
    // derived from the person (or left null and defaulted upstream), so a form
    // with a person, app and plan was submittable — and a seat could land on a
    // tenant nobody picked. This is the logic half of that gate.
    expect(canAddSeat({ ...ready, tenantId: null })).toBe(false);
  });

  it('still requires the person — a seat IS a person', () => {
    // KILLS: "removing people" from the console. `license.subject_id` is NOT
    // NULL upstream; a tenant-only submit cannot mint anything.
    expect(canAddSeat({ ...ready, subjectId: null })).toBe(false);
  });

  it('requires app and plan, and refuses while a grant is in flight', () => {
    expect(canAddSeat({ ...ready, appId: null })).toBe(false);
    expect(canAddSeat({ ...ready, planId: null })).toBe(false);
    expect(canAddSeat({ ...ready, busy: true })).toBe(false);
  });

  it('allows the grant with everything chosen', () => {
    expect(canAddSeat(ready)).toBe(true);
  });

  it('does NOT consult tenant evidence, the seat count, or the offerings read', () => {
    // KILLS: any `&& evidence.kind !== 'unknown'`, `&& seatCount !== null` or
    // `&& offerings.length > 0` added to this gate. Missing tenant evidence is
    // the MAJORITY case (most Keycloak users have no `tenant_id` attribute), and
    // an unreadable seat count or offerings list is a failed GET — turning
    // either into a work stoppage denies legitimate grants.
    //
    // The signature is the assertion: `canAddSeat` is given nothing else to
    // gate on, so a mutation that wanted to gate on those would have to widen
    // it and this call site would stop compiling.
    expect(Object.keys(ready).sort()).toEqual(['appId', 'busy', 'planId', 'subjectId', 'tenantId']);
    expect(canAddSeat(ready)).toBe(true);
  });
});

describe('licensesForTenant', () => {
  const rows = [lic({ id: '1', tenant_id: 't-1' }), lic({ id: '2', tenant_id: 't-2' })];

  it('scopes the unfiltered licence list to one tenant', () => {
    expect(licensesForTenant(rows, 't-1').map((l) => l.id)).toEqual(['1']);
  });

  it('returns nothing — not everything — without a tenant', () => {
    // KILLS: `if (!tenantId) return licenses`, which would label the whole
    // platform's rows as belonging to the (unselected) tenant.
    expect(licensesForTenant(rows, null)).toEqual([]);
  });
});
