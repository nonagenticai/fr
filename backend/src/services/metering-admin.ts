// src/services/metering-admin.ts
//
// Super-admin write helpers for the metering service. Today there's only
// one verb — createBudget — used by the user-provisioning orchestration
// (Spec 2 Task 3) when an operator wants to attach an explicit token
// budget to a freshly-issued license.
//
// We don't reuse `services/metering.ts` (which targets the user-facing
// `/api/usage/me` etc. paths gated by license tokens) because the budget
// endpoint is gated by `require_internal` — a Keycloak service-account
// Bearer JWT carrying the `metering-internal` / `license-admin` realm
// roles. We mint that token via `getSecureAppsAuthenticator()`.
//
// Endpoint shape (mirrored from ~/metering_service/src/
// routers/budget.py):
//   POST /api/budget                              → 201 {data: TokenBudgetResponse}
//                                                 (envelope-wrapped)
//
// `TokenBudgetCreate` body fields:
//   tenant_id (req), budget_tokens (req, >0), period (default monthly),
//   includes_input (default true), includes_output (default true),
//   priority (default 100), source (default 'manual'),
//   license_id (optional), starts_at (defaults to now()), expires_at (optional)

import { config } from '../config';
import { IntegrationError } from '../integrations/_lib/errors';
import { unwrapEnvelope } from '../integrations/metering/usage';
import { getSecureAppsAuthenticator } from '../lib/service-authenticators';

// createBudget (POST /api/budget) is a billing write — it moved to
// billing-service with the metering→billing split. BILLING_* only — no
// METERING_* fallback (config.ts requires BILLING_BASE_URL in production).
function billingBaseUrl(): string {
  return (
    process.env.BILLING_BASE_URL ??
    process.env.BILLING_SERVICE_URL ??
    config.services.billing.baseUrl
  );
}

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CreateBudgetInput {
  tenantId: string;
  budgetTokens: number;
  period?: BudgetPeriod;
  includesInput?: boolean;
  includesOutput?: boolean;
  priority?: number;
  /**
   * One of `manual`, `topup`, `license_sync`. `license_sync` is reserved
   * for the licenses-service auto-provision path; super-admin manual
   * provisioning should leave this as `manual`.
   */
  source?: string;
  licenseId?: string;
  /** ISO-8601 string. Metering accepts a `datetime`; we pass-through. */
  startsAt?: string;
  /** ISO-8601 string. Optional — open-ended budgets omit this. */
  expiresAt?: string;
}

export interface CreateBudgetResult {
  id: string;
}

/**
 * POST /api/budget on metering-service. Returns the new budget id.
 *
 * Auth: Keycloak service-account Bearer JWT carrying `metering-internal`
 * / `license-admin` realm roles, minted by `getSecureAppsAuthenticator()`
 * and attached by `authenticatedFetch`. 15s timeout via
 * `AbortSignal.timeout` — DB writes + Redis sync should complete well
 * inside that.
 *
 * Optional fields (`license_id`, `starts_at`, `expires_at`) are omitted
 * from the request body when undefined, so metering's defaults
 * (`license_id=NULL`, `starts_at=now()`, `expires_at=NULL`) apply.
 */
