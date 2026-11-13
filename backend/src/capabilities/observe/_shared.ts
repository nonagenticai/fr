// fr-agui SPEC §13 P4c (part 1) — spec drain, tenant and platform oversight: what
// the declarations in capabilities/observe/* and capabilities/admin/* share.
//
// ⛔ Side-effect free (define.ts): zod and pure helpers only; handlers bind late.
//
// Every route keeps its handler (`legacyHandler`), so nothing changes at runtime;
// each declaration is the route CONTRACT for the derived spec. Every NEW operation
// gets operationId = camelCase(id) (SPEC §3.3) and is `out-of-agent-scope` (SPEC §13
// Deferred: tenant and platform administration stay in the classic UI). None of
// these routes is on the licence route allowlist.
import { z } from 'zod';

export {
  DOOR_403,
  FR_500,
  LICENCE_ROUTE_DOOR_403,
  VALIDATE_AUTH_401,
  caughtAuthResponses,
  frErrorBody,
  isoTime,
  pathId,
  routeRule,
  settingsCapabilities,
  standardResponses,
  unauthorizedBody,
  workspaceAdminRule,
  type SettingsRoute,
} from '../account/_shared';

/** services/read-models/_lib.ts `BlockMeta`: one block's provenance, freshness and availability. */
export const blockMeta = z
  .object({
    source: z.string(),
    fetched_at: z.string().describe('ISO-8601: when the block resolved (success or failure).'),
    available: z.boolean().describe('false: `data` is null and `error` says why (sanitized).'),
    confidence: z.literal('derived').optional().describe('Computed by joining sources in fr, not read from an authoritative registry.'),
    unavailable_kind: z.enum(['no_selection', 'no_data', 'data_gap', 'no_evidence', 'error']).optional(),
    error: z.string().optional(),
    unavailable: z.literal('no_evidence').optional(),
    note: z.string().optional(),
  })
  .describe('Block provenance (services/read-models/_lib.ts BlockMeta).');

/** A read-model block (`Block<T>`): `data` null exactly when `meta.available` is false. */
export function blockOf(data: z.ZodTypeAny) {
  return z.object({ data: data.nullable(), meta: blockMeta });
}
