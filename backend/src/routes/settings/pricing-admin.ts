// src/routes/settings/pricing-admin.ts
//
// Super-admin pricing management. Proxies billing-service's pricing config API
// (provider_pricing + markup_rules) so a platform super-admin can read/update
// rates from the fr UI instead of POSTing from inside a billing pod.
//
// AUTHORIZATION: platform super-admin only (the `super_admin` Keycloak realm
// role), enforced HERE at the fr route layer. The outbound call to billing is
// authenticated with a secure-apps service Bearer (the SA holds `license-admin`)
// via getSecureAppsAuthenticator() inside services/pricing-admin.ts — so the
// human never needs license-admin, only super_admin in fr. (`metering-internal`
// was retired fleet-wide 2026-07-16 and is not what authorises this.)
//
// RBAC (all super-admin):
//   GET  /api/admin/pricing/provider-pricing
//   POST /api/admin/pricing/provider-pricing   (upsert)
//   GET  /api/admin/pricing/markup-rules
//   POST /api/admin/pricing/markup-rules        (upsert) — see § GLOBAL SCOPE
//   GET  /api/admin/pricing/markup-config       (platform default markup)
//   GET  /api/admin/pricing/access-charges
//   POST /api/admin/pricing/access-charges      (upsert)

import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { AppError, BadRequestError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import {
  getMarkupConfig,
  getTenantConfig,
  listAccessCharges,
  listMarkupRules,
  listProviderPricing,
  putTenantConfig,
  upsertAccessCharge,
  upsertMarkupRule,
  upsertProviderPricing,
  listFxRates,
  putFxRate,
  type PricingRow,
} from '../../services/pricing-admin';
import { ownerPortalToken } from '../../lib/inference-provisioning';
import { MARKUP_GLOBAL_ACK_FIELD, MarkupRuleBody } from './pricing-admin-schemas';

// --- Deps ---------------------------------------------------------------

async function requireSuperAdmin(req: Request): Promise<void> {
  const user = await validateAuth(req);
  if (!isSuperAdmin(user)) {
    throw new AppError(403, 'super_admin role required');
  }
}

async function readBody(req: Request): Promise<PricingRow> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadRequestError('body must be valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestError('body must be a JSON object');
  }
  return raw as PricingRow;
}

/** GET /api/admin/pricing/provider-pricing — current effective provider_pricing rows. */
export async function handleListProviderPricing(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => listProviderPricing(),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/admin/pricing/provider-pricing — upsert a provider_pricing row. */
export async function handleUpsertProviderPricing(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readBody(req);
  return handle(
    () => upsertProviderPricing(body),
    (data) => jsonResponse({ data }, 201),
  );
}

/** GET /api/admin/pricing/markup-rules — current effective markup_rules. */
export async function handleListMarkupRules(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => listMarkupRules(),
    (data) => jsonResponse({ data }),
  );
}

// --- § GLOBAL SCOPE: the two requests that used to be one -------------------
//
// A markup_rule with no `tenant_id` is GLOBAL — it prices EVERY tenant. That is
// a legitimate, deliberate configuration (billing's own fallback story), so it
// must stay possible. The defect was that it was INDISTINGUISHABLE from the
// accident: "the operator never picked a tenant" and "the operator means every
// tenant" arrived as the same bytes, so neither this route nor billing could
// validate one without forbidding the other. fr's markup UI had a banner saying
// the tenant directory was unreadable and then saved the global rule anyway.
//
// ⛔ Why that is not merely untidy: fr publishes GET + POST on
// /api/admin/pricing/markup-rules and NOTHING else (server.ts:1596-1597) — there
// is no delete path in this product. A wrong global rule can only be SUPERSEDED
// by another rule for the same match-tuple, never removed from here. Whether
// billing itself offers a DELETE is unknown from this repo; do not assert either
// way in an error message.
//
// So: the intent gets its own field. A global rule now needs
// `global_scope_acknowledged: true`; without it the request is refused BEFORE the
// proxy call, because the write is the irreversible part.
// The ack field and the body schema (`MarkupRuleBody`) live in
// ./pricing-admin-schemas.ts (side-effect free, shared with the capability
// declaration in capabilities/admin/pricing.ts).

