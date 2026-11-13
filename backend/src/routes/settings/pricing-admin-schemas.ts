// src/routes/settings/pricing-admin-schemas.ts
//
// The markup-rule body schema of POST /api/admin/pricing/markup-rules, moved
// verbatim out of routes/settings/pricing-admin.ts (fr-agui P4c part 3) so the
// capability declaration (capabilities/admin/pricing.ts) describes the SAME
// contract the handler enforces. Side-effect free: zod only. The § GLOBAL SCOPE
// reasoning stays beside the handler that applies it.

import { z } from 'zod';

export const MARKUP_GLOBAL_ACK_FIELD = 'global_scope_acknowledged';

/**
 * Shape gate for the markup-rule body. `.strict()` follows the neighbouring body
 * schemas (`routes/connectors.ts TestConnectionBody`,
 * `routes/project-request-repo-access.ts VerifyRepoAccessBody`) and is the point:
 * the ack field must be a DECLARED part of the contract, not an extra key that
 * rides along unnoticed. An unknown key is a 422 (`statusForError`, `handleError`)
 * — fail-closed on a money-writing route, and it names the offending key, so a
 * field added to the UI without being added here fails loudly rather than being
 * silently dropped at billing.
 *
 * NUMERICs stay strings-or-numbers and are NOT coerced or trimmed: billing owns
 * the arithmetic and this route is a verbatim proxy (`services/pricing-admin.ts`
 * posts `body` as given). The parse result is therefore used only as a verdict —
 * the ORIGINAL body is what gets forwarded.
 */
export const MarkupRuleBody = z
  .object({
    tenant_id: z.string().nullish(),
    license_id: z.string().nullish(),
    service_key: z.string().nullish(),
    provider: z.string().nullish(),
    model: z.string().nullish(),
    markup_pct: z.union([z.string(), z.number()]).nullish(),
    surcharge_input_per_1m_usd: z.union([z.string(), z.number()]).nullish(),
    surcharge_output_per_1m_usd: z.union([z.string(), z.number()]).nullish(),
    notes: z.string().nullish(),
    /**
     * Present ONLY on a deliberate global rule. See § GLOBAL SCOPE.
     * ⚠️ Spelled out rather than keyed off MARKUP_GLOBAL_ACK_FIELD on purpose: a
     * computed key would make the inferred shape depend on TS literal-key
     * widening. The constant exists so the ERROR MESSAGES cannot drift from it,
     * and `markupRuleBodyForUpstream` reads this key through it.
     */
    global_scope_acknowledged: z.boolean().optional(),
  })
  .strict();
