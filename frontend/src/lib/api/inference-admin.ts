// src/lib/api/inference-admin.ts
//
// Typed client for the owner's tenant INFERENCE surface (PLAN
// tenant-inference-provisioning §2.6). Mirrors
// backend/src/routes/admin/tenant-inference.ts and
// backend/src/lib/inference-provisioning.ts — keep in sync.
//
//   GET  /api/admin/inference/config                             → {data: InferenceConfig}
//   GET  /api/admin/tenants/:t/inference-policy                  → {data: TenantInferencePolicy}
//   POST /api/admin/tenants/:t/inference/apply   InferenceInput  → {data: InferenceOutcome}
//   POST /api/admin/tenants/:t/inference-policy/activate {version} → {data: {active_version}}
//
// All super-admin only (backend-gated on the verified realm role). The tenant
// routes 404 while FR_INFERENCE_PROVISIONING is off.

import { authFetch } from './auth-fetch';
import { errorDetailOf } from './error-detail';

export type InferenceSetup = 'local' | 'owner_commercial' | 'byo';
export type ByoMode = 'local_allowed' | 'byo_required' | 'platform_only';
export type InferenceTier = 'small' | 'medium' | 'high';
export type BudgetCurrency = 'EUR' | 'USD' | 'CAD';
export type PaymentTerm = 'prepaid' | 'postpaid';

export interface InferenceHop {
  kind: 'platform' | 'owner' | 'byo';
  provider: string;
  model: string;
}

/** The inference block of a provision request / the body of an apply. */
export interface InferenceInput {
  setup: InferenceSetup;
  tiers: { tier: InferenceTier; hops: InferenceHop[] }[];
  byo_mode: ByoMode;
  /** Whole units of `budget_currency`. */
  budget_amount: number;
  budget_currency: BudgetCurrency;
  markup?: { provider: string; model: string; pct: number }[];
  /**
   * Modelled, not selectable (billing-service#247): the backend accepts only
   * the defaults and never forwards them. Omitted by the form today.
   */
  payment_terms?: { budget: PaymentTerm; markup: PaymentTerm; fees: PaymentTerm };
}

export interface InferenceConfig {
  enabled: boolean;
  setup2_enabled: boolean;
  setups: { setup: InferenceSetup; available: boolean; reason: string | null }[];
}

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
  /** True ONLY when provisioning's IR ledger read-back matched. */
  verified: boolean;
}

export interface InferenceOutcome {
  status: 'success' | 'partial' | 'failed';
  policy_version: number | null;
  idempotency_key: string;
  replayed: boolean;
  steps: InferenceStep[];
  smoke: InferenceSmoke[];
  error?: string;
}

export interface TenantInferencePolicy {
  active_version: number | null;
  doc: Record<string, unknown> | null;
  versions: { version: number; created_at: string; actor_kind: string }[];
}

async function fail(label: string, r: Response): Promise<never> {
  const detail = await errorDetailOf(r);
  throw new Error(`${label}: ${r.status}${detail ? ` — ${detail}` : ''}`);
}

async function data<T>(label: string, r: Response): Promise<T> {
  if (!r.ok) return fail(label, r);
  const body = (await r.json()) as { data: T };
  return body.data;
}

export async function getInferenceConfig(): Promise<InferenceConfig> {
  return data<InferenceConfig>('inference config', await authFetch('/api/admin/inference/config'));
}

export async function getTenantInferencePolicy(tenantId: string): Promise<TenantInferencePolicy> {
  return data<TenantInferencePolicy>(
    'inference policy',
    await authFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}/inference-policy`),
  );
}

export async function applyTenantInference(
  tenantId: string,
  input: InferenceInput,
): Promise<InferenceOutcome> {
  return data<InferenceOutcome>(
    'apply inference',
    await authFetch(`/api/admin/tenants/${encodeURIComponent(tenantId)}/inference/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function activateTenantInferenceVersion(
  tenantId: string,
  version: number,
): Promise<{ active_version: number }> {
  return data<{ active_version: number }>(
    'activate inference version',
    await authFetch(
      `/api/admin/tenants/${encodeURIComponent(tenantId)}/inference-policy/activate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      },
    ),
  );
}
