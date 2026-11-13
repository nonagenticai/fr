// Unit coverage for the licensing console's pure logic (page-helpers.ts).
// Runs under vitest `environment: 'node'` — no DOM, no component render.

import { describe, it, expect } from 'vitest';
import {
  RATE_LIMIT_ENFORCED,
  RATE_LIMIT_NOT_ENFORCED_SUFFIX,
} from '$lib/admin/rate-limit-enforcement';
import {
  formatDate,
  appLabel,
  planLabel,
  isTestApp,
  usableApps,
  provisionableApps,
  selectablePlans,
  licenseState,
  stateTone,
  filterLicenses,
  describeAppDeletion,
  personOption,
  appOptions,
  tenantOptions,
  offeringsReadback,
} from './page-helpers';
import type {
  AppRecord,
  LicenseRecord,
  PersonRecord,
  PlanRecord,
  TenantRecord,
} from '$lib/api/licenses-admin';

const app = (over: Partial<AppRecord> = {}): AppRecord => ({
  id: 'a1',
  key: 'fr',
  name: 'FR',
  description: null,
  revoked: false,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const plan = (over: Partial<PlanRecord> = {}): PlanRecord => ({
  id: 'p1',
  app_id: 'a1',
  code: 'standard',
  name: 'Standard',
  description: null,
  region_id: null,
  duration_days: null,
  rate_limit_rpm: 600,
  rate_limit_burst: 60,
  quota_monthly: null,
  token_budget_monthly: null,
  revoked: false,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const lic = (over: Partial<LicenseRecord> = {}): LicenseRecord => ({
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
  app: { id: 'a1', key: 'fr', name: 'FR' },
  plan: {
    id: 'p1',
    code: 'standard',
    name: 'Standard',
    rate_limit_rpm: 600,
    rate_limit_burst: 60,
    quota_monthly: null,
    token_budget_monthly: null,
  },
  ...over,
});

describe('formatDate', () => {
  it('renders an em-dash for null rather than "Invalid Date"', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('renders an em-dash for an unparseable value', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });

  it('formats a real ISO timestamp', () => {
    expect(formatDate('2026-07-17T10:00:00Z')).not.toBe('—');
  });
});

describe('appLabel', () => {
  it('disambiguates name with the enforced key', () => {
    expect(appLabel({ key: 'fr-frontend', name: 'FR Frontend' })).toBe('FR Frontend (fr-frontend)');
  });

  it('does not repeat itself when name === key', () => {
    expect(appLabel({ key: 'vllm', name: 'vllm' })).toBe('vllm');
  });
});

describe('planLabel', () => {
  it('says "perpetual" when duration is null — never "0d"', () => {
    // null upstream means perpetual/unlimited. Rendering 0 would invert it.
    expect(planLabel(plan())).toContain('perpetual');
  });

  it('omits limits that are unset rather than showing 0', () => {
    const label = planLabel(plan({ rate_limit_rpm: null, quota_monthly: null }));
    expect(label).not.toContain('0');
    expect(label).toContain('perpetual');
  });

  it('surfaces the limits that are set', () => {
    const label = planLabel(plan({ rate_limit_rpm: 600, quota_monthly: 1000, duration_days: 30 }));
    expect(label).toContain('600 rpm');
    expect(label).toContain('1000/mo');
    expect(label).toContain('30d');
  });

  // fr#1046 — `rate_limit_rpm` is written by the admin API and compared by
  // nothing (measured 2026-09-26; see $lib/admin/rate-limit-enforcement for
  // the grep and its positive control). `planLabel` is the ONLY site that
  // renders the value, so it is the only site where a bare number could be
  // read as a live limit. The number must never stand alone.
  it('never renders an rpm value without saying it is not enforced', () => {
    expect(RATE_LIMIT_ENFORCED).toBe(false);
    const label = planLabel(plan({ rate_limit_rpm: 600 }));
    expect(label).toContain('600 rpm');
    expect(label).toContain('not enforced');
    // The claim is about adjacency, not mere presence: a reader scanning the
    // label must meet the disclaimer at the number, not elsewhere in the line.
    expect(label).toContain(`600 rpm${RATE_LIMIT_NOT_ENFORCED_SUFFIX}`);
  });

  it('adds no such disclaimer when there is no rpm value to mislead about', () => {
    // Control: the wording is attached to the VALUE, not pasted on every plan.
    const label = planLabel(plan({ rate_limit_rpm: null }));
    expect(label).not.toContain('rpm');
    expect(label).not.toContain('not enforced');
  });
});

describe('isTestApp', () => {
  it('catches the residue shapes really present in the prod catalog', () => {
    for (const k of [
      'inttest-018c644f',
      'inttest-{uuid}',
      'demo-app',
      'demo-app-1771072269533',
      'test-app-delete-me',
      'dbg2-06d82f',
      'debug-149eef5a',
      'probe-app-del-me',
    ]) {
      expect(isTestApp(k), k).toBe(true);
    }
  });

  it('never swallows a real app key', () => {
    for (const k of [
      'fr', 'fr-frontend', 'artifacts', 'coding', 'kag', 'kag-graph', 'kanban',
      'karma', 'hirag', 'ingestion', 'licenses', 'mcp', 'workers', 'secrets',
      'tools', 'procedures', 'requirements', 'skill-builder', 'storage', 'npm',
      'vllm', 'nlp-service', 'graph-adapter', 'model-registry',
      'training-data-generator', 'improvement-loop',
      'inference-router', 'kag-orchestrator', 'commonpractice', 'w2v', 'w2v-image',
    ]) {
      expect(isTestApp(k), k).toBe(false);
    }
  });
});

describe('usableApps', () => {
  it('drops residue and revoked apps, and sorts by key', () => {
    const out = usableApps([
      app({ id: '1', key: 'vllm' }),
      app({ id: '2', key: 'inttest-abc' }),
      app({ id: '3', key: 'artifacts' }),
      app({ id: '4', key: 'dead', revoked: true }),
    ]);
    expect(out.map((a) => a.key)).toEqual(['artifacts', 'vllm']);
  });
});

describe('selectablePlans', () => {
  it('hides revoked plans — a license must not be grantable on one', () => {
    const out = selectablePlans([plan({ id: '1' }), plan({ id: '2', revoked: true })]);
    expect(out.map((p) => p.id)).toEqual(['1']);
  });
});

describe('licenseState', () => {
  // Real clock: expiries are stamped a day either side of now.
  const PAST = new Date(Date.now() - 86_400_000).toISOString();
  const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

  it('reports expired when the clock says so, even if status still says active', () => {
    // `status` is a stored column and lags reality. Trusting it would tell an
    // operator a dead license is live — the exact failure this guards.
    const state = licenseState({ status: 'active', expires_at: PAST });
    expect(state).toBe('expired');
  });

  it('keeps an unexpired active license active', () => {
    expect(licenseState({ status: 'active', expires_at: FUTURE })).toBe('active');
  });

  it('treats a perpetual (null expiry) active license as active', () => {
    expect(licenseState({ status: 'active', expires_at: null })).toBe('active');
  });

  it('revoked wins over an unexpired window', () => {
    expect(licenseState({ status: 'revoked', expires_at: FUTURE })).toBe('revoked');
  });

  it('ignores an unparseable expiry rather than declaring it expired', () => {
    expect(licenseState({ status: 'active', expires_at: 'garbage' })).toBe('active');
  });

  it('maps pending and unknown statuses', () => {
    expect(licenseState({ status: 'pending', expires_at: null })).toBe('pending');
    expect(licenseState({ status: 'weird', expires_at: null })).toBe('unknown');
  });
});

describe('stateTone', () => {
  it('never paints a revoked or expired license as healthy', () => {
    expect(stateTone('revoked')).toBe('danger');
    expect(stateTone('expired')).toBe('danger');
    expect(stateTone('active')).toBe('success');
  });
});

describe('filterLicenses', () => {
  const rows = [
    lic({ id: '1', app: { id: 'a1', key: 'fr', name: 'FR' } }),
    lic({ id: '2', app: { id: 'a2', key: 'inference-router', name: 'IR' }, subject_id: 'sub-2' }),
  ];

  it('returns everything for an empty query', () => {
    expect(filterLicenses(rows, '   ')).toHaveLength(2);
  });

  it('matches on app key, case-insensitively', () => {
    expect(filterLicenses(rows, 'INFERENCE').map((l) => l.id)).toEqual(['2']);
  });

  it('matches on subject id', () => {
    expect(filterLicenses(rows, 'sub-2').map((l) => l.id)).toEqual(['2']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterLicenses(rows, 'zzz')).toEqual([]);
  });
});

describe('describeAppDeletion', () => {
  it('says plainly when there is nothing to lose', () => {
    const msg = describeAppDeletion(app(), []);
    expect(msg).toContain('no licenses');
  });

  it('counts the licenses and calls out the ACTIVE ones', () => {
    // The cascade is irreversible and upstream has no guard, so this count is
    // the only warning the operator gets. It must be real, not generic.
    const msg = describeAppDeletion(app({ key: 'kag' }), [
      lic({ id: '1', status: 'active' }),
      lic({ id: '2', status: 'revoked' }),
      lic({ id: '3', status: 'active' }),
    ]);
    expect(msg).toContain('3 licenses');
    expect(msg).toContain('2 of them are ACTIVE');
    expect(msg).toContain('cannot be undone');
  });

  it('does not claim active licenses when none are', () => {
    const msg = describeAppDeletion(app(), [lic({ id: '1', status: 'revoked' })]);
    expect(msg).toContain('none of them are active');
  });

  it('counts an expired-but-active-status license as not active', () => {
    const msg = describeAppDeletion(app(), [
      lic({ id: '1', status: 'active', expires_at: '2000-01-01T00:00:00Z' }),
    ]);
    expect(msg).toContain('none of them are active');
  });
});

// --- person-first pickers: the UUID must never leak to the operator --------

const person = (over: Partial<PersonRecord> = {}): PersonRecord => ({
  id: '019efaa0-512b-733e-9e98-b1ac82a6f7ee',
  email: 'jane@acme.test',
  name: 'Jane Doe',
  username: 'jane',
  tenant_id: 't-1',
  ...over,
});

describe('personOption', () => {
  it('labels by name and never surfaces the sub UUID', () => {
    const o = personOption(person());
    expect(o.value).toBe('019efaa0-512b-733e-9e98-b1ac82a6f7ee'); // carried invisibly
    expect(o.label).toBe('Jane Doe');
    expect(o.sublabel).toContain('jane@acme.test');
    // the label an operator reads is never the UUID
    expect(o.label).not.toContain('019efaa0');
  });

  it('does not repeat the name as its own sublabel', () => {
    const o = personOption(person({ name: 'jane', email: null, username: 'jane' }));
    expect(o.sublabel).toBeUndefined();
  });
});

describe('appOptions', () => {
  it('offers only real apps, sorted, with the key as sublabel', () => {
    const opts = appOptions([
      app({ id: '1', key: 'vllm', name: 'vLLM' }),
      app({ id: '2', key: 'inttest-abc', name: 'junk' }),
      app({ id: '3', key: 'artifacts', name: 'Artifacts' }),
    ]);
    expect(opts.map((o) => o.value)).toEqual(['3', '1']); // sorted by key, junk dropped
    expect(opts[0]!.sublabel).toBe('artifacts');
  });
});

describe('tenantOptions', () => {
  it('labels by friendly name, sorted, with byo_mode as sublabel', () => {
    const opts = tenantOptions([
      { id: 't2', name: 'zeta', keycloak_realm: null, byo_mode: 'platform_only', created_at: null },
      { id: 't1', name: 'acme', keycloak_realm: null, byo_mode: 'byo_required', created_at: null },
    ]);
    expect(opts.map((o) => o.label)).toEqual(['acme', 'zeta']);
    expect(opts[0]!.sublabel).toBe('byo_required');
  });
});

describe('provisionableApps', () => {
  // `audience` is the licences service's own classification (migration 022).
  // fr used to keep a hardcoded copy of the seven product keys here AND in the
  // backend, pinned by a drift test; both are gone.
  const app = (key: string, audience?: 'human' | 'platform' | 'automation') => ({
    id: `id-${key}`,
    key,
    name: key,
    description: null,
    revoked: false,
    created_at: '2026-01-01T00:00:00Z',
    ...(audience ? { audience } : {}),
  });

  it('offers only human apps', () => {
    const r = provisionableApps([
      app('fr', 'human'),
      app('coding', 'platform'),
      app('meta_prompt_core_actions', 'automation'),
    ]);
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.apps.map((a) => a.key)).toEqual(['fr']);
  });

  it('still drops revoked and test-key apps, because usableApps runs first', () => {
    const revoked = { ...app('fr-old', 'human'), revoked: true };
    const r = provisionableApps([app('fr', 'human'), revoked]);
    expect(r.status === 'ok' && r.apps.map((a) => a.key)).toEqual(['fr']);
  });

  it('reports a version mismatch when NO row carries audience', () => {
    // The defect this return type exists for: filtering on `audience` over a
    // pre-022 catalogue yields [], which renders an empty picker that looks
    // exactly like a correctly-empty one and blames the operator's selection.
    const r = provisionableApps([app('fr'), app('coding'), app('w2v')]);
    expect(r).toEqual({ status: 'catalogue_missing_audience', total: 3 });
  });

  it('does NOT report a version mismatch when only SOME rows lack audience', () => {
    // A partially-classified catalogue is answerable: the classified rows are
    // the answer, and an unclassified row is simply not offered.
    const r = provisionableApps([app('fr', 'human'), app('mystery')]);
    expect(r.status === 'ok' && r.apps.map((a) => a.key)).toEqual(['fr']);
  });

  it('an empty catalogue is an ok-but-empty answer, not a version mismatch', () => {
    // Nothing to classify is not evidence the field is absent.
    expect(provisionableApps([])).toEqual({ status: 'ok', apps: [] });
  });

  it('a catalogue with rows but no human ones is an answer, not a mismatch', () => {
    const r = provisionableApps([app('coding', 'platform')]);
    expect(r).toEqual({ status: 'ok', apps: [] });
  });
});

// The offerings read-back.
//
// `provision()`/`unprovision()` used to set a success notice and stop. The page
// could not confirm either: `load()` fetches the CATALOGUE and holds no
// tenant->offering assignments, so calling it would re-render identical data.
// A success message asserting an outcome nobody read back is exactly the defect
// this admin work keeps turning up.
//
// The assertion that earns its place is the one about MEANING: a failed read
// must not look like "nothing is provisioned".
describe('offeringsReadback — a failed read is not an empty list', () => {
  it('reports the error rather than falling back to empty', () => {
    // The dangerous case. `[]` is a legitimate state, so rendering one here
    // would claim a tenant has no overrides on no evidence.
    expect(
      offeringsReadback({
        tenantId: 't1',
        busy: false,
        error: 'licences unreachable',
        offerings: null,
      }),
    ).toEqual({ kind: 'error', message: 'licences unreachable' });
  });

  it('an error wins even if a previous result is still in hand', () => {
    // Stale rows next to a failed refresh are worse than an error: they look
    // current. This is what makes the ORDER of the checks load-bearing.
    expect(
      offeringsReadback({ tenantId: 't1', busy: false, error: 'boom', offerings: [{}, {}] }).kind,
    ).toBe('error');
  });

  it('distinguishes loaded-and-empty from never-loaded', () => {
    // `[]` means "no per-product overrides", a working configuration.
    expect(
      offeringsReadback({ tenantId: 't1', busy: false, error: null, offerings: [] }).kind,
    ).toBe('empty');
    // `null` means we have nothing to say — not that the tenant has nothing.
    expect(
      offeringsReadback({ tenantId: 't1', busy: false, error: null, offerings: null }).kind,
    ).toBe('idle');
  });

  it('shows rows when there are rows, and nothing at all without a tenant', () => {
    expect(
      offeringsReadback({ tenantId: 't1', busy: false, error: null, offerings: [{}] }).kind,
    ).toBe('rows');
    expect(
      offeringsReadback({ tenantId: null, busy: false, error: 'x', offerings: [{}] }).kind,
    ).toBe('idle');
  });

  it('loading outranks a stale result', () => {
    expect(
      offeringsReadback({ tenantId: 't1', busy: true, error: null, offerings: [{}] }).kind,
    ).toBe('loading');
  });
});
