// tests/unit/capabilities/licensing-capabilities.test.ts
//
// fr-agui SPEC §13 P4c part 3 — the last P4c spec drain: the super-admin licensing
// console (40), pricing (9) and user provisioning (2). The routes the P4c-part-2 base
// (5162e7c69) pinned in GRANDFATHERED_UNDECLARED for them are declared as capabilities
// with NO behaviour change. Pinned here:
//
//   * the NEW set is EXACTLY those former pins — plus the two budget operations added
//     later (reset / per-licence adjust) — each on the handler the route table used;
//   * tenancy 'platform' (no handler reads the request tenant), agent exclusion,
//     operationId = camelCase(id), principal 'user';
//   * licence: none of these routes is on the licence allowlist;
//   * 🔐 secrets: the raw licence tokens (grant, mint, rotation), the token a revoke
//     names, the provisioning one-time secrets (temporary password + tokens, per seat
//     too) and a BYO provider key in the inference block — and nothing in pricing;
//   * the declared inputs ARE the routes' schemas (moved to side-effect-free modules);
//     strict exactly where the handler refuses an unknown key; forwarded bodies carry
//     the upstream's real types (`.passthrough()`);
//   * no router.add row is left for them; the FX-rate pair (literal spec operations) stays.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { extractJsonSchema } from '../../../src/capabilities/json-schema';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { InferenceInputSchema } from '../../../src/lib/inference-input-schema';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import * as licSchemas from '../../../src/routes/admin/licenses-admin-schemas';
import * as superAdminSchemas from '../../../src/routes/admin/super-admin-schemas';
import { TopupBody } from '../../../src/routes/me/budget-topup-schemas';
import { MarkupRuleBody } from '../../../src/routes/settings/pricing-admin-schemas';
import { ALL, BODIES, byId, paramsOf } from './p4c3-fixtures';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the P4c-part-3 pins of check-route-spec-coverage.ts @ 5162e7c69. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['DELETE', '/api/admin/licenses/tenants/{nameOrId}/apps/{appKey}/byo-mode', 'handleClearTenantAppByoMode'],
  ['POST', '/api/admin/licenses/apps', 'handleCreateApp'],
  ['POST', '/api/admin/licenses/grants/user/{subjectId}', 'handleCreateLicense'],
  ['POST', '/api/admin/licenses/offerings', 'handleCreateOffering'],
  ['POST', '/api/admin/licenses/plans', 'handleCreatePlan'],
  ['POST', '/api/admin/licenses/regions', 'handleCreateRegion'],
  ['POST', '/api/admin/licenses/tenants', 'handleCreateTenant'],
  ['DELETE', '/api/admin/licenses/apps/{appId}', 'handleDeleteApp'],
  ['DELETE', '/api/admin/licenses/offerings/{appKey}/{code}', 'handleDeleteOffering'],
  ['DELETE', '/api/admin/licenses/plans/{planId}', 'handleDeletePlan'],
  ['DELETE', '/api/admin/licenses/grants/user/{subjectId}', 'handleDeleteSubjectLicenses'],
  ['POST', '/api/admin/super-admin/deprovision-user', 'handleDeprovisionUser'],
  ['GET', '/api/admin/licenses/apps/{appId}', 'handleGetApp'],
  ['GET', '/api/admin/licenses/tenants/{nameOrId}/byo-mode', 'handleGetByoMode'],
  ['GET', '/api/admin/pricing/markup-config', 'handleGetMarkupConfig'],
  ['GET', '/api/admin/licenses/offerings/{appKey}/{code}', 'handleGetOffering'],
  ['GET', '/api/admin/licenses/tenants/{nameOrId}', 'handleGetTenant'],
  ['GET', '/api/admin/licenses/budget/{tenantId}', 'handleGetTenantBudget'],
  ['GET', '/api/admin/pricing/tenant-config/{tenantId}', 'handleGetTenantConfig'],
  ['GET', '/api/admin/licenses/tenants/{nameOrId}/seat-count', 'handleGetTenantSeatCount'],
  ['GET', '/api/admin/pricing/access-charges', 'handleListAccessCharges'],
  ['GET', '/api/admin/licenses/grants', 'handleListAllLicenses'],
  ['GET', '/api/admin/licenses/apps/{appId}/licenses', 'handleListAppLicenses'],
  ['GET', '/api/admin/licenses/apps/{appId}/plans', 'handleListAppPlans'],
  ['GET', '/api/admin/licenses/apps', 'handleListApps'],
  ['GET', '/api/admin/licenses/budget-packages', 'handleListBudgetPackages'],
  ['GET', '/api/admin/pricing/markup-rules', 'handleListMarkupRules'],
  ['GET', '/api/admin/licenses/offerings', 'handleListOfferings'],
  ['GET', '/api/admin/licenses/plans', 'handleListPlans'],
  ['GET', '/api/admin/pricing/provider-pricing', 'handleListProviderPricing'],
  ['GET', '/api/admin/licenses/regions', 'handleListRegions'],
  ['GET', '/api/admin/licenses/grants/user/{subjectId}', 'handleListSubjectLicenses'],
  ['GET', '/api/admin/licenses/tenants/{nameOrId}/offerings', 'handleListTenantOfferings'],
  ['GET', '/api/admin/licenses/tenants', 'handleListTenants'],
  ['POST', '/api/admin/licenses/grants/{licenseId}/tokens', 'handleMintToken'],
  ['POST', '/api/admin/licenses/tenants/{nameOrId}/offerings/{appKey}/{code}', 'handleProvisionTenantOffering'],
  ['POST', '/api/admin/super-admin/provision-user', 'handleProvisionUser'],
  ['PUT', '/api/admin/pricing/tenant-config/{tenantId}', 'handlePutTenantConfig'],
  ['POST', '/api/admin/licenses/grants/{licenseId}/regenerate-token', 'handleRegenerateToken'],
  ['PATCH', '/api/admin/licenses/tenants/{nameOrId}', 'handleRenameTenant'],
  ['POST', '/api/admin/licenses/grants/revoke', 'handleRevoke'],
  ['GET', '/api/admin/licenses/users', 'handleSearchUsers'],
  ['PUT', '/api/admin/licenses/tenants/{nameOrId}/apps/{appKey}/byo-mode', 'handleSetTenantAppByoMode'],
  ['PATCH', '/api/admin/licenses/tenants/{nameOrId}/archive', 'handleSetTenantArchived'],
  ['PATCH', '/api/admin/licenses/tenants/{nameOrId}/byo-mode', 'handleSetTenantByoMode'],
  ['POST', '/api/admin/licenses/budget/topup/{tenantId}', 'handleTopUpTenant'],
  // Budget reset + per-licence adjust (the super-admin budgets screen): NEW operations, not
  // former pins — recorded here so this suite still enumerates the whole licensing group.
  ['POST', '/api/admin/licenses/budget/reset/{tenantId}', 'handleResetTenantBudget'],
  ['PATCH', '/api/admin/licenses/budget/line/{licenseId}', 'handleAdjustLicenseBudget'],
  ['DELETE', '/api/admin/licenses/tenants/{nameOrId}/offerings/{appKey}/{code}', 'handleUnprovisionTenantOffering'],
  ['PATCH', '/api/admin/licenses/plans/{planId}', 'handleUpdatePlan'],
  ['POST', '/api/admin/pricing/access-charges', 'handleUpsertAccessCharge'],
  ['POST', '/api/admin/pricing/markup-rules', 'handleUpsertMarkupRule'],
  ['POST', '/api/admin/pricing/provider-pricing', 'handleUpsertProviderPricing'],
];