export async function createBudget(
  input: CreateBudgetInput,
): Promise<CreateBudgetResult> {
  const body: Record<string, unknown> = {
    tenant_id: input.tenantId,
    budget_tokens: input.budgetTokens,
    period: input.period ?? 'monthly',
    includes_input: input.includesInput ?? true,
    includes_output: input.includesOutput ?? true,
    priority: input.priority ?? 100,
    source: input.source ?? 'manual',
  };
  if (input.licenseId !== undefined) body.license_id = input.licenseId;
  if (input.startsAt !== undefined) body.starts_at = input.startsAt;
  if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;

  const url = `${billingBaseUrl()}/api/budget`;
  let res: Response;
  try {
    res = await getSecureAppsAuthenticator().authenticatedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const isTimeout =
      e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new IntegrationError({
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `metering-admin createBudget failed: ${e instanceof Error ? e.message : String(e)}`,
      service: 'metering-admin',
      method: 'POST',
      path: '/api/budget',
      cause: e,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : text;
    } catch {
      // not JSON; keep raw text
    }
    let code:
      | 'UPSTREAM_NOT_FOUND'
      | 'UPSTREAM_UNAUTHORIZED'
      | 'UPSTREAM_FORBIDDEN'
      | 'UPSTREAM_CONFLICT'
      | 'UPSTREAM_BAD_STATUS' = 'UPSTREAM_BAD_STATUS';
    if (res.status === 401) code = 'UPSTREAM_UNAUTHORIZED';
    else if (res.status === 403) code = 'UPSTREAM_FORBIDDEN';
    else if (res.status === 404) code = 'UPSTREAM_NOT_FOUND';
    else if (res.status === 409) code = 'UPSTREAM_CONFLICT';
    throw new IntegrationError({
      code,
      // Body goes to `upstreamBody`, NOT into `message`.
      // `integrationErrorResponse` logs `message` verbatim and deliberately
      // never logs `upstreamBody` — it can carry tokens and PII. Inlining the
      // body here defeated that invariant from the producer side, and this
      // route reaches the converter via `gated()`, which had NO telemetry
      // before 2026-09-01 — so these bodies were never in the logs and would
      // newly have been.
      message: `metering-admin createBudget returned ${res.status}`,
      service: 'metering-admin',
      method: 'POST',
      path: '/api/budget',
      upstreamStatus: res.status,
      upstreamBody: parsed,
    });
  }

  // metering wraps responses in an envelope: { data: TokenBudgetResponse, meta: ... }.
  // Funnel through the shared unwrapEnvelope helper so this client tracks the
  // central heuristic (which now requires both `data` and `meta` to consider a
  // body enveloped — see integrations/metering/usage.ts). Bare-T mocks /
  // pre-T3.2 responses still work: unwrapEnvelope returns the raw body when
  // the envelope shape is absent.
  const json = (await res.json()) as unknown;
  const payload = unwrapEnvelope<{ id?: string }>(json);
  const id = typeof payload?.id === 'string' ? payload.id : undefined;
  if (!id) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: 'metering-admin createBudget: response missing id',
      service: 'metering-admin',
      method: 'POST',
      path: '/api/budget',
      upstreamStatus: res.status,
      upstreamBody: json,
    });
  }

  return { id };
}

// ---------------------------------------------------------------------------
// Budget top-up + reads (billing_service already has these; fr just never
// wired them). All secure-apps-authed, like createBudget above.
// ---------------------------------------------------------------------------

export interface TopUpInput {
  tenantId: string;
  budgetTokens: number;
  /** ISO-8601. For monthly-windowed top-ups; omit for open-ended. */
  startsAt?: string;
  expiresAt?: string;
  /** Lower drains first. Top-ups default to 50 so they burn before license_sync (100). */
  priority?: number;
}

/**
 * POST /api/budget/topup/{tenant_id} — allocate a stacking top-up budget row
 * (billing forces `source='topup'`). Returns the new budget id. This is the
 * `allocate` step of the topUpBudget seam (services/billing/topup.ts).
 */
export async function topUp(input: TopUpInput): Promise<CreateBudgetResult> {
  const body: Record<string, unknown> = {
    // billing overrides tenant_id from the path, but send it too for clarity.
    tenant_id: input.tenantId,
    budget_tokens: input.budgetTokens,
    period: 'monthly',
    priority: input.priority ?? 50,
  };
  if (input.startsAt !== undefined) body.starts_at = input.startsAt;
  if (input.expiresAt !== undefined) body.expires_at = input.expiresAt;

  const path = `/api/budget/topup/${encodeURIComponent(input.tenantId)}`;
  return billingWrite(path, body, 'topUp');
}

