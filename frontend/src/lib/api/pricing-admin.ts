// src/lib/api/pricing-admin.ts
//
// Typed client for the fr backend's super-admin pricing-management surface,
// which proxies billing-service's pricing config API.
//
// Wire contracts (mirror backend/src/routes/settings/pricing-admin.ts):
//   GET  /api/admin/pricing/provider-pricing   → { data: ProviderPricingRow[] }
//   POST /api/admin/pricing/provider-pricing    → 201 { data: ProviderPricingRow }
//   GET  /api/admin/pricing/markup-rules       → { data: MarkupRuleRow[] }
//   POST /api/admin/pricing/markup-rules        → 201 { data: MarkupRuleRow }
// Each POST is an upsert: billing closes the prior open row for the match-tuple
// and opens a new effective-dated row (audit-logged on the billing side).
//
// Auth: every call goes through `authFetch` (attaches the Keycloak access token
// as Bearer). Super-admin only — gated on the backend. Run client-side after
// the auth store hydrates, never from SSR `load()`.

import { apiErrorMessage } from './api-error';
import { authFetch } from './auth-fetch';

/** A provider_pricing row (billing schema, passed through verbatim). */
export interface ProviderPricingRow {
  id: number;
  provider: string;
  model: string | null;
  service_key: string | null;
  // 'cost' = internal authoritative rate; 'list' = public provider list price
  // (used only for the read-time BYO estimate).
  rate_class: string;
  cost_model: string;
  input_per_1m_usd: string | null;
  output_per_1m_usd: string | null;
  cache_creation_per_1m_usd: string | null;
  cache_read_per_1m_usd: string | null;
  per_request_usd: string | null;
  monthly_fixed_cost_usd: string | null;
  effective_from: string;
  effective_until: string | null;
  notes: string | null;
}

/** Upsert body for provider_pricing (Decimal fields as strings). */
export interface ProviderPricingInput {
  provider: string;
  model?: string | null;
  service_key?: string | null;
  rate_class?: 'cost' | 'list'; // defaults to 'cost' upstream
  cost_model: string; // per_token | per_request | self_hosted_amortized
  input_per_1m_usd?: string | null;
  output_per_1m_usd?: string | null;
  cache_creation_per_1m_usd?: string | null;
  cache_read_per_1m_usd?: string | null;
  per_request_usd?: string | null;
  monthly_fixed_cost_usd?: string | null;
  notes?: string | null;
}

/** A markup_rule row (billing schema, passed through verbatim). */
export interface MarkupRuleRow {
  id: number;
  tenant_id: string | null;
  license_id: string | null;
  service_key: string | null;
  provider: string | null;
  model: string | null;
  markup_pct: string | null;
  surcharge_input_per_1m_usd: string | null;
  surcharge_output_per_1m_usd: string | null;
  surcharge_per_request_usd: string | null;
  effective_from: string;
  effective_until: string | null;
  notes: string | null;
}

export interface MarkupRuleInput {
  tenant_id?: string | null;
  license_id?: string | null;
  service_key?: string | null;
  provider?: string | null;
  model?: string | null;
  markup_pct?: string | null;
  surcharge_input_per_1m_usd?: string | null;
  surcharge_output_per_1m_usd?: string | null;
  // NB: no `surcharge_per_request_usd` — billing returns it on a row (see
  // MarkupRuleRow) but nothing on this side ever sent it: the form has no such
  // input and cleanMarkup() never forwarded it. Dead input surface, removed.
  notes?: string | null;
  /**
   * Set ONLY on a deliberately global (tenant-less) rule. A rule with no
   * `tenant_id` prices every tenant, and "no tenant was picked" used to be the
   * same bytes as "every tenant is meant" — so fr's route now refuses a global
   * rule that does not carry this (400, naming the field). It is fr's own
   * contract: the route strips it before the billing hop, so it never reaches
   * billing's schema. See `backend/src/routes/settings/pricing-admin.ts`
   * § GLOBAL SCOPE.
   */
  global_scope_acknowledged?: boolean;
}

/**
 * Billing rejects a markup rule that sets no economic field with a 422 —
 * `MarkupRuleCreate._require_an_economic_field` (billing_service/src/models/
 * domain.py), because such a rule closes the currently-open rule for the same
 * match tuple while pricing nothing.
 *
 * Null/empty check, NOT truthiness: a markup of `'0'` is an explicit "charge
 * nothing" and must pass. Only `markup_pct` is reachable in the new-rule form;
 * the surcharges can be carried over by editMarkup() from an existing row.
 */
