// src/lib/inference-input-schema.ts
//
// The INPUT half of lib/inference-provisioning.ts — the inference block a
// provision request (and the tenant edit view's apply) may send, its constants
// and the flag read its refusals depend on — moved verbatim (fr-agui P4c part 3)
// so the provision-user capability declaration can describe the SAME schema.
// Side-effect free: zod only (the config-backed flag source is installed by
// lib/inference-provisioning.ts, which re-exports everything here).

import { z } from 'zod';

export const INFERENCE_SETUPS = ['local', 'owner_commercial', 'byo'] as const;
export type InferenceSetup = (typeof INFERENCE_SETUPS)[number];

export const BYO_MODES = ['local_allowed', 'byo_required', 'platform_only'] as const;
export type ByoMode = (typeof BYO_MODES)[number];

export const INFERENCE_TIERS = ['small', 'medium', 'high'] as const;
export type InferenceTier = (typeof INFERENCE_TIERS)[number];

/** The ONLY platform target a customer tier may name (ruling 7: local-llm only). */
export const PLATFORM_PROVIDER = 'pgx-local';
export const PLATFORM_MODEL = 'local-llm';

/** Upper bound on the budget amount (§2.6: int 0..1e6), in its own currency. */
export const MAX_BUDGET_AMOUNT = 1_000_000;

/**
 * The budget currencies the owner may pick (owner ruling 2026-10-02, PLAN rev F:
 * "a select of EUR, USD or CAD"). The amount is a whole number in that currency.
 *
 * ⚠️ Counterpart support, measured, not assumed: provisioning a5503f4
 * (`ProvisionRequest.budget_currency`, `InferenceBudget.currency`) and billing
 * main (`models/domain.py`) are `Literal["EUR"]` today, so USD/CAD are refused
 * there (422 on the first seat call, before anything is minted) until those
 * lanes widen. fr sends the owner's choice verbatim and does not pretend.
 */
export const BUDGET_CURRENCIES = ['EUR', 'USD', 'CAD'] as const;
export type BudgetCurrency = (typeof BUDGET_CURRENCIES)[number];

/**
 * Pre-paid / post-paid per line item (owner ruling 2026-10-02): MODELLED, not
 * selectable. Defaults: the budget is pre-paid; markup and fees are post-paid.
 * Anything else is refused until billing-service#247 ships the settlement side.
 * Never forwarded to provisioning (its apply body is `extra=forbid`).
 */
export const PAYMENT_TERMS_DEFAULT = {
  budget: 'prepaid',
  markup: 'postpaid',
  fees: 'postpaid',
} as const;
export const PAYMENT_TERMS_BACKLOG = 'billing-service#247';

/**
 * Why setups 2 and 3 are not selectable today. The `code` matches what
 * provisioning answers with a 409 for the same refusal, so the operator reads
 * one vocabulary whichever layer refused.
 */
export const SETUP_UNAVAILABLE: Record<
  Exclude<InferenceSetup, 'local'>,
  { code: string; reason: string }
> = {
  owner_commercial: {
    code: 'setup2_disabled',
    reason: 'available after spend breakers are live',
  },
  byo: {
    code: 'setup3_not_yet_available',
    reason: 'available after BYO key custody ships',
  },
};

// --- flags -----------------------------------------------------------------

export interface InferenceFlags {
  /** FR_INFERENCE_PROVISIONING */
  enabled: boolean;
  /** FR_SETUP2_ENABLED */
  setup2Enabled: boolean;
}

/**
 * The config-backed flag source. It reads `config`, which this module must not
 * import (side-effect free: the capability declarations import it), so
 * lib/inference-provisioning.ts installs it at its own import — and every route
 * that parses this schema (super-admin provision-user, the tenant inference
 * apply) imports that module. Until it is installed both flags read OFF
 * (fail-closed: the inference block is refused, setup 2 is refused).
 */
let configFlags = (): InferenceFlags => ({ enabled: false, setup2Enabled: false });
export function __installInferenceConfigFlags(source: () => InferenceFlags): void {
  configFlags = source;
}

/** The flags as they stand for THIS request (read at call time, not import time). */
export function inferenceFlags(): InferenceFlags {
  return configFlags();
}

// --- input schema ---------------------------------------------------------

const HopSchema = z
  .object({
    kind: z.enum(['platform', 'owner', 'byo']),
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
  })
  .strict();

const TierSchema = z
  .object({
    tier: z.enum(INFERENCE_TIERS),
    hops: z.array(HopSchema).min(1).max(3),
  })
  .strict();

/** A percentage with at most 2 decimals, ≥ 0 (setup 3 may be 0). */
const PctSchema = z
  .number()
  .finite()
  .min(0)
  .max(1000)
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-9, {
    message: 'markup pct allows at most 2 decimals',
  });

const MarkupSchema = z
  .object({
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
    pct: PctSchema,
  })
  .strict();

/**
 * Write-only BYO key material. Declared so a request carrying it is parsed (and
 * then REFUSED while setup 3 is unavailable) rather than tripping an
 * unrecognised-key error that would echo nothing useful. Never stored, never
 * audited, never returned — see `redactInferenceForAudit`.
 */
const ByoKeySchema = z
  .object({
    provider: z.string().min(1).max(64),
    api_key: z.string().min(1).max(4096),
    base_url: z.string().url().max(2048).optional(),
  })
  .strict();