/** Shared POST→id helper for billing budget writes (create + topup). */
async function billingWrite(
  path: string,
  body: Record<string, unknown>,
  op: string,
): Promise<CreateBudgetResult> {
  const url = `${billingBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await getSecureAppsAuthenticator().authenticatedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const isTimeout =
      e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new IntegrationError({
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `metering-admin ${op} failed: ${e instanceof Error ? e.message : String(e)}`,
      service: 'metering-admin',
      method: 'POST',
      path,
      cause: e,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code:
      | 'UPSTREAM_UNAUTHORIZED'
      | 'UPSTREAM_FORBIDDEN'
      | 'UPSTREAM_NOT_FOUND'
      | 'UPSTREAM_CONFLICT'
      | 'UPSTREAM_BAD_STATUS' = 'UPSTREAM_BAD_STATUS';
    if (res.status === 401) code = 'UPSTREAM_UNAUTHORIZED';
    else if (res.status === 403) code = 'UPSTREAM_FORBIDDEN';
    else if (res.status === 404) code = 'UPSTREAM_NOT_FOUND';
    else if (res.status === 409) code = 'UPSTREAM_CONFLICT';
    throw new IntegrationError({
      code,
      // See createBudget above: body to `upstreamBody`, never into `message`.
      message: `metering-admin ${op} returned ${res.status}`,
      upstreamBody: text,
      service: 'metering-admin',
      method: 'POST',
      path,
      upstreamStatus: res.status,
    });
  }
  const payload = unwrapEnvelope<{ id?: string }>((await res.json()) as unknown);
  const id = typeof payload?.id === 'string' ? payload.id : undefined;
  if (!id) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: `metering-admin ${op}: response missing id`,
      service: 'metering-admin',
      method: 'POST',
      path,
    });
  }
  return { id };
}

export interface BudgetLine {
  budget_id?: string;
  /** The licence this row belongs to, or null for a manual / top-up row. */
  license_id?: string | null;
  source?: string;
  period?: string;
  budget_tokens?: number;
  used_tokens?: number;
  consumed_tokens?: number;
  remaining_tokens?: number;
  priority?: number;
  starts_at?: string | null;
  expires_at?: string | null;
}

// ---------------------------------------------------------------------------
// Budget reset (billing `POST /api/budget/reset/{tenant_id}`)
// ---------------------------------------------------------------------------

export interface ResetTenantBudgetsInput {
  tenantId: string;
  /** Why the counters are being zeroed; `null` when the operator gave none. */
  reason: string | null;
}

/**
 * What billing reports after zeroing a tenant's consumed counters.
 *
 * `previous_consumed_total` is the figure the reset DESTROYED. It is returned
 * so the console can state what happened instead of claiming a bare success —
 * the same reason `AppDeleteReport` carries `retained_quota_licenses`.
 */
export interface ResetTenantBudgetsResult {
  tenant_id: string;
  reset_count: number;
  budget_ids: string[];
  previous_consumed_total: number;
}

/**
 * POST /api/budget/reset/{tenant_id} — zero the consumed counters of EVERY
 * budget row a tenant holds, so its full allowance is available again.
 *
 * This is NOT a delete: the budget rows (and their totals) survive; only
 * `consumed_tokens` is reset. Billing owns that distinction and this client
 * relays its report rather than re-deriving it.
 *
 * Auth and error mapping are identical to `topUp`/`getBudgetStatus` above:
 * secure-apps service account, 15s bound, every non-2xx raised as an
 * `IntegrationError` with the upstream body kept OUT of `message` (it can
 * carry tenant data) and in `upstreamBody`.
 */
export async function resetTenantBudgets(
  input: ResetTenantBudgetsInput,
): Promise<ResetTenantBudgetsResult> {
  const path = `/api/budget/reset/${encodeURIComponent(input.tenantId)}`;
  const url = `${billingBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await getSecureAppsAuthenticator().authenticatedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: input.reason }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const isTimeout =
      e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new IntegrationError({
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `metering-admin resetTenantBudgets failed: ${e instanceof Error ? e.message : String(e)}`,
      service: 'metering-admin',
      method: 'POST',
      path,
      cause: e,
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code:
      | 'UPSTREAM_UNAUTHORIZED'
      | 'UPSTREAM_FORBIDDEN'
      | 'UPSTREAM_NOT_FOUND'
      | 'UPSTREAM_CONFLICT'
      | 'UPSTREAM_BAD_STATUS' = 'UPSTREAM_BAD_STATUS';
    if (res.status === 401) code = 'UPSTREAM_UNAUTHORIZED';
    else if (res.status === 403) code = 'UPSTREAM_FORBIDDEN';
    else if (res.status === 404) code = 'UPSTREAM_NOT_FOUND';
    else if (res.status === 409) code = 'UPSTREAM_CONFLICT';
    throw new IntegrationError({
      code,
      // See createBudget above: body to `upstreamBody`, never into `message`.
      message: `metering-admin resetTenantBudgets returned ${res.status}`,
      upstreamBody: text,
      service: 'metering-admin',
      method: 'POST',
      path,
      upstreamStatus: res.status,
    });
  }

  const json = (await res.json()) as unknown;
  const payload = unwrapEnvelope<Partial<ResetTenantBudgetsResult>>(json);
  // The three counters are the whole report. Defaulting a missing one to 0
  // would let the console say "0 rows reset" about a reset whose effect is
  // unknown — the exact conflation this codebase refuses elsewhere.
  if (
    typeof payload?.reset_count !== 'number' ||
    typeof payload?.previous_consumed_total !== 'number' ||
    !Array.isArray(payload?.budget_ids)
  ) {
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_BODY',
      message: 'metering-admin resetTenantBudgets: response missing reset_count / budget_ids / previous_consumed_total',
      service: 'metering-admin',
      method: 'POST',
      path,
      upstreamStatus: res.status,
      upstreamBody: json,
    });
  }

  return {
    tenant_id: typeof payload.tenant_id === 'string' ? payload.tenant_id : input.tenantId,
    reset_count: payload.reset_count,
    budget_ids: payload.budget_ids.filter((id): id is string => typeof id === 'string'),
    previous_consumed_total: payload.previous_consumed_total,
  };
}

