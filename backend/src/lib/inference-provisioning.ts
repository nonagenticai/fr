// src/lib/inference-provisioning.ts
//
// The owner's per-tenant inference decision (PLAN tenant-inference-provisioning
// §1.0 ruling 1, §2.6, §3.3). George 2026-10-02: "when i provision them, I
// DECIDE on the provision form WHAT llm they get access to and HOW they will be
// setup." This module is the ONE shape that decision travels in through fr:
//
//   * `inferenceInputSchema` — what the provision form / the tenant edit view
//     may send (zod, strict). Setup- and flag-dependent refusals live here so a
//     refused request never reaches a side effect.
//   * `buildApplyRequest` — that input → provisioning
//     `POST /api/tenants/{t}/inference/apply` body (policy doc schema v1).
//   * `normaliseApplyResult` — provisioning's answer → what fr returns. A smoke
//     tier is `verified` ONLY when provisioning says its IR ledger read-back
//     matched (`verified === true`); an HTTP 200 alone is never proof.
//   * `redactInferenceForAudit` — the audit-row form: no key material, ever.
//
// fr is config + UI only (ruling 2). It never stores a key, never prices, never
// validates the doc authoritatively — IR does (§3.3 "IR is authoritative").
//
// Gate 1a scope: setup 1 (`local`) end to end. Setup 2 (`owner_commercial`) is
// refused unless FR_SETUP2_ENABLED (and provisioning refuses it 409 until IR's
// runaway breakers are armed). Setup 3 (`byo`) is refused outright until IR gate
// 1b ships BYO key custody — there is no credentials API to put a key into yet,
// so accepting one here could only mean holding it, which fr must never do.
//
// Lives in lib/ (not integrations/): it is pure shape + the flag read, with no
// upstream I/O of its own.

import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { extractBearerToken } from '../utils/extract-bearer';
import { verifiedSuperAdminPortalToken } from '../middleware/request-context';
import {
  __installInferenceConfigFlags,
  type BudgetCurrency,
  type ByoMode,
  type InferenceInput,
  type InferenceSetup,
  type InferenceTier,
  PAYMENT_TERMS_DEFAULT,
} from './inference-input-schema';

// The input schema, its constants and the flag read live in ./inference-input-schema.ts
// (side-effect free, shared with the provision-user capability declaration); this
// module installs the config-backed flag source and re-exports them unchanged.
export {
  INFERENCE_SETUPS,
  BYO_MODES,
  INFERENCE_TIERS,
  PLATFORM_PROVIDER,
  PLATFORM_MODEL,
  MAX_BUDGET_AMOUNT,
  BUDGET_CURRENCIES,
  PAYMENT_TERMS_DEFAULT,
  PAYMENT_TERMS_BACKLOG,
  SETUP_UNAVAILABLE,
  __installInferenceConfigFlags,
  inferenceFlags,
  InferenceInputSchema,
  type InferenceSetup,
  type ByoMode,
  type InferenceTier,
  type BudgetCurrency,
  type InferenceFlags,
  type InferenceInput,
} from './inference-input-schema';

__installInferenceConfigFlags(() => ({
  enabled: config.inferenceProvisioning.enabled,
  setup2Enabled: config.inferenceProvisioning.setup2Enabled,
}));

// --- provisioning apply contract (PLAN §3.4; provisioning a5503f4) --------

export interface ApplyPolicyHop {
  target: { kind: 'platform' | 'owner' | 'byo'; provider: string };
  model: string;
  failover_on_error: boolean;
  failover_on_validation: boolean;
}

export interface ApplyRequest {
  idempotency_key: string;
  byo_mode: ByoMode;
  budget: { amount: number; currency: BudgetCurrency };
  markup: { provider: string; model: string; pct: string }[];
  policy: {
    schema: 1;
    setup: InferenceSetup;
    byo_mode: ByoMode;
    tiers: Partial<Record<InferenceTier, ApplyPolicyHop[]>>;
    tier_inheritance: 'nearest_larger_then_smaller';
    cascade: { enabled: false };
    limits?: NonNullable<InferenceInput['limits']>;
  };
}

/**
 * A fresh key per owner action. Provisioning's pattern is
 * `^[A-Za-z0-9._:-]+$`, 8..255. A NEW key per submission is deliberate: an
 * edit must reach IR (same doc → IR answers `unchanged`, same version, no second
 * budget), and "Re-run checks" must actually re-run the smoke rather than
 * replay a stored result.
 */
export function newApplyIdempotencyKey(tenantId: string): string {
  return `tia-${tenantId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}-${randomUUID()}`;
}

