// src/lib/components/inference/inference-form.ts
//
// The owner's inference decision as a FORM DRAFT, and the one place a draft
// becomes the wire `InferenceInput` (PLAN tenant-inference-provisioning §2.6).
// Pure functions so the rules are unit-tested rather than template branches.
//
// George 2026-10-02: "when i provision them, I DECIDE on the provision form
// WHAT llm they get access to and HOW they will be setup."
//
//   setup 1 `local`            — ONE tier, locked to "Non-Agentic AI local" (local-llm).
//   setup 2 `owner_commercial` — owner keys, markup % per provider×model.
//                                Visible but disabled until spend breakers are live.
//   setup 3 `byo`              — the customer's own keys.
//                                Visible but disabled until BYO key custody ships.
//
// The backend re-validates everything (zod), and IR is authoritative for the
// doc; these checks only stop the owner submitting something certain to bounce.

import type {
  BudgetCurrency,
  ByoMode,
  InferenceConfig,
  InferenceInput,
  InferenceSetup,
  InferenceTier,
} from '$lib/api/inference-admin';

export const PLATFORM_PROVIDER = 'pgx-local';
export const PLATFORM_MODEL = 'local-llm';
export const LOCAL_TIER_LABEL = 'Non-Agentic AI local';
export const MAX_BUDGET_AMOUNT = 1_000_000;

/** Owner ruling 2026-10-02 (PLAN rev F): the budget currency is a select. */
export const BUDGET_CURRENCIES: BudgetCurrency[] = ['EUR', 'USD', 'CAD'];

/** Shown when an EDIT changes the tenant's budget currency (owner-only confirm). */
export const CURRENCY_CHANGE_CONFIRM = 'Remaining budget converts at today’s FX rate.';

/**
 * Pre-paid / post-paid per line item — MODELLED, rendered read-only ("coming
 * soon") until billing-service#247. Defaults: budget pre-paid; markup and fees
 * post-paid. The form does not send them; the backend accepts only these.
 */
export const PAYMENT_TERMS_BACKLOG = 'billing-service#247';
export const PAYMENT_TERM_LINES: { line: 'budget' | 'markup' | 'fees'; label: string; term: 'prepaid' | 'postpaid' }[] = [
  { line: 'budget', label: 'Budget', term: 'prepaid' },
  { line: 'markup', label: 'Markup', term: 'postpaid' },
  { line: 'fees', label: 'Fees', term: 'postpaid' },
];

export const TIERS: InferenceTier[] = ['small', 'medium', 'high'];

export const BYO_MODE_OPTIONS: { value: ByoMode; label: string }[] = [
  { value: 'local_allowed', label: 'local_allowed — local-llm, and BYO where configured' },
  { value: 'byo_required', label: 'byo_required — the tenant’s own keys only' },
  { value: 'platform_only', label: 'platform_only — platform inference only, BYO refused' },
];

export const SETUP_LABELS: Record<InferenceSetup, { title: string; body: string }> = {
  local: {
    title: 'Setup 1 — Non-Agentic AI local',
    body: 'One tier on local-llm (pgx). No commercial keys, no paid failover.',
  },
  owner_commercial: {
    title: 'Setup 2 — Owner commercial keys',
    body: 'Up to three tiers on the owner’s commercial providers, billed with a markup %.',
  },
  byo: {
    title: 'Setup 3 — Customer’s own keys (BYO)',
    body: 'Up to three tiers on the tenant’s own provider keys, billed with a markup % (may be 0).',
  },
};

/** Fallback reasons, used only when the config probe did not supply one. */
export const SETUP_UNAVAILABLE_REASON: Record<Exclude<InferenceSetup, 'local'>, string> = {
  owner_commercial: 'available after spend breakers are live',
  byo: 'available after BYO key custody ships',
};

export interface OwnerTierDraft {
  tier: InferenceTier;
  provider: string;
  model: string;
  /** Markup %, as typed. */
  pct: string;
}

export interface InferenceDraft {
  setup: InferenceSetup;
  /** Setup 1's single tier. */
  tier: InferenceTier;
  byo_mode: ByoMode;
  /** Whole units, as typed (a number input may hand back '' or a number). */
  budget_amount: string | number;
  budget_currency: BudgetCurrency;
  /** Setups 2/3 only. */
  tiers: OwnerTierDraft[];
}

export function emptyOwnerTier(tier: InferenceTier = 'medium'): OwnerTierDraft {
  return { tier, provider: '', model: '', pct: '' };
}

export function emptyInferenceDraft(): InferenceDraft {
  return {
    setup: 'local',
    tier: 'medium',
    // Owner ruling 2026-10-15 (licenses#273): new tenants default to
    // byo_required; local_allowed must be picked explicitly.
    byo_mode: 'byo_required',
    budget_amount: '',
    budget_currency: 'EUR',
    tiers: [emptyOwnerTier()],
  };
}

export interface SetupOption {
  setup: InferenceSetup;
  title: string;
  body: string;
  available: boolean;
  /** Why it cannot be chosen; null when available. */
  reason: string | null;
}

/** The three setups, always all visible, with availability from the config probe. */
export function setupOptions(config: InferenceConfig | null): SetupOption[] {
  return (['local', 'owner_commercial', 'byo'] as InferenceSetup[]).map((setup) => {
    const probe = config?.setups.find((s) => s.setup === setup);
    const available = setup === 'local' ? true : probe?.available === true;
    const reason = available
      ? null
      : (probe?.reason ?? SETUP_UNAVAILABLE_REASON[setup as Exclude<InferenceSetup, 'local'>]);
    return { setup, ...SETUP_LABELS[setup], available, reason };
  });
}

/** Whether markup fields apply to this setup (never setup 1). */
export function setupHasMarkup(setup: InferenceSetup): boolean {
  return setup !== 'local';
}

