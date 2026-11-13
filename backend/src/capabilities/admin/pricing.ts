// fr-agui SPEC §13 P4c part 3 — spec drain: super-admin pricing management
// (routes/settings/pricing-admin.ts: provider pricing, markup rules, the platform
// default markup, access charges, per-tenant billing config — 9 routes), re-expressed
// with NO behaviour change (`legacyHandler`). The USD→EUR FX routes were already
// literal spec operations and stay so.
//
// A verbatim proxy of billing_service `/api/config/*` (origin/main routers/config.py):
// fr answers `{ data }` (billing's `meta` dropped). Gate: `validateAuth` into the
// central catch (its doors), then the `super_admin` realm role (403 'super_admin role
// required'). No route reads the request tenant (a tenant is named in the path or the
// body): `tenancy: 'platform'`, `isAuthenticatedSuperAdmin`.
//
// Forwarded bodies are declared END TO END with billing's own request models
// (`.passthrough()`: fr forwards any JSON object verbatim; billing ignores unknown
// keys) — except the markup rule, whose fr-side schema is strict (`MarkupRuleBody`).
// Billing serialises NUMERIC money as decimal STRINGS. 🔐 No pricing input or output
// carries a credential or key: nothing is declared secret.
import { z } from 'zod';

import { MarkupRuleBody } from '../../routes/settings/pricing-admin-schemas';
import type { Capability } from '../define';
import { isAuthenticatedSuperAdmin } from '../rbac-rules';
import { pathId, routeRule, settingsCapabilities, standardResponses } from '../observe/_shared';

const BILLING =
  "Any billing status is relayed (`error.code` 'UPSTREAM_…'; its 4xx — e.g. a 422 validation list — pass through with their body, " +
  'its 401 / 5xx or no answer is 502, a timeout 504). ';
const GATE = "403: `error` 'super_admin role required' (not a super_admin). ";
const RAW_BODY = "400: `error` 'body must be valid JSON' or 'body must be a JSON object' (nothing sent). ";

/** A NUMERIC money value as billing serialises it. */
const dec = z.string().describe('A decimal, as billing serialises NUMERIC (a string).');
const decOrNull = dec.nullable();
/** A NUMERIC billing accepts on input: a decimal string or a number. */
const decIn = z.union([z.string(), z.number()]);

