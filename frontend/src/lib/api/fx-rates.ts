// src/lib/api/fx-rates.ts
//
// USD→EUR FX rows (fr `GET/PUT /api/admin/pricing/fx-rates` → billing
// `/api/config/fx-rates`). EUR money budgets consume `fx × USD price` (PLAN
// tenant-inference-provisioning §3.1): with no rate, billing's quote answers
// `fx_rate_missing` and no tenant can be EUR-provisioned. Super-admin only.

import { authFetch } from './auth-fetch';
import { errorDetailOf } from './error-detail';

export interface FxRateRow {
  base: string;
  quote: string;
  rate: string;
  effective_from: string;
  effective_until?: string | null;
}

export async function listFxRates(): Promise<FxRateRow[]> {
  const r = await authFetch('/api/admin/pricing/fx-rates');
  if (!r.ok) {
    const d = await errorDetailOf(r);
    throw new Error(`fx rates: ${r.status}${d ? ` — ${d}` : ''}`);
  }
  return ((await r.json()) as { data: FxRateRow[] }).data;
}

export async function putFxRate(input: { rate: string; effective_from?: string }): Promise<FxRateRow> {
  const r = await authFetch('/api/admin/pricing/fx-rates', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'USD', quote: 'EUR', ...input }),
  });
  if (!r.ok) {
    const d = await errorDetailOf(r);
    throw new Error(`set fx rate: ${r.status}${d ? ` — ${d}` : ''}`);
  }
  return ((await r.json()) as { data: FxRateRow }).data;
}
