// control-tower.ts (api)
// =======================
// Client for the super-admin CONTROL TOWER read model. ONE flat endpoint
// (GET /api/admin/control-tower) returns all 10 blocks; per-block
// upstream failures arrive INSIDE the payload as `available:false` blocks (never
// thrown). Only HTTP-level failures throw:
//   - 404 = the super-admin gate (requireSuperAdminRead throws the same
//     UPSTREAM_NOT_FOUND shape as requireInternalTenant) → the surface stays
//     INVISIBLE to non-super-admins. Surface as not-found, NEVER "403 forbidden".
// The ONE mutation is the GLOBAL andon cord (engage/disengage) — wired to the
// existing super-admin domain routes (never client-only state).

import { authFetch } from './auth-fetch';
import type { ControlTower } from '$lib/types/control-tower';
import type { AndonToggleResult } from '$lib/components/andon-cord-helpers';

/** Thrown on a 404 — the caller is not a super-admin (surface stays private). */
export class ControlTowerForbiddenError extends Error {
  constructor() {
    super('Control tower: not available');
    this.name = 'ControlTowerForbiddenError';
  }
}

const BASE = '/api/admin/control-tower';

/** GET the control tower read model. */
export async function fetchControlTower(): Promise<ControlTower> {
  const r = await authFetch(BASE);
  if (r.status === 404) throw new ControlTowerForbiddenError();
  if (!r.ok) throw new Error(`${BASE}: ${r.status}`);
  return (await r.json()) as ControlTower;
}

// ---------------------------------------------------------------------------
// The one mutation — GLOBAL andon cord (super-admin, no request body).
// After a successful POST the caller re-reads the read model (the `andon` block
// reflects the new state) — never keep client-only engaged state.
// ---------------------------------------------------------------------------

async function toggleGlobalAndon(path: '/api/andon/engage' | '/api/andon/disengage'): Promise<AndonToggleResult> {
  const r = await authFetch(path, { method: 'POST' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as AndonToggleResult;
}

/** Pull the global andon cord — scales the n8n-worker Deployment to 0. */
export function engageGlobalAndon(): Promise<AndonToggleResult> {
  return toggleGlobalAndon('/api/andon/engage');
}

/** Release the global andon cord — scales n8n-worker back to 1 (accepted, not serving). */
export function disengageGlobalAndon(): Promise<AndonToggleResult> {
  return toggleGlobalAndon('/api/andon/disengage');
}
