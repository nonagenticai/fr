// src/routes/settings/licenses/page-helpers.ts
//
// Pure logic backing +page.svelte. Extracted so vitest can verify it under
// `environment: 'node'` without rendering the component.

import type {
  CostTotals,
  RegenerateTokenResponse,
} from '$lib/api/me-licenses';

/** Format an ISO date as a locale date string; em-dash for null. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

/** Sum input + output token counts. Tolerates a missing CostTotals (returns 0). */
export function totalTokens(t: CostTotals | null | undefined): number {
  if (!t) return 0;
  return (t.input_tokens ?? 0) + (t.output_tokens ?? 0);
}

/**
 * The cost card's figure. `null` means the backend WITHHELD it (the tenant's
 * markup is unknown, so no billed figure exists) — "—", never "$0.00".
 * `undefined` (no costs block at all) keeps the empty-state "$0.00".
 */
export function licensesCostDisplay(totalCostUsd: string | null | undefined): string {
  if (totalCostUsd === null) return '—';
  return `$${totalCostUsd ?? '0.00'}`;
}

export interface RegenerateModalPayload {
  moduleName: string;
  token: string;
}

export interface TriggerRegenerateOpts {
  /** Regenerate-token API call. */
  regen: (licenseId: string) => Promise<RegenerateTokenResponse>;
  /** Confirm dialog (defaults to window.confirm in the browser). */
  confirmFn?: (msg: string) => boolean;
}

/**
 * Run the regenerate flow: confirm → call API → return modal payload.
 *
 * Returns null when the user cancels. Throws on API failure so the page can
 * surface the error to the user via alert/state.
 */
export async function triggerRegenerate(
  licenseId: string,
  moduleName: string,
  opts: TriggerRegenerateOpts,
): Promise<RegenerateModalPayload | null> {
  const confirmFn =
    opts.confirmFn ??
    ((m: string) =>
      typeof globalThis !== 'undefined' && typeof (globalThis as { confirm?: (m: string) => boolean }).confirm === 'function'
        ? (globalThis as { confirm: (m: string) => boolean }).confirm(m)
        : true);
  const ok = confirmFn(
    `Regenerate token for ${moduleName}? The current token will stop working immediately.`,
  );
  if (!ok) return null;
  const resp = await opts.regen(licenseId);
  return { moduleName, token: resp.token };
}
