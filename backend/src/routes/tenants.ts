// The canonical tenant roster (formerly also the home of GET /api/tenants/me,
// which fr-agui P4d-1 removed per OQ-5 D2 — superseded by the /api/me/*
// workspace reads, no frontend or n8n caller).

import {
  internalSystemTenantId,
  executionTenantId,
  kataTenantId,
  canonicalTenantNames,
} from '../middleware/internal-tenant-only';

// SPEC.md L37-38: George's working tenant — not an "internal" tenant, but one
// of the canonical labels. Canonical definition lives in
// middleware/internal-tenant-only.ts (shared with the switch gate);
// re-exported here so existing importers keep their `from './tenants'` path.
export { executionTenantId } from '../middleware/internal-tenant-only';

export interface TenantOption {
  id: string;
  name: string;
  is_system: boolean;
}

// Exported for the control tower (AA cockpit B5) — the canonical fleet roster
// for the tenant-health table + approvals/andon roll-ups.
// ⚠️ The NAMES come from `canonicalTenantNames()` in
// middleware/internal-tenant-only.ts, not from literals here. They used to be
// spelled in both places, and a refusal-diagnostic that wants to say "that uuid
// is the `prompt-improvement` TENANT, not a project" cannot import this module
// (it pulls the db client onto a request-path error branch). One map, two
// readers. `is_system` stays here — it is a display concern this list owns.
/**
 * The canonical fleet roster, built per call.
 *
 * ⛔ A FUNCTION, not a module-scope array: the ids are environment-supplied, so
 * an array built at import would freeze whatever the env held then (and could
 * not be varied in a test). A role whose env is unset is ABSENT from the roster
 * — it is not offered in the switcher, and the control tower shows no row for
 * it, rather than a row with an empty id.
 */
export function canonicalTenants(): readonly TenantOption[] {
  const names = canonicalTenantNames();
  const entries: Array<[string | undefined, boolean]> = [
    [internalSystemTenantId(), true],
    [executionTenantId(), false],
    // The kata tenant (migration 228): every kata project.
    [kataTenantId(), false],
  ];
  return entries
    .filter((entry): entry is [string, boolean] => typeof entry[0] === 'string')
    .map(([id, isSystem]) => ({ id, name: names[id] ?? id, is_system: isSystem }));
}