const IDS = new Set(ALL.map((c) => c.id));
const p4c3 = CAPABILITIES.filter((e) => IDS.has(e.cap.id));
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;
const keysOf = (s: unknown) => Object.keys((extractJsonSchema(s) as { properties?: object }).properties ?? {}).sort();

describe('P4c part 3 — the declarations', () => {
  test('the NEW operations are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    const declared = p4c3.map((e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const);
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
    for (const { cap: c } of p4c3) expect(c.openapi?.frozen).toBeUndefined();
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of p4c3) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${c.id} ${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(`${c.id} ${ref.module}#${ref.exportName}: function`);
    }
  });

  test("tenancy 'platform' (the target is the path / body / X-Target-Tenant-Id, never the request tenant), agent exclusion, principal; operationId = camelCase(id)", () => {
    for (const { cap: c } of p4c3) {
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.auth.principal} ${c.http.operationId}`).toBe(
        `${c.id} platform {"expose":false,"reason":"out-of-agent-scope"} user ${camel(c.id)}`,
      );
    }
  });

  test('the routes are no longer router.add rows (deriveRouter registers them); the FX-rate pair too since P4d-2d (frozen)', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    for (const { cap: c } of p4c3) {
      const re = new RegExp(`\\.add\\(\\s*'${c.http.method}',\\s*'${c.http.path!.replace(/[/.-]/g, '\\$&')}'`);
      expect(`${c.id} ${re.test(server)}`).toBe(`${c.id} false`);
    }
    for (const m of ["'./routes/admin/licenses-admin'", "'./routes/admin/super-admin'"]) expect(server).not.toContain(`from ${m}`);
    // P4d-2d declared the FX-rate pair (frozen literal operations, capabilities/platform/admin-frozen.ts).
    expect(server).not.toContain("from './routes/settings/pricing-admin'");
    expect(server).toContain('// GET /api/admin/pricing/fx-rates is capability-derived (P4d-2d');
    expect(server).toContain('// PUT /api/admin/pricing/fx-rates is capability-derived (P4d-2d');
  });

  test("effects: GETs read; deletes, the revoke, the token rotation and the offboard destructive; success statuses are the handlers' own", () => {
    for (const { cap: c } of p4c3) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm}`).toBe(`${c.id} destructive card-typed`);
    }
    expect(p4c3.filter((e) => e.cap.effect === 'destructive' && e.cap.http.method !== 'DELETE').map((e) => e.cap.id).sort()).toEqual([
      'licensing.regenerate_token', 'licensing.reset_tenant_budget', 'licensing.revoke', 'provisioning.deprovision_user',
    ]);
    const nonDefault = Object.fromEntries(p4c3.filter((e) => e.cap.http.successStatus !== undefined).map((e) => [e.cap.id, e.cap.http.successStatus]));
    expect(nonDefault).toEqual({
      'licensing.create_app': 201, 'licensing.create_plan': 201, 'licensing.delete_plan': 204, 'licensing.create_region': 201,
      'licensing.create_grant': 201, 'licensing.mint_token': 201, 'licensing.create_tenant': 201, 'licensing.clear_tenant_app_byo_mode': 204,
      'licensing.top_up_tenant': 201, 'licensing.create_offering': 201, 'licensing.delete_offering': 204, 'licensing.provision_tenant_offering': 201,
      'pricing.upsert_provider_pricing': 201, 'pricing.upsert_markup_rule': 201, 'pricing.upsert_access_charge': 201,
      'provisioning.provision_user': 201,
    });
    // The top-up's idempotent replay (200) is declared beside its 201.
    expect(byId('licensing.top_up_tenant').openapi?.responses?.some((r) => r.status === 200)).toBe(true);
  });
});

