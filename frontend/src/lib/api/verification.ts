// verification.ts (api)
// =====================
// Client for the super-admin VERIFICATION read models (/operate/verification).
//
// Every route returns `Block<T>` whose `data` is the upstream payload verbatim
// (see $lib/types/verification). Per-block upstream failures arrive INSIDE the
// envelope as `available:false` (never thrown). Only HTTP-level failures throw:
//   - 404 = the super-admin gate (requireSuperAdminRead answers 404, not 403, so
//     the surface stays invisible) → VerificationForbiddenError.
//   - anything else non-2xx → a plain Error, which usePoll backs off on.

import { authFetch } from './auth-fetch';
import type { Block } from '$lib/types/read-model';
import type { VerificationAlertsPayload } from '$lib/types/verification';

/** Thrown on a 404 — the caller is not a super-admin (surface stays private). */
export class VerificationForbiddenError extends Error {
  constructor() {
    super('Verification: not available');
    this.name = 'VerificationForbiddenError';
  }
}

/** Verification blocks use the shared envelope (incl. `note` / `unavailable`). */
export type VerificationBlock<T> = Block<T>;

const BASE = '/api/admin/verification';

async function getBlock<T>(path: string): Promise<VerificationBlock<T>> {
  const r = await authFetch(`${BASE}${path}`);
  if (r.status === 404) throw new VerificationForbiddenError();
  if (!r.ok) throw new Error(`${BASE}${path}: ${r.status}`);
  return (await r.json()) as VerificationBlock<T>;
}

// ---- A10.4 ----
export const fetchAlerts = () => getBlock<VerificationAlertsPayload>('/alerts');
