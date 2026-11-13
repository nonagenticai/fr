// cockpit.ts (api)
// ================
// Client for the customer project cockpit read model. One call returns the
// whole cockpit; per-block upstream failures arrive INSIDE the payload as
// `available:false` blocks (never thrown). Only HTTP-level failures throw:
//   - 404 = the tenant/ownership gate (loadTenantScopedProject) → the project
//     is not visible to this caller; surface as "project not found".
// Client-side only (authFetch attaches the Bearer + X-Active-Tenant headers).

import { authFetch } from './auth-fetch';
import type { ProjectCockpit } from '$lib/types/cockpit';

export class CockpitNotFoundError extends Error {
  constructor(public projectId: string) {
    super(`Project cockpit not found: ${projectId}`);
    this.name = 'CockpitNotFoundError';
  }
}

export async function fetchProjectCockpit(projectId: string): Promise<ProjectCockpit> {
  const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/cockpit`);
  if (r.status === 404) throw new CockpitNotFoundError(projectId);
  if (!r.ok) throw new Error(`fetchProjectCockpit: ${r.status}`);
  return (await r.json()) as ProjectCockpit;
}


// ── Per-project LLM cost to date ────────────────────────────────────────────
//
// ⛔ `fetchProjectCost` AND ITS `ProjectCost` TYPE ARE GONE ON PURPOSE. DO NOT
// REINTRODUCE THEM. The cost now arrives as `cockpit.cost`, a `Block<ProjectCost>`
// (`$lib/types/cockpit`) produced inside the cockpit aggregator's existing
// `Promise.all` — ONE read model drives every block on the project page, which is
// that page's contract.
//
// Two reasons this is not a style preference:
//  1. The old lane was a SECOND round-trip fired from inside the old home cost
//     panel on mount, so the page had a second failure mode the read model knew
//     nothing about.
//  2. Its payload's amount field was NAMED as a total and was not one, and a
//     separate client fetch meant the ZERO-vs-UNKNOWN rule had to be
//     re-implemented in the component instead of being carried by the block
//     envelope. The cost now reaches the Cost page inside the cockpit read only.
//
// ⚠️ The retired field name is deliberately not written out anywhere in the tree
// — `backend/tests/unit/project-cost-rename-guard.test.ts` fails on any
// occurrence of it, including one inside a comment describing its removal.