/** A rule is global when it names no tenant. `''` counts: it names none either. */
function isGlobalMarkupRule(body: z.infer<typeof MarkupRuleBody>): boolean {
  return String(body.tenant_id ?? '').trim() === '';
}

/**
 * Validate scope intent and return the body to forward.
 *
 * The ack is fr's own contract, not billing's, so it is STRIPPED before the
 * proxy hop — billing validates markup_rules with pydantic and an unknown field
 * there would turn fr's guard into an upstream 422.
 */
function markupRuleBodyForUpstream(raw: PricingRow): PricingRow {
  const parsed = MarkupRuleBody.parse(raw);
  const acknowledged = parsed[MARKUP_GLOBAL_ACK_FIELD] === true;
  const global = isGlobalMarkupRule(parsed);

  if (global && !acknowledged) {
    throw new BadRequestError(
      'a markup rule with no tenant_id is GLOBAL: it prices every tenant on the ' +
        'platform, and fr has no way to delete a markup rule afterwards — the only ' +
        `correction available here is another rule that supersedes it. Send ${MARKUP_GLOBAL_ACK_FIELD}: ` +
        'true to state that a global rule is intended. If one tenant was meant, set ' +
        'tenant_id instead: an omitted tenant_id is not the same request as a ' +
        'deliberate global rule.',
      { field: 'tenant_id', required: MARKUP_GLOBAL_ACK_FIELD },
    );
  }
  if (!global && acknowledged) {
    // Contradictory: the caller both named a tenant and declared the rule global.
    // Refused rather than silently resolved, because picking a winner here would
    // let a caller that sets the ack unconditionally look correct on both paths.
    throw new BadRequestError(
      `${MARKUP_GLOBAL_ACK_FIELD} declares a global rule, but tenant_id names one ` +
        'tenant. Send one or the other, so the request says which rule is intended.',
      { field: MARKUP_GLOBAL_ACK_FIELD, conflictsWith: 'tenant_id' },
    );
  }

  // Verbatim minus fr's own field. (Not `parsed`: `.strict()` already proved
  // there is nothing else, and re-emitting the parse result would risk changing
  // the bytes billing sees.)
  const forwarded: PricingRow = { ...raw };
  delete forwarded[MARKUP_GLOBAL_ACK_FIELD];

  // ⛔ THE REFUSAL DECISION AND THE FORWARDED BYTES MUST AGREE ON WHAT "GLOBAL"
  // IS, and until this line they did not. `isGlobalMarkupRule` trims, so
  // `tenant_id: '  '` is judged GLOBAL here — and then `{...raw}` handed billing
  // the two spaces VERBATIM. fr would have refused-or-acknowledged the request as
  // a platform-wide rule and asked billing to store a rule scoped to a tenant id
  // of `'  '`, which is neither global nor any real tenant. Whichever way billing
  // reads it (a 422, or a row matching nothing), fr's own guard has already been
  // satisfied, so the disagreement is invisible from this side. A validator
  // measured exactly this gap: the refusal path was tested, the forwarded payload
  // was not.
  //
  // Normalised to `null` rather than by deleting the key, and the choice is
  // evidence-based, not aesthetic: `null` is the representation fr's OWN frontend
  // already sends for a cleared tenant picker, so it is a byte-shape this
  // upstream demonstrably accepts for a global rule today. Deleting the key would
  // invent a third shape whose acceptance cannot be verified from this repo —
  // billing owns that pydantic model, and this route is a proxy.
  //
  // ⚠️ Only when the key is PRESENT. A body that omits `tenant_id` keeps omitting
  // it; adding `tenant_id: null` to a request that never mentioned the field would
  // change the bytes of the ordinary, already-working global path for no reason.
  if (global && 'tenant_id' in forwarded && forwarded.tenant_id !== null) {
    forwarded.tenant_id = null;
  }
  return forwarded;
}

