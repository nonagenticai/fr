// src/lib/api/budget.ts
//
// Tenant-admin budget top-up client. The budget STATUS read lives in
// api/usage.ts (`fetchBudgetStatus`); this is the top-up write + package list +
// history for the tenant-admin budget screen.
//
// Top-up is FREE today — the fleet has no payment processor. The backend runs
// it through a payment seam (services/billing/topup.ts) so a future Stripe
// integration needs no change here; when packages get a `priceUsd > 0`, the UI
// already shows it and the settle step charges.

import { authFetch } from './auth-fetch';
import { errorDetailOf } from './error-detail';

export interface TopUpPackage {
  id: string;
  label: string;
  tokens: number;
  priceUsd: number;
}

/**
 * A package listing. `topupEnabled` is the backend's BUDGET_TOPUP_ENABLED
 * kill switch (off until a real payment gateway exists — no free top-up); when
 * false the backend returns no packages and both top-up POSTs answer 409, so
 * the UI hides the top-up controls. Absent reads as false (fail closed).
 */
export interface TopUpPackageList {
  packages: TopUpPackage[];
  topupEnabled: boolean;
}

export function parseTopUpPackageList(body: unknown): TopUpPackageList {
  const b = (body ?? {}) as { packages?: TopUpPackage[]; topupEnabled?: unknown };
  return { packages: b.packages ?? [], topupEnabled: b.topupEnabled === true };
}

export interface TopUpResult {
  topup_id: string;
  budget_id: string;
  tokens: number;
  package_id: string;
  payment_status: 'free' | 'paid' | 'pending' | 'failed';
}

export interface TopUpRecord {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  package_id: string;
  tokens: number;
  price_usd: string;
  budget_id: string | null;
  payment_ref: string | null;
  payment_status: string;
  status: string;
  error: string | null;
  created_at: string;
}

// This module used to carry its own reader:
//
//   return [err, b.detail].filter(Boolean).join(': ');
//
// which is the EXACT pattern `error-detail.ts` was written to kill — the one
// that put `provisionUser: 404 — [object Object]` in front of a super-admin in
// production. Two shapes reach these routes and both were destroyed by it:
//
//  1. A FastAPI 422, whose `detail` is an ARRAY. `Array.join` stringifies each
//     `{loc,msg,type}` entry as `[object Object]`, so a top-up rejected for a
//     named field rendered as literal `[object Object]`.
//  2. `{error:{code,message,service,upstream:{status,body}}}` from
//     `integrationErrorResponse`. `b.error` is an OBJECT, so the old reader
//     took `.message` when present and `JSON.stringify(b.error)` when not —
//     rendering a raw JSON blob at the user — and never once looked at
//     `error.upstream.body.detail`, where billing's own sentence lives.
//
// `errorDetailOf` reads all of them, most specific first. Same helper, same
// call shape as `usage.ts:fetchAdminSystemUsage`.

/** GET /api/me/budget/packages — the options a top-up dropdown binds to. */
export async function listTopUpPackages(): Promise<TopUpPackageList> {
  const r = await authFetch('/api/me/budget/packages');
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`listTopUpPackages: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return parseTopUpPackageList(await r.json());
}

/**
 * POST /api/me/budget/topup — allocate a top-up for the active tenant.
 *
 * `idempotencyKey` is REQUIRED and must be minted once per user INTENT (at
 * confirm time), not once per call: the backend dedupes on
 * (tenant_id, idempotency_key) — migration 118 — so any replay of the same
 * request (authFetch retry, proxy retry, double-submit) returns the ORIGINAL
 * allocation instead of stacking a second 1M-100M-token budget. A fresh key per
 * call would defeat that, which is why this is a parameter and not minted here.
 */
export async function topUpMyBudget(
  packageId: string,
  idempotencyKey: string,
): Promise<TopUpResult> {
  const r = await authFetch('/api/me/budget/topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package_id: packageId, idempotency_key: idempotencyKey }),
  });
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`topUpMyBudget: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await r.json()) as TopUpResult;
}

/** GET /api/me/budget/topups — this tenant's top-up history. */
export async function listMyTopUps(): Promise<TopUpRecord[]> {
  const r = await authFetch('/api/me/budget/topups');
  if (!r.ok) {
    const detail = await errorDetailOf(r);
    throw new Error(`listMyTopUps: ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
  return ((await r.json()) as { topups: TopUpRecord[] }).topups ?? [];
}