/** The input → provisioning's apply body. Pure. Carries no key material. */
export function buildApplyRequest(input: InferenceInput, idempotencyKey: string): ApplyRequest {
  const tiers: Partial<Record<InferenceTier, ApplyPolicyHop[]>> = {};
  for (const t of input.tiers) {
    tiers[t.tier] = t.hops.map((h) => ({
      target: { kind: h.kind, provider: h.provider },
      model: h.model,
      failover_on_error: true,
      failover_on_validation: false,
    }));
  }
  return {
    idempotency_key: idempotencyKey,
    byo_mode: input.byo_mode,
    budget: { amount: input.budget_amount, currency: input.budget_currency },
    markup: input.markup.map((m) => ({ provider: m.provider, model: m.model, pct: m.pct.toFixed(2) })),
    policy: {
      schema: 1,
      setup: input.setup,
      byo_mode: input.byo_mode,
      tiers,
      tier_inheritance: 'nearest_larger_then_smaller',
      cascade: { enabled: false },
      ...(input.limits && Object.keys(input.limits).length > 0 ? { limits: input.limits } : {}),
    },
  };
}

// --- result -----------------------------------------------------------------

export interface InferenceStep {
  name: string;
  status: 'ok' | 'skipped' | 'failed';
  detail: Record<string, unknown>;
}

export interface InferenceSmoke {
  tier: string;
  served_provider: string | null;
  policy_version: number | null;
  llm_setup: number | null;
  key_owner: string | null;
  /** True ONLY when provisioning reported the IR ledger read-back matched. */
  verified: boolean;
}

export interface InferenceOutcome {
  /**
   * `success` / `partial` — provisioning's own verdict (a partial names its
   * failed step; re-apply resumes). `failed` — the apply call itself did not
   * complete (refused or unreachable); `error` says why. The seats provisioned
   * before it are NOT rolled back.
   */
  status: 'success' | 'partial' | 'failed';
  policy_version: number | null;
  idempotency_key: string;
  replayed: boolean;
  steps: InferenceStep[];
  smoke: InferenceSmoke[];
  error?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Provisioning's 200 body → fr's outcome. Strict about `verified`. */
export function normaliseApplyResult(raw: unknown, idempotencyKey: string): InferenceOutcome {
  const r = asRecord(raw);
  const status = r.status === 'success' ? 'success' : 'partial';
  const steps: InferenceStep[] = (Array.isArray(r.steps) ? r.steps : []).map((s) => {
    const o = asRecord(s);
    const st = o.status === 'ok' || o.status === 'skipped' ? o.status : 'failed';
    return { name: String(o.name ?? ''), status: st, detail: asRecord(o.detail) };
  });
  const smoke: InferenceSmoke[] = (Array.isArray(r.smoke) ? r.smoke : []).map((s) => {
    const o = asRecord(s);
    return {
      tier: String(o.tier ?? ''),
      served_provider: strOrNull(o.served_provider),
      policy_version: numOrNull(o.policy_version),
      llm_setup: numOrNull(o.llm_setup),
      key_owner: strOrNull(o.key_owner),
      verified: o.verified === true,
    };
  });
  return {
    status,
    policy_version: numOrNull(r.policy_version),
    idempotency_key: typeof r.idempotency_key === 'string' ? r.idempotency_key : idempotencyKey,
    replayed: r.replayed === true,
    steps,
    smoke,
  };
}

// --- audit ------------------------------------------------------------------

/**
 * The inference block as it may be written to `provisioning_audit.payload`:
 * every BYO key reduced to its provider name. Defence in depth — setup 3 is
 * refused before any audit row opens today, but the audit write must not depend
 * on that refusal staying in place.
 */
export function redactInferenceForAudit(input: InferenceInput): Record<string, unknown> {
  const { byo_keys, ...rest } = input;
  return {
    ...rest,
    payment_terms: input.payment_terms ?? PAYMENT_TERMS_DEFAULT,
    byo_keys: byo_keys.map((k) => ({ provider: k.provider })),
  };
}

/** The outcome as it may be written to `provisioning_audit.result` (ids + verdicts only). */
export function inferenceOutcomeForAudit(o: InferenceOutcome): Record<string, unknown> {
  return {
    status: o.status,
    policy_version: o.policy_version,
    idempotency_key: o.idempotency_key,
    steps: o.steps.map((s) => ({ name: s.name, status: s.status })),
    smoke: o.smoke,
    ...(o.error ? { error: o.error } : {}),
  };
}

// --- the owner's portal JWT (forwarded, never kept) --------------------------

/**
 * The calling owner's OWN verified portal token: RS256-verified, human (not a
 * service account / fr-agent token), signed `super_admin`. Provisioning relays
 * it to IR as `X-Forwarded-User-Authorization`; IR authorises that human.
 * `undefined` = this caller cannot drive an inference apply (403, before any
 * side effect).
 */
export function ownerPortalToken(req: Request): Promise<string | undefined> {
  return verifiedSuperAdminPortalToken(extractBearerToken(req) ?? undefined);
}
