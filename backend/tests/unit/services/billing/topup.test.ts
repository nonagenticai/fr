// tests/unit/services/billing/topup.test.ts
//
// The payment seam. The property that matters most: allocation NEVER runs
// unless settlement reports paid — so when a real payment provider is wired, a
// declined card cannot mint free tokens.

import { test, expect, describe } from 'bun:test';
import {
  TOPUP_PACKAGES,
  findPackage,
  FreeSettlement,
  StripeSettlement,
  getSettlement,
  type TopUpIntent,
} from '../../../../src/services/billing/topup';
import { IntegrationError } from '../../../../src/integrations/_lib/errors';

const intent = (over: Partial<TopUpIntent> = {}): TopUpIntent => ({
  tenantId: 't-1',
  tokens: 1_000_000,
  priceUsd: 0,
  packageId: 'tokens_1m',
  actorUserId: 'sub-1',
  ...over,
});

describe('packages', () => {
  test('are all free today (no payment processor exists)', () => {
    for (const p of TOPUP_PACKAGES) expect(p.priceUsd).toBe(0);
  });

  test('findPackage resolves a known id and rejects an unknown one', () => {
    expect(findPackage('tokens_5m')?.tokens).toBe(5_000_000);
    expect(findPackage('nope')).toBeUndefined();
  });
});

describe('FreeSettlement', () => {
  test('settles a free package as paid with a greppable pre-payment ref', async () => {
    const r = await new FreeSettlement().settle(intent());
    expect(r.paid).toBe(true);
    expect(r.status).toBe('free');
    expect(r.ref).toContain('free-');
  });

  test('REFUSES a priced package rather than giving paid tokens away', async () => {
    // If a package ever gets a price while Free is still the settlement, that's
    // a misconfiguration — fail closed, do not allocate.
    const r = await new FreeSettlement().settle(intent({ priceUsd: 49 }));
    expect(r.paid).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('no payment processor');
  });
});

describe('StripeSettlement', () => {
  test('is a guarded stub — throws so real money never flows through it', async () => {
    await expect(new StripeSettlement().settle(intent())).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });
});

describe('getSettlement', () => {
  test('returns FreeSettlement today', () => {
    expect(getSettlement()).toBeInstanceOf(FreeSettlement);
  });
});