/** POST /api/admin/pricing/markup-rules — upsert a markup_rule. */
export async function handleUpsertMarkupRule(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readBody(req);
  // Before `handle(...)`, i.e. before the proxy call: the POST is the
  // irreversible act, so a rule whose scope was never declared must never reach
  // billing. Validating the response instead of the request would be a no-op.
  const forwarded = markupRuleBodyForUpstream(body);
  return handle(
    () => upsertMarkupRule(forwarded),
    (data) => jsonResponse({ data }, 201),
  );
}

/**
 * GET /api/admin/pricing/markup-config — the platform default markup billing
 * charges when no markup_rule matches. The rules table can be (and in
 * production is) empty while this is being applied, so the UI needs the real
 * number rather than an unqualified "no rules".
 */
export async function handleGetMarkupConfig(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => getMarkupConfig(),
    (data) => jsonResponse({ data }),
  );
}

/** GET /api/admin/pricing/access-charges — current effective access charges. */
export async function handleListAccessCharges(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => listAccessCharges(),
    (data) => jsonResponse({ data }),
  );
}

/** POST /api/admin/pricing/access-charges — upsert a tenant access charge. */
export async function handleUpsertAccessCharge(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  const body = await readBody(req);
  return handle(
    () => upsertAccessCharge(body),
    (data) => jsonResponse({ data }, 201),
  );
}

/** GET /api/admin/pricing/tenant-config/:tenantId — a tenant's billing config. */
export async function handleGetTenantConfig(req: Request, tenantId: string): Promise<Response> {
  await requireSuperAdmin(req);
  if (!tenantId) throw new BadRequestError('tenantId is required');
  return handle(
    () => getTenantConfig(tenantId),
    (data) => jsonResponse({ data }),
  );
}

/** PUT /api/admin/pricing/tenant-config/:tenantId — set markup_pct + billing_mode. */
export async function handlePutTenantConfig(req: Request, tenantId: string): Promise<Response> {
  await requireSuperAdmin(req);
  if (!tenantId) throw new BadRequestError('tenantId is required');
  const body = await readBody(req);
  return handle(
    () => putTenantConfig(tenantId, body),
    (data) => jsonResponse({ data }),
  );
}

// --- USD→EUR FX (PLAN tenant-inference-provisioning §3.1) -------------------
//
// One currency pair today (USD→EUR): EUR money budgets consume `fx × USD price`.
// Billing effective-dates every row (a PUT opens a new rate and closes the open
// one); there is no delete. ⚠️ The FIRST rate should be back-dated
// (`effective_from`) to before the first money tenant's first call — events
// before the first rate settle with no consumption (billing config.py).

const FxRatePutBody = z
  .object({
    base: z.literal('USD'),
    quote: z.literal('EUR'),
    // A positive decimal string, as billing stores it (Numeric).
    rate: z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,8})?$/, 'rate must be a positive decimal, e.g. 0.9200').refine(
      (r) => Number(r) > 0,
      'rate must be greater than 0',
    ),
    effective_from: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/** GET /api/admin/pricing/fx-rates — every FX row, newest first. */
export async function handleListFxRates(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  return handle(
    () => listFxRates(),
    (data) => jsonResponse({ data }),
  );
}

/**
 * PUT /api/admin/pricing/fx-rates — open a new USD→EUR rate.
 *
 * Billing records WHO set the rate (`fx_rate.set_by`), so the signed-in owner's
 * own verified portal token is relayed with the write (services/pricing-admin.ts
 * putFxRate). No such token (a service account holding super_admin, an fr-agent
 * token) → 403 before billing is called, as on the tenant-inference routes:
 * the rate must never be attributed to fr's secure-apps SA.
 */
export async function handlePutFxRate(req: Request): Promise<Response> {
  await requireSuperAdmin(req);
  const parsed = FxRatePutBody.safeParse(await readBody(req));
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid request body', details: parsed.error.errors }, 422);
  }
  const ownerToken = await ownerPortalToken(req);
  if (!ownerToken) {
    throw new AppError(
      403,
      'owner_portal_token_required: the FX rate is recorded as set by the signed-in owner; ' +
        'no verified super_admin portal token was presented',
    );
  }
  return handle(
    () => putFxRate(parsed.data, ownerToken),
    (data) => jsonResponse({ data }),
  );
}