const DecimalString = z.string().regex(/^\d{1,7}(\.\d{1,4})?$/, 'a non-negative decimal');

const LimitsSchema = z
  .object({
    rpm: z.number().int().min(1).optional(),
    max_concurrency: z.number().int().min(1).optional(),
    caller_rpm: z.number().int().min(1).optional(),
    eur_per_minute: DecimalString.optional(),
    eur_per_hour: DecimalString.optional(),
    loop_threshold: z.number().int().min(1).optional(),
    loop_window_s: z.number().int().min(1).optional(),
    max_hops: z.number().int().min(1).max(3).optional(),
    max_cost_eur_per_request: DecimalString.optional(),
  })
  .strict();

/**
 * The inference block of a provision request (and the body of the tenant edit
 * view's apply). Flag-dependent refusals read `inferenceFlags()` AT PARSE TIME.
 */
export const InferenceInputSchema = z
  .object({
    setup: z.enum(INFERENCE_SETUPS),
    tiers: z.array(TierSchema).min(1).max(3),
    // Explicit, never derived from the tiers (ruling 1). Default byo_required
    // (owner ruling 2026-10-15, licenses#273): new tenants bring their own keys;
    // platform GPU (local_allowed) is an explicit owner choice, never a fallback.
    byo_mode: z.enum(BYO_MODES).default('byo_required'),
    // Whole units of `budget_currency`. `.int()` refuses 10.5.
    budget_amount: z.number().int().min(0).max(MAX_BUDGET_AMOUNT),
    budget_currency: z.enum(BUDGET_CURRENCIES).default('EUR'),
    // Modelled, not selectable yet (see PAYMENT_TERMS_DEFAULT).
    payment_terms: z
      .object({
        budget: z.enum(['prepaid', 'postpaid']),
        markup: z.enum(['prepaid', 'postpaid']),
        fees: z.enum(['prepaid', 'postpaid']),
      })
      .strict()
      .optional(),
    markup: z.array(MarkupSchema).max(50).default([]),
    byo_keys: z.array(ByoKeySchema).max(9).default([]),
    limits: LimitsSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      input.payment_terms &&
      (Object.keys(PAYMENT_TERMS_DEFAULT) as (keyof typeof PAYMENT_TERMS_DEFAULT)[]).some(
        (k) => input.payment_terms![k] !== PAYMENT_TERMS_DEFAULT[k],
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payment_terms'],
        message: `payment terms are not selectable yet (${PAYMENT_TERMS_BACKLOG}): budget is pre-paid, markup and fees post-paid`,
      });
    }
    const seen = new Set<string>();
    input.tiers.forEach((t, i) => {
      if (seen.has(t.tier)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tiers', i, 'tier'], message: `tier ${t.tier} is listed twice` });
      }
      seen.add(t.tier);
    });
    const pairs = new Set<string>();
    input.markup.forEach((m, i) => {
      const k = `${m.provider}\u0000${m.model}`;
      if (pairs.has(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['markup', i], message: 'duplicate provider/model markup entry' });
      }
      pairs.add(k);
    });

    if (input.setup === 'local') {
      if (input.tiers.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tiers'],
          message: 'setup local has exactly one tier (no paid failover)',
        });
      }
      input.tiers.forEach((t, i) =>
        t.hops.forEach((h, j) => {
          if (h.kind !== 'platform' || h.provider !== PLATFORM_PROVIDER || h.model !== PLATFORM_MODEL) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['tiers', i, 'hops', j],
              message: `setup local hops are ${PLATFORM_PROVIDER}/${PLATFORM_MODEL} only`,
            });
          }
        }),
      );
      if (input.markup.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['markup'], message: 'markup applies to setups 2 and 3 only' });
      }
      if (input.byo_keys.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['byo_keys'], message: 'keys apply to setup 3 only' });
      }
      return;
    }

    if (input.setup === 'owner_commercial') {
      if (!inferenceFlags().setup2Enabled) {
        const u = SETUP_UNAVAILABLE.owner_commercial;
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['setup'], message: `${u.code}: setup 2 is ${u.reason}` });
        return;
      }
      if (input.byo_keys.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['byo_keys'], message: 'keys apply to setup 3 only' });
      }
      const priced = new Set(input.markup.map((m) => `${m.provider}\u0000${m.model}`));
      input.tiers.forEach((t, i) =>
        t.hops.forEach((h, j) => {
          if (h.kind === 'byo') {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tiers', i, 'hops', j, 'kind'], message: 'setup 2 hops are owner or platform' });
          }
          if (h.kind === 'platform' && (h.provider !== PLATFORM_PROVIDER || h.model !== PLATFORM_MODEL)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tiers', i, 'hops', j], message: `platform hops are ${PLATFORM_PROVIDER}/${PLATFORM_MODEL} only` });
          }
          if (h.kind === 'owner' && !priced.has(`${h.provider}\u0000${h.model}`)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['markup'], message: `no markup % for ${h.provider}/${h.model}` });
          }
        }),
      );
      return;
    }

    // setup === 'byo'
    const u = SETUP_UNAVAILABLE.byo;
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['setup'], message: `${u.code}: setup 3 is ${u.reason}` });
  });

export type InferenceInput = z.infer<typeof InferenceInputSchema>;