export interface BudgetStatus {
  tenant_id: string;
  total_remaining: number;
  budget_count: number;
  next_expiry: string | null;
  budgets: BudgetLine[];
}

/**
 * GET /api/budget/status/{tenant_id} — aggregate budget for ANY tenant
 * (super-admin console). A 404 (no budgets) is normalized to an empty
 * aggregate so the UI renders "no budget configured", not an error.
 */
export async function getBudgetStatus(tenantId: string): Promise<BudgetStatus> {
  const path = `/api/budget/status/${encodeURIComponent(tenantId)}`;
  const url = `${billingBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await getSecureAppsAuthenticator().authenticatedFetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new IntegrationError({
      code: 'UPSTREAM_UNREACHABLE',
      message: `metering-admin getBudgetStatus failed: ${e instanceof Error ? e.message : String(e)}`,
      service: 'metering-admin',
      method: 'GET',
      path,
      cause: e,
    });
  }
  if (res.status === 404) {
    return { tenant_id: tenantId, total_remaining: 0, budget_count: 0, next_expiry: null, budgets: [] };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      // See createBudget above: body to `upstreamBody`, never into `message`.
      message: `metering-admin getBudgetStatus returned ${res.status}`,
      upstreamBody: text,
      service: 'metering-admin',
      method: 'GET',
      path,
      upstreamStatus: res.status,
    });
  }
  const payload = unwrapEnvelope<BudgetStatus>((await res.json()) as unknown);
  return {
    tenant_id: payload?.tenant_id ?? tenantId,
    total_remaining: payload?.total_remaining ?? 0,
    budget_count: payload?.budget_count ?? 0,
    next_expiry: payload?.next_expiry ?? null,
    budgets: Array.isArray(payload?.budgets) ? payload.budgets : [],
  };
}
