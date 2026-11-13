// src/lib/api/me-licenses.ts
//
// Typed client for the fr backend's `/api/me/licenses` aggregator.
// Mirror the response interfaces from
// fr/backend/src/routes/me/licenses.ts. Keep these in sync — there is no
// shared types package today.
//
// Auth: every call goes through `authFetch`, which attaches the
// browser's Keycloak access token as a Bearer header. The route requires
// a Bearer token, so these helpers MUST run client-side (after the auth
// store has been hydrated) — never from a SvelteKit SSR `load()`.

import { authFetch } from './auth-fetch';

export interface AppInfo {
  id: string;
  key: string;
  name: string;
}

export interface PlanInfo {
  id: string;
  code: string;
  name: string;
  rate_limit_rpm: number | null;
  rate_limit_burst: number | null;
  quota_monthly: number | null;
  token_budget_monthly: number | null;
}

export interface LicenseRecord {
  id: string;
  subject_id: string;
  tenant_id: string;
  app_id: string;
  plan_id: string;
  region_id: string | null;
  status: string;
  starts_at: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  metadata: Record<string, unknown> | null;
  app: AppInfo | null;
  plan: PlanInfo | null;
}

export interface UsageTotals {
  request_count: number;
  denied_count: number;
  budget_denied_count: number;
}

export interface CostTotals {
  input_tokens: number;
  output_tokens: number;
  /** null when withheld (the tenant's markup is unknown) — render "—". */
  total_cost_usd: string | null;
}

export interface MyLicensesResponse {
  subject_id: string;
  licenses: LicenseRecord[];
  usage: {
    subject_id: string;
    period: { from: string; to: string };
    totals: UsageTotals;
    by_service: ({ service_key: string } & UsageTotals)[];
  };
  costs: {
    subject_id: string;
    period: { from: string; to: string };
    totals: CostTotals;
    /** `'unavailable'`: the billed figure was withheld (markup unknown). */
    cost_basis?: 'incurred' | 'billed' | 'unavailable';
    by_provider: ({ provider: string } & CostTotals)[];
  };
}

export interface RegenerateTokenResponse {
  token: string;
  message: string;
}

export async function fetchMyLicenses(): Promise<MyLicensesResponse> {
  const resp = await authFetch('/api/me/licenses');
  if (!resp.ok) throw new Error(`fetchMyLicenses failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as MyLicensesResponse;
}

/**
 * Pull the sentence a human should read out of a failed regenerate response.
 *
 * The backend answers a refused rotation with the integrations envelope
 *
 *   {"error": {"code": "UPSTREAM_CONFLICT", "message": "…", "service": "licenses",
 *              "upstream": {"status": 409,
 *                           "body": {"detail": {"error": "all_tokens_expired",
 *                                               "remedy": "mint a new token via …"}}}}}
 *
 * The `remedy` is the only part that tells the user what to DO, so it is what
 * we surface. Everything here is defensive: any layer may be missing (a 502
 * from the ingress carries no envelope at all), and in that case we fall back
 * to the original `regenerate failed: <status> <text>` wording rather than
 * showing an empty banner.
 */
function regenerateFailureMessage(status: number, raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `regenerate failed: ${status} ${raw}`;
  }
  const envelope = (parsed as { error?: unknown } | null)?.error;
  if (typeof envelope !== 'object' || envelope === null) {
    return `regenerate failed: ${status} ${raw}`;
  }
  const upstreamBody = (
    envelope as { upstream?: { body?: unknown } }
  ).upstream?.body;
  const detail = (upstreamBody as { detail?: unknown } | undefined)?.detail;
  const remedy = (detail as { remedy?: unknown } | undefined)?.remedy;
  const reason = (detail as { error?: unknown } | undefined)?.error;
  if (typeof remedy === 'string' && remedy.length > 0) {
    return typeof reason === 'string' && reason.length > 0
      ? `${humanise(reason)} — ${remedy}`
      : remedy;
  }
  if (typeof reason === 'string' && reason.length > 0) return humanise(reason);
  const message = (envelope as { message?: unknown }).message;
  if (typeof message === 'string' && message.length > 0) return message;
  return `regenerate failed: ${status} ${raw}`;
}

/** `all_tokens_expired` -> `All tokens expired`. */
function humanise(code: string): string {
  const words = code.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function regenerateLicenseToken(
  licenseId: string,
): Promise<RegenerateTokenResponse> {
  const resp = await authFetch(
    `/api/me/licenses/${encodeURIComponent(licenseId)}/regenerate-token`,
    { method: 'POST' },
  );
  if (!resp.ok) {
    throw new Error(regenerateFailureMessage(resp.status, await resp.text()));
  }
  return (await resp.json()) as RegenerateTokenResponse;
}
