// inference-form — the draft → wire rules (pure).

import { describe, expect, it } from 'vitest';
import type { InferenceConfig } from '$lib/api/inference-admin';
import {
  currencyChange,
  draftFromPolicy,
  emptyInferenceDraft,
  inferencePayload,
  setupOptions,
} from './inference-form';

const CONFIG_OFF: InferenceConfig = {
  enabled: true,
  setup2_enabled: false,
  setups: [
    { setup: 'local', available: true, reason: null },
    { setup: 'owner_commercial', available: false, reason: 'available after spend breakers are live' },
    { setup: 'byo', available: false, reason: 'available after BYO key custody ships' },
  ],
};
const CONFIG_SETUP2: InferenceConfig = {
  ...CONFIG_OFF,
  setups: [
    { setup: 'local', available: true, reason: null },
    { setup: 'owner_commercial', available: true, reason: null },
    { setup: 'byo', available: false, reason: 'available after BYO key custody ships' },
  ],
};

describe('inferencePayload', () => {
  it('setup 1 → one platform tier on pgx-local/local-llm, integer EUR, explicit byo_mode', () => {
    const r = inferencePayload({ ...emptyInferenceDraft(), budget_amount: '10' }, CONFIG_OFF);
    expect(r).toEqual({
      ok: true,
      input: {
        setup: 'local',
        tiers: [{ tier: 'medium', hops: [{ kind: 'platform', provider: 'pgx-local', model: 'local-llm' }] }],
        byo_mode: 'byo_required',
        budget_amount: 10,
        budget_currency: 'EUR',
      },
    });
  });

  it('byo_mode defaults to byo_required (licenses#273); an explicit choice is sent as picked', () => {
    expect(emptyInferenceDraft().byo_mode).toBe('byo_required');
    for (const m of ['local_allowed', 'byo_required', 'platform_only'] as const) {
      const r = inferencePayload({ ...emptyInferenceDraft(), budget_amount: '10', byo_mode: m }, CONFIG_OFF);
      expect(r.ok && r.input.byo_mode).toBe(m);
    }
  });

  it('the currency is the owner’s choice (EUR default; USD, CAD) and travels with the amount', () => {
    for (const c of ['USD', 'CAD'] as const) {
      const r = inferencePayload({ ...emptyInferenceDraft(), budget_amount: 7, budget_currency: c }, CONFIG_OFF);
      expect(r.ok && r.input.budget_currency).toBe(c);
      expect(r.ok && r.input.budget_amount).toBe(7);
    }
    const bad = inferencePayload(
      { ...emptyInferenceDraft(), budget_amount: 7, budget_currency: 'GBP' as never },
      CONFIG_OFF,
    );
    expect(bad.ok).toBe(false);
  });

  it('payment terms are never sent (modelled only, billing-service#247)', () => {
    const r = inferencePayload({ ...emptyInferenceDraft(), budget_amount: 1 }, CONFIG_OFF);
    expect(r.ok && 'payment_terms' in r.input).toBe(false);
  });

  it('refuses a decimal, negative, empty or over-cap budget', () => {
    for (const b of ['10.5', '-1', '', '1000001', 'ten']) {
      const r = inferencePayload({ ...emptyInferenceDraft(), budget_amount: b }, CONFIG_OFF);
      expect(r.ok, `budget ${JSON.stringify(b)}`).toBe(false);
    }
    expect(inferencePayload({ ...emptyInferenceDraft(), budget_amount: 0 }, CONFIG_OFF).ok).toBe(true);
  });

  it('refuses setup 2 and setup 3 while unavailable, naming the reason', () => {
    const two = inferencePayload({ ...emptyInferenceDraft(), setup: 'owner_commercial', budget_amount: 5 }, CONFIG_OFF);
    expect(two.ok).toBe(false);
    expect(two.ok ? '' : two.error).toContain('spend breakers');
    const three = inferencePayload({ ...emptyInferenceDraft(), setup: 'byo', budget_amount: 5 }, CONFIG_SETUP2);
    expect(three.ok ? '' : three.error).toContain('BYO key custody');
  });

  it('setup 2 (armed) → owner hops + one markup row per provider×model', () => {
    const r = inferencePayload(
      {
        ...emptyInferenceDraft(),
        setup: 'owner_commercial',
        budget_amount: 100,
        tiers: [
          { tier: 'small', provider: 'deepseek', model: 'deepseek-v4-pro', pct: '25' },
          { tier: 'high', provider: 'deepseek', model: 'deepseek-v4-pro', pct: '25.00' },
        ],
      },
      CONFIG_SETUP2,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.tiers.map((t) => t.hops[0]!.kind)).toEqual(['owner', 'owner']);
    expect(r.input.markup).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-pro', pct: 25 }]);
  });

  it('setup 2 refuses a missing markup %, a 3-decimal one, and a duplicated tier', () => {
    const base = { ...emptyInferenceDraft(), setup: 'owner_commercial' as const, budget_amount: 1 };
    expect(inferencePayload({ ...base, tiers: [{ tier: 'small', provider: 'p', model: 'm', pct: '' }] }, CONFIG_SETUP2).ok).toBe(false);
    expect(inferencePayload({ ...base, tiers: [{ tier: 'small', provider: 'p', model: 'm', pct: '1.234' }] }, CONFIG_SETUP2).ok).toBe(false);
    expect(
      inferencePayload(
        {
          ...base,
          tiers: [
            { tier: 'small', provider: 'p', model: 'm', pct: '1' },
            { tier: 'small', provider: 'q', model: 'n', pct: '1' },
          ],
        },
        CONFIG_SETUP2,
      ).ok,
    ).toBe(false);
  });
});

describe('setupOptions', () => {
  it('falls back to the documented reasons when the probe is missing', () => {
    const opts = setupOptions(null);
    expect(opts.map((o) => [o.setup, o.available])).toEqual([
      ['local', true],
      ['owner_commercial', false],
      ['byo', false],
    ]);
    expect(opts[1]!.reason).toBe('available after spend breakers are live');
    expect(opts[2]!.reason).toBe('available after BYO key custody ships');
  });
});

describe('draftFromPolicy', () => {
  it('prefills setup, byo_mode and the tier from the active doc — never the budget', () => {
    const d = draftFromPolicy({
      schema: 1,
      setup: 'local',
      byo_mode: 'platform_only',
      tiers: { small: [{ target: { kind: 'platform', provider: 'pgx-local' }, model: 'local-llm' }] },
    });
    expect(d.setup).toBe('local');
    expect(d.byo_mode).toBe('platform_only');
    expect(d.tier).toBe('small');
    expect(d.budget_amount).toBe('');
  });

  it('a missing doc is the empty draft', () => {
    expect(draftFromPolicy(null)).toEqual(emptyInferenceDraft());
  });

  it('the currency prefills from the tenant’s current currency when known', () => {
    expect(draftFromPolicy(null, 'CAD').budget_currency).toBe('CAD');
    expect(draftFromPolicy(null, 'XYZ').budget_currency).toBe('EUR');
  });
});

describe('currencyChange', () => {
  it('none / changed / unknown', () => {
    const d = { ...emptyInferenceDraft(), budget_currency: 'USD' as const };
    expect(currencyChange(d, 'USD')).toBe('none');
    expect(currencyChange(d, 'EUR')).toBe('changed');
    expect(currencyChange(d, null)).toBe('unknown');
  });
});