/** billing `ProviderPricingResponse`. */
const providerPricing = z
  .object({
    id: z.number().int(),
    provider: z.string(),
    model: z.string().nullable(),
    service_key: z.string().nullable(),
    rate_class: z.string().describe("'cost' (authoritative) or 'list' (public list price, the BYO estimate)."),
    cost_model: z.string(),
    cost_basis: z.string().describe("'cash' or 'internal_transfer'."),
    input_per_1m_usd: decOrNull,
    output_per_1m_usd: decOrNull,
    cache_creation_per_1m_usd: decOrNull,
    cache_read_per_1m_usd: decOrNull,
    per_request_usd: decOrNull,
    monthly_fixed_cost_usd: decOrNull,
    effective_from: z.string(),
    effective_until: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .passthrough();

/** billing `ProviderPricingCreate`, forwarded verbatim. */
const providerPricingIn = z
  .object({
    provider: z.string(),
    model: z.string().nullable().optional(),
    service_key: z.string().nullable().optional().describe('null = any service_key for this (provider, model).'),
    rate_class: z.enum(['cost', 'list']).optional(),
    cost_model: z.enum(['per_token', 'per_second', 'per_character', 'per_request', 'self_hosted_amortized']),
    cost_basis: z.enum(['cash', 'internal_transfer']).optional().describe("Default 'internal_transfer'; a real vendor charge is 'cash'."),
    input_per_1m_usd: decIn.nullable().optional(),
    output_per_1m_usd: decIn.nullable().optional(),
    cache_creation_per_1m_usd: decIn.nullable().optional(),
    cache_read_per_1m_usd: decIn.nullable().optional(),
    per_request_usd: decIn.nullable().optional(),
    monthly_fixed_cost_usd: decIn.nullable().optional(),
    effective_from: z.string().optional().describe('ISO-8601; default now.'),
    effective_until: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough()
  .describe("Forwarded verbatim to billing (ProviderPricingCreate). billing refuses a row its cost_model cannot price (422).");

/** billing `MarkupRuleResponse`. */
const markupRule = z
  .object({
    id: z.number().int(),
    tenant_id: z.string().nullable(),
    license_id: z.string().nullable(),
    project_id: z.string().nullable(),
    service_key: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    byo: z.boolean().nullable(),
    markup_pct: decOrNull,
    surcharge_input_per_1m_usd: decOrNull,
    surcharge_output_per_1m_usd: decOrNull,
    surcharge_cache_creation_per_1m_usd: decOrNull,
    surcharge_cache_read_per_1m_usd: decOrNull,
    surcharge_per_request_usd: decOrNull,
    effective_from: z.string(),
    effective_until: z.string().nullable(),
    notes: z.string().nullable(),
    specificity: z.number().int().nullable(),
  })
  .passthrough();

/** billing `AccessChargeResponse`. */
const accessCharge = z
  .object({
    id: z.number().int(),
    tenant_id: z.string(),
    service_key: z.string().nullable(),
    amount_usd: dec,
    cadence: z.string().describe("'monthly', 'one_time' or 'per_seat'."),
    included_cost_usd: decOrNull,
    effective_from: z.string(),
    effective_until: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .passthrough();

/** billing `AccessChargeCreate`, forwarded verbatim. */
const accessChargeIn = z
  .object({
    tenant_id: z.string().describe('Required: an access charge is tenant-scoped (a registered name resolves too).'),
    service_key: z.string().nullable().optional().describe('null = tenant-wide (every product).'),
    amount_usd: decIn,
    cadence: z.enum(['monthly', 'one_time', 'per_seat']).optional().describe("Default 'monthly'; 'per_seat' multiplies by the seat count."),
    included_cost_usd: decIn.nullable().optional().describe('Included-usage allowance (refused on per_seat).'),
    effective_from: z.string().optional(),
    effective_until: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough()
  .describe('Forwarded verbatim to billing (AccessChargeCreate).');

/** billing `TenantConfigResponse`. */
const tenantConfig = z
  .object({
    tenant_id: z.string(),
    markup_pct: z.number(),
    billing_mode: z.string().describe("'standard_markup', 'byo_platform_fee', 'byo_markup_only' or 'pass_through'."),
    notes: z.string().nullable(),
  })
  .passthrough();

const tenantId = { tenantId: pathId('The tenant (id, or a name billing resolves)') };

const ROUTES = settingsCapabilities(
  {
    area: 'pricing', tag: 'Pricing', tenancy: 'platform',
    module: 'src/routes/settings/pricing-admin.ts', load: () => import('../../routes/settings/pricing-admin'),
    rule: routeRule(isAuthenticatedSuperAdmin),
  },
  [
    {
      id: 'pricing.list_provider_pricing', method: 'GET', path: '/api/admin/pricing/provider-pricing', handler: 'handleListProviderPricing', effect: 'read',
      summary: 'The currently effective provider pricing rows (billing)',
      input: z.object({}),
      output: z.object({ data: z.array(providerPricing) }),
      responses: standardResponses(GATE + BILLING),
    },
    {
      id: 'pricing.upsert_provider_pricing', method: 'POST', path: '/api/admin/pricing/provider-pricing', handler: 'handleUpsertProviderPricing', effect: 'write', successStatus: 201,
      summary: 'Open a new effective-dated provider pricing row (closes the open one for the same provider + model)',
      input: providerPricingIn,
      output: z.object({ data: providerPricing }),
      responses: standardResponses(GATE + RAW_BODY + BILLING),
    },
    {
      id: 'pricing.list_markup_rules', method: 'GET', path: '/api/admin/pricing/markup-rules', handler: 'handleListMarkupRules', effect: 'read',
      summary: 'The currently effective markup rules (billing)',
      input: z.object({}),
      output: z.object({ data: z.array(markupRule) }),
      responses: standardResponses(GATE + BILLING),
    },
    {
      id: 'pricing.upsert_markup_rule', method: 'POST', path: '/api/admin/pricing/markup-rules', handler: 'handleUpsertMarkupRule', effect: 'write', successStatus: 201,
      summary: 'Open a new effective-dated markup rule (closes the open one for the same match tuple)',
      description:
        'A rule with no `tenant_id` is GLOBAL (it prices every tenant, and fr cannot delete a markup rule): it needs ' +
        '`global_scope_acknowledged: true`, which a tenant rule must not send. fr strips the ack and forwards the rest verbatim. ' +
        "The body is strict: billing's `project_id`, `byo`, cache / per-request surcharges and effective dates cannot be sent here.",
      input: MarkupRuleBody,
      output: z.object({ data: markupRule }),
      responses: standardResponses(
        GATE + RAW_BODY +
          "422: `error` 'Validation error' (`details`: an unknown key or a wrong type; nothing sent). 400: a global rule without " +
          '`global_scope_acknowledged`, or the ack beside a `tenant_id` (`details`: the field). ' + BILLING,
      ),
    },
    {
      id: 'pricing.get_markup_config', method: 'GET', path: '/api/admin/pricing/markup-config', handler: 'handleGetMarkupConfig', effect: 'read',
      summary: 'The platform default markup (applied when no markup rule matches)',
      input: z.object({}),
      output: z.object({ data: z.object({ default_markup_pct: z.number() }).passthrough() }),
      responses: standardResponses(GATE + BILLING),
    },
    {
      id: 'pricing.list_access_charges', method: 'GET', path: '/api/admin/pricing/access-charges', handler: 'handleListAccessCharges', effect: 'read',
      summary: 'The currently effective tenant access charges (billing)',
      input: z.object({}),
      output: z.object({ data: z.array(accessCharge) }),
      responses: standardResponses(GATE + BILLING),
    },
    {
      id: 'pricing.upsert_access_charge', method: 'POST', path: '/api/admin/pricing/access-charges', handler: 'handleUpsertAccessCharge', effect: 'write', successStatus: 201,
      summary: 'Open a new effective-dated access charge (closes the open one for the same tenant + product)',
      input: accessChargeIn,
      output: z.object({ data: accessCharge }),
      responses: standardResponses(GATE + RAW_BODY + BILLING),
    },
    {
      id: 'pricing.get_tenant_config', method: 'GET', path: '/api/admin/pricing/tenant-config/:tenantId', handler: 'handleGetTenantConfig', effect: 'read',
      summary: "A tenant's billing config (markup, billing mode)",
      description: 'A tenant with no row answers the platform defaults.',
      input: z.object(tenantId),
      output: z.object({ data: tenantConfig }),
      responses: standardResponses(GATE + BILLING),
    },
    {
      id: 'pricing.put_tenant_config', method: 'PUT', path: '/api/admin/pricing/tenant-config/:tenantId', handler: 'handlePutTenantConfig', effect: 'write',
      summary: "Set a tenant's markup and billing mode (upsert)",
      input: z
        .object({
          ...tenantId,
          markup_pct: z.number().min(0),
          billing_mode: z.enum(['standard_markup', 'byo_platform_fee', 'byo_markup_only', 'pass_through']).nullable().optional().describe('Omitted / null keeps the current mode.'),
          notes: z.string().nullable().optional(),
        })
        .passthrough()
        .describe('Forwarded verbatim to billing (TenantConfigUpdate).'),
      output: z.object({ data: tenantConfig }),
      responses: standardResponses(GATE + RAW_BODY + BILLING),
    },
  ],
);

export const PRICING_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = ROUTES;