export function hasEconomicField(input: MarkupRuleInput): boolean {
  const isSet = (v: string | null | undefined): boolean =>
    v !== null && v !== undefined && String(v).trim() !== '';
  return (
    isSet(input.markup_pct) ||
    isSet(input.surcharge_input_per_1m_usd) ||
    isSet(input.surcharge_output_per_1m_usd)
  );
}

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (!r.ok) {
    // The whole envelope used to be JSON.stringify'd into the toast, so an
    // operator saw a wall of JSON instead of "set Markup %". apiErrorMessage
    // unwraps billing's validation envelope down to the actual sentence.
    throw new Error(await apiErrorMessage(r, `${label}: ${r.status}`));
  }
  const body = (await r.json()) as { data: T };
  return body.data;
}

export async function listProviderPricing(): Promise<ProviderPricingRow[]> {
  const r = await authFetch('/api/admin/pricing/provider-pricing');
  return jsonOrThrow<ProviderPricingRow[]>(r, 'listProviderPricing');
}

export async function upsertProviderPricing(
  input: ProviderPricingInput,
): Promise<ProviderPricingRow> {
  const r = await authFetch('/api/admin/pricing/provider-pricing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<ProviderPricingRow>(r, 'upsertProviderPricing');
}

export async function listMarkupRules(): Promise<MarkupRuleRow[]> {
  const r = await authFetch('/api/admin/pricing/markup-rules');
  return jsonOrThrow<MarkupRuleRow[]>(r, 'listMarkupRules');
}

export async function upsertMarkupRule(input: MarkupRuleInput): Promise<MarkupRuleRow> {
  const r = await authFetch('/api/admin/pricing/markup-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<MarkupRuleRow>(r, 'upsertMarkupRule');
}

// --- Platform default markup -----------------------------------------------
// The markup billing actually applies when NO markup_rule matches. Production
// has zero open markup_rules today while this default is being charged, so an
// unqualified "No markup rules." on the page is a lie. Never hardcode the
// number — billing resolves it as DB override > env default.

export interface MarkupConfigRow {
  default_markup_pct: number;
}

export async function getMarkupConfig(): Promise<MarkupConfigRow> {
  const r = await authFetch('/api/admin/pricing/markup-config');
  return jsonOrThrow<MarkupConfigRow>(r, 'getMarkupConfig');
}

// --- Access charges (the ACCESS-billing axis) ------------------------------
// A per-(tenant, product) fixed access fee — the "paid license" money, distinct
// from usage markup. NULL service_key = a tenant-wide charge.

export type AccessCadence = 'monthly' | 'one_time';

export interface AccessChargeRow {
  id: number;
  tenant_id: string;
  service_key: string | null;
  amount_usd: string;
  cadence: string;
  included_cost_usd: string | null;
  effective_from: string;
  effective_until: string | null;
  notes: string | null;
}

export interface AccessChargeInput {
  tenant_id: string;
  service_key?: string | null;
  amount_usd: string;
  cadence?: AccessCadence;
  // Monthly included-usage credit (USD) that billing nets against the tenant's
  // incurred usage before markup. Omitted/empty = no allowance.
  included_cost_usd?: string | null;
  notes?: string | null;
}

export async function listAccessCharges(): Promise<AccessChargeRow[]> {
  const r = await authFetch('/api/admin/pricing/access-charges');
  return jsonOrThrow<AccessChargeRow[]>(r, 'listAccessCharges');
}

export async function upsertAccessCharge(input: AccessChargeInput): Promise<AccessChargeRow> {
  const r = await authFetch('/api/admin/pricing/access-charges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<AccessChargeRow>(r, 'upsertAccessCharge');
}

// --- Per-tenant billing config (markup_pct + billing_mode) -----------------

export type BillingMode = 'standard_markup' | 'byo_platform_fee' | 'pass_through';

export interface TenantConfigRow {
  tenant_id: string;
  markup_pct: number;
  billing_mode: BillingMode | string;
  notes: string | null;
}

export interface TenantConfigInput {
  markup_pct: number;
  billing_mode?: BillingMode;
  notes?: string | null;
}

export async function getTenantConfig(tenantId: string): Promise<TenantConfigRow> {
  const r = await authFetch(`/api/admin/pricing/tenant-config/${encodeURIComponent(tenantId)}`);
  return jsonOrThrow<TenantConfigRow>(r, 'getTenantConfig');
}

export async function putTenantConfig(
  tenantId: string,
  input: TenantConfigInput,
): Promise<TenantConfigRow> {
  const r = await authFetch(`/api/admin/pricing/tenant-config/${encodeURIComponent(tenantId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<TenantConfigRow>(r, 'putTenantConfig');
}
