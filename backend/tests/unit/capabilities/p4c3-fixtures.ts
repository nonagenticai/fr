// tests/unit/capabilities/p4c3-fixtures.ts
//
// Shared fixtures for the fr-agui P4c part-3 suites (licensing-*.test.ts): the 51
// capabilities (the licensing console, pricing, user provisioning), the concrete
// request each probe sends (path parameters, the query / body / `X-Target-Tenant-Id`
// header each handler's own validation needs before it decides anything else). No
// database is touched and no mock.module() is used.
import { LICENSING_CAPABILITIES } from '../../../src/capabilities/admin/licensing';
import { PRICING_CAPABILITIES } from '../../../src/capabilities/admin/pricing';
import { PROVISIONING_CAPABILITIES } from '../../../src/capabilities/admin/provisioning';
import type { Capability } from '../../../src/capabilities/define';
import { pathParams } from '../../../src/capabilities/derive-openapi';

export { storeChain, urlOf } from './p4c1-fixtures';

export const HOME = 'a100000c-0000-4000-8000-00000000000e';
export const OTHER = 'b200000d-0000-4000-8000-00000000000f';
export const UUID = '0195f48b-d000-7000-8000-0000000000c3';
export const T0 = '2026-10-01T00:00:00.000Z';

type Cap = Capability<unknown, unknown>;
export const LICENSING: ReadonlyArray<Cap> = LICENSING_CAPABILITIES;
export const PRICING: ReadonlyArray<Cap> = PRICING_CAPABILITIES;
export const PROVISIONING: ReadonlyArray<Cap> = PROVISIONING_CAPABILITIES;
export const ALL: ReadonlyArray<Cap> = [...LICENSING, ...PRICING, ...PROVISIONING];

export const byId = (id: string): Cap => {
  const c = ALL.find((x) => x.id === id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
};

/** A concrete value per path parameter name (`appKey`: an app fr issues). */
const PARAM: Record<string, string> = {
  appId: UUID, planId: UUID, subjectId: 'u-target', licenseId: UUID, nameOrId: 'acme', appKey: 'fr-frontend', code: 'std', tenantId: HOME,
};
export const paramsOf = (cap: Cap): Record<string, string> =>
  Object.fromEntries(pathParams(cap.http.path!).map((p) => [p, PARAM[p] ?? UUID]));
export const hasBody = (cap: Cap): boolean => cap.http.method !== 'GET' && cap.http.method !== 'DELETE';

/** The query each probe sends. */
export const QUERIES: Record<string, Record<string, string>> = {
  'licensing.search_users': { q: 'al' },
};

/** The routes that REQUIRE `X-Target-Tenant-Id` (400 before anything is sent without it). */
export const TARGET_TENANT_IDS = new Set(['licensing.list_subject_grants', 'licensing.create_grant', 'licensing.delete_subject_grants', 'licensing.revoke']);
export const headersOf = (cap: Cap): Record<string, string> => (TARGET_TENANT_IDS.has(cap.id) ? { 'X-Target-Tenant-Id': HOME } : {});

export const BODIES: Record<string, unknown> = {
  'licensing.create_app': { key: 'demo-x', name: 'Demo' },
  'licensing.create_plan': { app_id: UUID, code: 'std', name: 'Standard' },
  'licensing.update_plan': { name: 'Renamed' },
  'licensing.create_region': { code: 'eu', name: 'EU' },
  'licensing.revoke': { license_id: UUID },
  'licensing.create_grant': { app_id: UUID, plan_id: UUID },
  'licensing.mint_token': {},
  'licensing.create_tenant': { name: 'acme' },
  'licensing.set_tenant_archived': { archived: true },
  'licensing.rename_tenant': { name: 'acme-two' },
  'licensing.set_tenant_byo_mode': { byo_mode: 'byo_required' },
  'licensing.set_tenant_app_byo_mode': { byo_mode: 'byo_required' },
  'licensing.top_up_tenant': { package_id: 'tokens_1m', idempotency_key: 'idem-key-0001' },
  'licensing.reset_tenant_budget': { reason: 'counters were stale after the metering outage' },
  'licensing.adjust_license_budget': { token_budget_override: 5_000_000 },
  'licensing.create_offering': { app_key: 'fr-frontend', code: 'std', name: 'Std', byo_mode: 'local_allowed' },
  'pricing.upsert_provider_pricing': { provider: 'pgx-local', cost_model: 'per_token', input_per_1m_usd: '0.10' },
  'pricing.upsert_markup_rule': { tenant_id: HOME, markup_pct: '20' },
  'pricing.upsert_access_charge': { tenant_id: HOME, amount_usd: '10' },
  'pricing.put_tenant_config': { markup_pct: 20 },
  'provisioning.provision_user': { email: 'new@test', name: 'New', tenant_slug: 'acme', workspace_role: 'member' },
  'provisioning.deprovision_user': { email: 'new@test', tenant_slug: 'acme' },
};

/** The path a probe hits, with its parameters and query filled in. */
export function urlFor(cap: Cap, query: Record<string, string> = QUERIES[cap.id] ?? {}): string {
  const params = paramsOf(cap);
  const path = cap.http.path!.replace(/:(\w+)/g, (_m, k: string) => encodeURIComponent(params[k]!));
  const qs = new URLSearchParams(query).toString();
  return `http://test${path}${qs ? `?${qs}` : ''}`;
}

/** The input the DECLARED rule sees: path parameters, the query and the body together. */
export function inputOf(cap: Cap, query: Record<string, string> = QUERIES[cap.id] ?? {}, body: unknown = BODIES[cap.id]): Record<string, unknown> {
  return { ...paramsOf(cap), ...query, ...((hasBody(cap) ? body : undefined) ?? {}) as Record<string, unknown> };
}