export type PayloadResult = { ok: true; input: InferenceInput } | { ok: false; error: string };

function parseBudget(raw: string | number): number | null {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= MAX_BUDGET_AMOUNT ? n : null;
}

function parsePct(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 1000 ? n : null;
}

/** Draft → wire input, or the first thing the owner must fix. */
export function inferencePayload(draft: InferenceDraft, config: InferenceConfig | null): PayloadResult {
  const option = setupOptions(config).find((o) => o.setup === draft.setup);
  if (!option || !option.available) {
    return {
      ok: false,
      error: `${SETUP_LABELS[draft.setup]?.title ?? draft.setup} is not available yet (${option?.reason ?? 'unavailable'}).`,
    };
  }
  const budget = parseBudget(draft.budget_amount);
  if (budget === null) {
    return {
      ok: false,
      error: `Budget must be a whole number of ${draft.budget_currency} between 0 and ${MAX_BUDGET_AMOUNT.toLocaleString('en-US')}.`,
    };
  }
  if (!BUDGET_CURRENCIES.includes(draft.budget_currency)) {
    return { ok: false, error: `Unknown budget currency ${String(draft.budget_currency)}.` };
  }

  if (draft.setup === 'local') {
    return {
      ok: true,
      input: {
        setup: 'local',
        tiers: [{ tier: draft.tier, hops: [{ kind: 'platform', provider: PLATFORM_PROVIDER, model: PLATFORM_MODEL }] }],
        byo_mode: draft.byo_mode,
        budget_amount: budget,
        budget_currency: draft.budget_currency,
      },
    };
  }

  // Setups 2/3 (only reachable once the config probe says available).
  if (draft.tiers.length < 1 || draft.tiers.length > 3) {
    return { ok: false, error: 'Configure one to three tiers.' };
  }
  const seenTiers = new Set<string>();
  const markup = new Map<string, { provider: string; model: string; pct: number }>();
  const kind = draft.setup === 'owner_commercial' ? 'owner' : 'byo';
  for (const t of draft.tiers) {
    if (seenTiers.has(t.tier)) return { ok: false, error: `Tier ${t.tier} is listed twice.` };
    seenTiers.add(t.tier);
    const provider = t.provider.trim();
    const model = t.model.trim();
    if (!provider || !model) return { ok: false, error: `Tier ${t.tier} needs a provider and a model.` };
    const pct = parsePct(t.pct);
    if (pct === null) return { ok: false, error: `Tier ${t.tier} needs a markup % (≥ 0, at most 2 decimals).` };
    const k = `${provider}\u0000${model}`;
    const prior = markup.get(k);
    if (prior && prior.pct !== pct) {
      return { ok: false, error: `${provider}/${model} has two different markup %s.` };
    }
    markup.set(k, { provider, model, pct });
  }
  return {
    ok: true,
    input: {
      setup: draft.setup,
      tiers: draft.tiers.map((t) => ({
        tier: t.tier,
        hops: [{ kind, provider: t.provider.trim(), model: t.model.trim() }],
      })),
      byo_mode: draft.byo_mode,
      budget_amount: budget,
      budget_currency: draft.budget_currency,
      markup: [...markup.values()],
    },
  };
}

function isTier(v: unknown): v is InferenceTier {
  return v === 'small' || v === 'medium' || v === 'high';
}
function isByoMode(v: unknown): v is ByoMode {
  return v === 'local_allowed' || v === 'byo_required' || v === 'platform_only';
}
function isSetup(v: unknown): v is InferenceSetup {
  return v === 'local' || v === 'owner_commercial' || v === 'byo';
}

/**
 * The active IR policy doc → an edit draft. Budget and markup live in billing,
 * not in the doc (§3.3), so the budget starts EMPTY and the owner re-states it:
 * an edit re-applies the money budget, and pre-filling a guess would silently
 * re-write it.
 */
export function draftFromPolicy(
  doc: Record<string, unknown> | null,
  currentCurrency?: string | null,
): InferenceDraft {
  const draft = emptyInferenceDraft();
  if (currentCurrency && (BUDGET_CURRENCIES as string[]).includes(currentCurrency)) {
    draft.budget_currency = currentCurrency as BudgetCurrency;
  }
  if (!doc) return draft;
  if (isSetup(doc.setup)) draft.setup = doc.setup;
  if (isByoMode(doc.byo_mode)) draft.byo_mode = doc.byo_mode;
  const tiers = doc.tiers && typeof doc.tiers === 'object' ? (doc.tiers as Record<string, unknown>) : {};
  const keys = Object.keys(tiers).filter(isTier);
  if (draft.setup === 'local') {
    if (keys[0]) draft.tier = keys[0];
  } else if (keys.length > 0) {
    draft.tiers = keys.map((tier) => {
      const hops = Array.isArray(tiers[tier]) ? (tiers[tier] as Record<string, unknown>[]) : [];
      const first = hops[0] ?? {};
      const target = (first.target ?? {}) as Record<string, unknown>;
      return {
        tier,
        provider: typeof target.provider === 'string' ? target.provider : '',
        model: typeof first.model === 'string' ? first.model : '',
        pct: '',
      };
    });
  }
  return draft;
}

/**
 * Whether applying `draft` changes the tenant's budget currency, and so needs
 * the owner's explicit confirm. `unknown` when the current currency could not
 * be read — the caller confirms then too, rather than assume "no change".
 */
export function currencyChange(
  draft: InferenceDraft,
  currentCurrency: string | null | undefined,
): 'none' | 'changed' | 'unknown' {
  if (!currentCurrency) return 'unknown';
  return currentCurrency === draft.budget_currency ? 'none' : 'changed';
}