describe('P4c part 3 — licence: none of these routes is allowlisted', () => {
  test('no route here is on the licence allowlist, and none declares licence ops', () => {
    for (const { cap: c } of p4c3) {
      expect(`${c.id} ${LICENCE_ROUTE_ALLOWLIST.some((r) => r.method === c.http.method && r.pattern === c.http.path)}`).toBe(`${c.id} false`);
      expect(c.licence).toBeUndefined();
    }
  });
});

describe('P4c part 3 — 🔐 secrets and inputs', () => {
  test('the declared secrets: raw licence tokens out, a named token in, the provisioning one-time secrets, a BYO provider key; nothing in pricing', () => {
    expect(Object.fromEntries(p4c3.filter((e) => e.cap.secrets !== undefined).map((e) => [e.cap.id, e.cap.secrets]))).toEqual({
      'licensing.revoke': { input: ['/token'] },
      'licensing.create_grant': { output: ['/token'] },
      'licensing.mint_token': { output: ['/token'] },
      'licensing.regenerate_token': { output: ['/token'] },
      'provisioning.provision_user': {
        input: ['/inference/byo_keys/api_key'],
        output: ['/temporary_password', '/tokens', '/seats/temporary_password', '/seats/tokens'],
      },
    });
  });

  test("the shared schemas ARE the routes' (moved to side-effect-free modules)", () => {
    expect(byId('licensing.create_app').input).toBe(licSchemas.CreateAppBody);
    expect(byId('licensing.create_plan').input).toBe(licSchemas.CreatePlanBody);
    expect(byId('licensing.create_region').input).toBe(licSchemas.CreateRegionBody);
    expect(byId('licensing.revoke').input).toBe(licSchemas.RevokeBody);
    expect(byId('licensing.create_tenant').input).toBe(licSchemas.CreateTenantBody);
    expect(byId('pricing.upsert_markup_rule').input).toBe(MarkupRuleBody);
    expect(byId('provisioning.provision_user').input).toBe(superAdminSchemas.ProvisionUserBody);
    expect(byId('provisioning.deprovision_user').input).toBe(superAdminSchemas.DeprovisionUserBody);
    // Composed (path parameters merged in): the moved schema's own keys, unchanged.
    for (const [id, schema] of [
      ['licensing.update_plan', licSchemas.UpdatePlanBody], ['licensing.create_grant', licSchemas.CreateLicenseBody],
      ['licensing.mint_token', licSchemas.MintTokenBody], ['licensing.set_tenant_archived', licSchemas.ArchiveTenantBody],
      ['licensing.rename_tenant', licSchemas.RenameTenantBody], ['licensing.set_tenant_byo_mode', licSchemas.ByoModeBody],
      ['licensing.set_tenant_app_byo_mode', licSchemas.ByoModeBody], ['licensing.top_up_tenant', TopupBody],
    ] as const) {
      expect(`${id} ${keysOf(byId(id).input).join(',')}`).toBe(`${id} ${[...Object.keys(paramsOf(byId(id))), ...keysOf(schema)].sort().join(',')}`);
    }
    // The offering body: fr's own (identity + posture) fields plus licences OfferingCreate's, end to end.
    expect(keysOf(licSchemas.CreateOfferingBody).every((k) => keysOf(byId('licensing.create_offering').input).includes(k))).toBe(true);
    // The provision body's inference block IS lib/inference-provisioning's schema (re-exported, the same object).
    const { InferenceInputSchema: viaProvisioning } = require('../../../src/lib/inference-provisioning') as { InferenceInputSchema: unknown };
    expect(viaProvisioning).toBe(InferenceInputSchema);
  });

  test('strict exactly where the handler refuses an unknown key (every console body but the offering; the markup rule; both provisioning bodies)', () => {
    const strict = p4c3.filter((e) => (extractJsonSchema(e.cap.input) as { additionalProperties?: unknown }).additionalProperties === false).map((e) => e.cap.id).sort();
    expect(strict).toEqual([
      'licensing.adjust_license_budget', 'licensing.create_app', 'licensing.create_grant', 'licensing.create_plan', 'licensing.create_region',
      'licensing.create_tenant', 'licensing.mint_token', 'licensing.rename_tenant', 'licensing.reset_tenant_budget', 'licensing.revoke',
      'licensing.set_tenant_app_byo_mode', 'licensing.set_tenant_archived',
      'licensing.set_tenant_byo_mode', 'licensing.top_up_tenant', 'licensing.update_plan',
      'pricing.upsert_markup_rule', 'provisioning.deprovision_user', 'provisioning.provision_user',
    ]);
    for (const id of strict) {
      const parsed = byId(id).input.safeParse({ ...paramsOf(byId(id)), ...(BODIES[id] as object), future: 1 });
      expect(`${id} ${parsed.success}`).toBe(`${id} false`);
    }
    // Forwarded verbatim: the upstream decides, so fr's declaration keeps unknown keys.
    for (const id of ['licensing.create_offering', 'pricing.upsert_provider_pricing', 'pricing.upsert_access_charge', 'pricing.put_tenant_config']) {
      const parsed = byId(id).input.safeParse({ ...paramsOf(byId(id)), ...(BODIES[id] as object), future: 1 }) as { success: boolean; data?: Record<string, unknown> };
      expect(`${id} ${parsed.success} ${parsed.data?.future}`).toBe(`${id} true 1`);
    }
  });

  test('forwarded bodies carry the upstream types (n8n-nodes-fr renders number / enum kinds from them)', () => {
    const props = (id: string) => (extractJsonSchema(byId(id).input) as { properties: Record<string, { type?: unknown; enum?: unknown; anyOf?: unknown }> }).properties;
    const typeOf = (v: { type?: unknown; anyOf?: unknown }) => v.type ?? (v.anyOf as Array<{ type?: unknown }> | undefined)?.[0]?.type;
    expect(typeOf(props('licensing.create_offering').access_price_usd!)).toBe('number');
    expect(props('licensing.create_offering').access_cadence!.enum).toEqual(['monthly', 'one_time']);
    expect(props('pricing.upsert_provider_pricing').cost_model!.enum).toEqual(['per_token', 'per_second', 'per_character', 'per_request', 'self_hosted_amortized']);
    expect(props('pricing.upsert_access_charge').cadence!.enum).toEqual(['monthly', 'one_time', 'per_seat']);
    expect(props('pricing.put_tenant_config').markup_pct!.type).toBe('number');
  });
});

describe('P4c part 3 — the served spec', () => {
  test('every NEW operation is tagged with a declared tag and carries its operationId', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const declaredTags = new Set((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags.map((t) => t.name));
    type Op = { tags: string[]; operationId: string; 'x-internal'?: boolean };
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
    for (const { cap: c } of p4c3) {
      const op = paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
      expect(op.operationId).toBe(c.http.operationId);
      expect(op.tags).toEqual([c.area === 'licensing' ? 'Licensing Console' : c.area === 'pricing' ? 'Pricing' : 'User Provisioning']);
      expect(declaredTags.has(op.tags[0]!)).toBe(true);
      expect(op['x-internal']).toBeUndefined();
    }
    // The FX-rate pair is untouched: still the literal operations under the same tag.
    expect(paths['/api/admin/pricing/fx-rates']!.get!.operationId).toBe('adminListFxRates');
    expect(paths['/api/admin/pricing/fx-rates']!.put!.operationId).toBe('adminPutFxRate');
  });
});
