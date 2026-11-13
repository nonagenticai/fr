// fr-agui SPEC §13 P4b (part 2) — spec drain: what the scheduled-trigger
// and suggested-schedule declarations share.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
//
// The stores are fr's OWN tables (scheduled_triggers, suggested_schedules,
// scheduled_trigger_runs), not an upstream. Every route keeps
// its handler (`legacyHandler`), so nothing changes at runtime.
//
// THE GATES, as the handlers enforce them:
//   * the PRINCIPAL gate (the declared rule): `validateAuth` — its licence /
//     conveyor route doors, `principalDoorAdmits` — then `ctxTenantId(user.tenantId)`,
//     the request-context tenant else the JWT one, which THROWS (500) when neither
//     exists, before the store is read: `isAuthenticatedUserInResolvedTenant`.
//     (`GET /api/scheduled-triggers` reads `user.tenantId` directly and never calls
//     ctxTenantId: `isAuthenticatedUser`, see scheduled-triggers.ts.)
//   * the RESOURCE gate, per row (NOT a principal rule — it needs the row): the
//     row must be the request tenant's (else 404, indistinguishable from absent),
//     then `gateOnProject` / `requireDeptRole` on the row's project: a
//     workspace-admin of the request tenant, or the project department's
//     dept-member (reads, dismiss) / dept-manager (writes) — else 403
//     `dept-role required on department …`. The list routes FILTER by the same
//     rule instead of refusing.
import { z } from 'zod';

import { frErrorBody } from '../settings/_shared';

/** A timestamp column, JSON-serialised by `jsonResponse` (an ISO-8601 string). */
export const isoTime = z.string().describe('ISO-8601 timestamp');

/** `handleError` over an AppError / ZodError: `{ error, code?, details? }`. */
export const fr4xxBody = frErrorBody;

export const RESOURCE_403 =
  "403: `error` 'dept-role required on department …' / \"dept-role '…' or higher required …\" — the caller is neither a " +
  "workspace-admin of the request tenant nor the row's project department's member (reads) / manager (writes).";

export const NO_TENANT_500 = "500: fr's own (`error`), e.g. no tenant resolvable for the caller (no frame, no JWT tenant), or the database is unreachable.";

/** `serializeCount` (lib/resolution.ts): the run list's `total`. */
export const totalKind = z.enum(['exact', 'at_least', 'unknown']);

/** A `scheduled_trigger_runs` row, its `error_message` reduced to client-safe text. */
export const runRow = z.object({
  id: z.string(),
  trigger_kind: z.enum(['scheduled_intake']),
  trigger_id: z.string(),
  tenant_id: z.string(),
  project_id: z.string(),
  fired_at: isoTime,
  finished_at: isoTime.nullable(),
  status: z.enum([
    'ok',
    'error',
    'no_new_records',
    'skipped_no_connector',
    'template_not_found',
    'render_error',
    'in_progress',
    'config_invalid',
    'partial_failure',
  ]),
  records_processed: z.number().int(),
  error_message: z.string().nullable(),
  kind: z.enum(['cron', 'manual', 'webhook']),
  triggered_by_user_id: z.string().nullable(),
  created_at: isoTime,
});

export const runList = z.object({
  items: z.array(runRow),
  total: z.number().int().nullable().describe('The matching run count; `total_kind` says whether it is exact.'),
  total_kind: totalKind,
});

/** `?limit=` of a run list: 1..200, default 50; anything else falls back to 50 (never refused). */
export const runsLimit = z
  .string()
  .optional()
  .describe('Page size, default 50, capped at 200. A non-positive or non-numeric value falls back to 50 (never refused).');
