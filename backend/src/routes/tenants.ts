// The canonical tenant roster (formerly also the home of GET /api/tenants/me,
// which fr-agui P4d-1 removed per OQ-5 D2 — superseded by the /api/me/*
// workspace reads, no frontend or n8n caller).

import {
  INTERNAL_SYSTEM_TENANT_ID,
  EXECUTION_TENANT_ID,
  KATA_TENANT_ID,
  CANONICAL_TENANT_NAMES,
} from '../middleware/internal-tenant-only';

// SPEC.md L37-38: George's working tenant — not an "internal" tenant, but one
// of the canonical labels. Canonical definition lives in
// middleware/internal-tenant-only.ts (shared with the switch gate);
// re-exported here so existing importers keep their `from './tenants'` path.
export { EXECUTION_TENANT_ID } from '../middleware/internal-tenant-only';

export interface TenantOption {
  id: string;
  name: string;
  is_system: boolean;
}

// Exported for the control tower (AA cockpit B5) — the canonical fleet roster
// for the tenant-health table + approvals/andon roll-ups.
// ⚠️ The NAMES come from `CANONICAL_TENANT_NAMES` in
// middleware/internal-tenant-only.ts, not from literals here. They used to be
// spelled in both places, and a refusal-diagnostic that wants to say "that uuid
// is the `prompt-improvement` TENANT, not a project" cannot import this module
// (it pulls the db client onto a request-path error branch). One map, two
// readers. `is_system` stays here — it is a display concern this list owns.
export const CANONICAL_TENANTS: readonly TenantOption[] = [
  { id: INTERNAL_SYSTEM_TENANT_ID, name: CANONICAL_TENANT_NAMES[INTERNAL_SYSTEM_TENANT_ID]!, is_system: true },
  { id: EXECUTION_TENANT_ID, name: CANONICAL_TENANT_NAMES[EXECUTION_TENANT_ID]!, is_system: false },
  // The kata tenant (migration 228): every kata project.
  { id: KATA_TENANT_ID, name: CANONICAL_TENANT_NAMES[KATA_TENANT_ID]!, is_system: false },
] as const;
