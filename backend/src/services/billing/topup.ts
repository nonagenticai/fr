// src/services/billing/topup.ts
//
// Budget top-up with a PAYMENT SEAM.
//
// George's constraint: tenant-admins can top up their token budget now (no
// money changes hands — the fleet has no payment processor), but "prepare
// everything so that in the future we can set up Stripe or other billing
// automation and payment integration."
//
// So a top-up is a THREE-STEP pipeline, and payment slots into the middle with
// zero change to the allocation or the UI:
//
//     price(package)        → how much this package costs (0 today)
//     settle(intent)        → TODAY: FreeSettlement returns {paid:true, ref:'free-…'}
//                             FUTURE: StripeSettlement creates a PaymentIntent
//     allocate()            → billing POST /api/budget/topup/{tenant} (source='topup')
//
// The allocation NEVER runs unless settlement reports paid. When Stripe lands,
// the only change is swapping the injected `Settlement` — the orchestrator,
// routes, packages and screens are untouched. The chosen settlement's `ref` +
// `status` are recorded on fr's `budget_topups` audit row (billing's
// token_budgets table has no metadata column), giving a future reconciliation
// layer its hook.

import { IntegrationError } from '../../integrations/_lib/errors';

// ---------------------------------------------------------------------------
// Packages — the "known values" a super-admin/tenant-admin picks from (every
// field a dropdown). `priceUsd` is 0 today; it becomes the charge amount the
// moment a real Settlement is wired, with NO other change here.
// ---------------------------------------------------------------------------

export interface TopUpPackage {
  id: string;
  label: string;
  tokens: number;
  /** USD price. 0 while there is no payment processor. */
  priceUsd: number;
}

export const TOPUP_PACKAGES: readonly TopUpPackage[] = [
  { id: 'tokens_1m', label: '1M tokens', tokens: 1_000_000, priceUsd: 0 },
  { id: 'tokens_5m', label: '5M tokens', tokens: 5_000_000, priceUsd: 0 },
  { id: 'tokens_25m', label: '25M tokens', tokens: 25_000_000, priceUsd: 0 },
  { id: 'tokens_100m', label: '100M tokens', tokens: 100_000_000, priceUsd: 0 },
] as const;

export function findPackage(packageId: string): TopUpPackage | undefined {
  return TOPUP_PACKAGES.find((p) => p.id === packageId);
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export interface TopUpIntent {
  tenantId: string;
  tokens: number;
  priceUsd: number;
  packageId: string;
  /** Keycloak sub of the human who initiated the top-up (for the audit row). */
  actorUserId: string;
}

export interface SettlementResult {
  /** Whether payment succeeded. Allocation runs ONLY when true. */
  paid: boolean;
  /** Provider reference (a PaymentIntent id, or a `free-…` sentinel). */
  ref: string;
  /** `paid` | `free` | `failed` | `pending` — recorded on the audit row. */
  status: 'paid' | 'free' | 'failed' | 'pending';
  /** Human-readable reason when `paid` is false. */
  error?: string;
}

/**
 * Turns money owed into a settlement. The whole point of the seam: today's
 * FreeSettlement and a future StripeSettlement are interchangeable, and the
 * orchestrator below cannot tell them apart.
 */
export interface Settlement {
  settle(intent: TopUpIntent): Promise<SettlementResult>;
}

/**
 * No payment processor exists, so every top-up settles for free. Refuses a
 * PRICED intent loudly rather than silently giving away paid tokens — if a
 * package ever gets a non-zero price while this is still the active settlement,
 * that is a misconfiguration we must not paper over.
 */
export class FreeSettlement implements Settlement {
  async settle(intent: TopUpIntent): Promise<SettlementResult> {
    if (intent.priceUsd > 0) {
      return {
        paid: false,
        ref: '',
        status: 'failed',
        error:
          `package '${intent.packageId}' is priced at $${intent.priceUsd} but no ` +
          `payment processor is configured — refusing to allocate paid tokens for free`,
      };
    }
    // A stable, greppable sentinel so audit rows are clearly pre-payment-era.
    return { paid: true, ref: `free-${intent.tenantId}-${intent.packageId}`, status: 'free' };
  }
}

/**
 * Placeholder for the future paid path. Deliberately NOT wired — it throws so
 * nobody accidentally routes real money through an unimplemented processor.
 * When Stripe (or another provider) is chosen, implement `settle` here to
 * create a PaymentIntent and return its id as `ref`, and inject this instead of
 * FreeSettlement in `getSettlement()`. Nothing else changes.
 */
export class StripeSettlement implements Settlement {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async settle(_intent: TopUpIntent): Promise<SettlementResult> {
    throw new IntegrationError({
      code: 'NOT_IMPLEMENTED',
      message:
        'StripeSettlement is a placeholder — no payment provider is wired yet. ' +
        'Implement settle() (create a PaymentIntent, return its id as ref) and ' +
        'inject it from getSettlement() when a provider is chosen.',
      service: 'billing-topup',
      method: 'settle',
      path: '/topup',
    });
  }
}

/**
 * The active settlement. TODAY: free. When a payment provider is configured
 * (e.g. `PAYMENT_PROVIDER=stripe`), return the provider settlement here — the
 * single line that flips fr from free-allocation to paid.
 */
export function getSettlement(): Settlement {
  // Future: `if (process.env.PAYMENT_PROVIDER === 'stripe') return new StripeSettlement();`
  return new FreeSettlement();
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface AllocatedTopUp {
  /** The billing budget row id that now holds the topped-up tokens. */
  budgetId: string;
  tokens: number;
  packageId: string;
  paymentRef: string;
  paymentStatus: SettlementResult['status'];
}

/**
 * settle → (only if paid) allocate.
 *
 * `allocate` is the token-budget write (billing `POST /api/budget/topup/{id}`,
 * `source='topup'`), returning the new budget id.
 */
export async function topUpBudget(
  intent: TopUpIntent,
  deps: {
    allocate: (intent: TopUpIntent) => Promise<{ budgetId: string }>;
  },
): Promise<AllocatedTopUp> {
  const settlement = getSettlement();
  const settled = await settlement.settle(intent);
  if (!settled.paid) {
    throw new IntegrationError({
      code: 'PAYMENT_REQUIRED',
      message: `top-up not settled: ${settled.error ?? 'payment failed'}`,
      service: 'billing-topup',
      method: 'settle',
      path: '/topup',
    });
  }
  const { budgetId } = await deps.allocate(intent);
  return {
    budgetId,
    tokens: intent.tokens,
    packageId: intent.packageId,
    paymentRef: settled.ref,
    paymentStatus: settled.status,
  };
}
