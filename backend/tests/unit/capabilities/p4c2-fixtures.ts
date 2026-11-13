// tests/unit/capabilities/p4c2-fixtures.ts
//
// Shared fixtures for the fr-agui P4c part-2 suites (admin-*.test.ts): the 40
// capabilities (the asset console, platform
// access, the system usage rollup, the platform cord list, the caller's two role bits, asset-scope promote), the concrete request each probe sends
// (path parameters, the query / body each handler's own validation accepts). No
// database is touched and no mock.module() is used.
import { ANDON_STATE_CAPABILITIES } from '../../../src/capabilities/admin/andon';
import { ASSET_SCOPE_PROMOTE_CAPABILITIES } from '../../../src/capabilities/admin/asset-scope';
import { ASSET_CONSOLE_CAPABILITIES } from '../../../src/capabilities/admin/assets';
import { ADMIN_USER_CAPABILITIES, SYSTEM_USAGE_CAPABILITIES } from '../../../src/capabilities/admin/platform';
import { MY_DEPT_ROLE_CAPABILITIES, MY_SUPER_ADMIN_CAPABILITIES } from '../../../src/capabilities/account/me';
import type { Capability } from '../../../src/capabilities/define';
import { pathParams } from '../../../src/capabilities/derive-openapi';

export { storeChain, urlOf } from './p4c1-fixtures';

export const HOME = 'a100000c-0000-4000-8000-00000000000c';
export const OTHER = 'b200000d-0000-4000-8000-00000000000d';
export const UUID = '0195f48b-d000-7000-8000-0000000000c2';
export const T0 = '2026-10-01T00:00:00.000Z';

type Cap = Capability<unknown, unknown>;
export const CONSOLE: ReadonlyArray<Cap> = ASSET_CONSOLE_CAPABILITIES;
export const PLATFORM_CAPS: ReadonlyArray<Cap> = [
  ...ADMIN_USER_CAPABILITIES, ...SYSTEM_USAGE_CAPABILITIES, ...ANDON_STATE_CAPABILITIES,
];
export const SELF_CAPS: ReadonlyArray<Cap> = [...MY_SUPER_ADMIN_CAPABILITIES, ...MY_DEPT_ROLE_CAPABILITIES];
export const ALL: ReadonlyArray<Cap> = [...CONSOLE, ...PLATFORM_CAPS, ...SELF_CAPS, ...ASSET_SCOPE_PROMOTE_CAPABILITIES];

export const byId = (id: string): Cap => {
  const c = ALL.find((x) => x.id === id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
};

/** A concrete value per path parameter name. */
const PARAM: Record<string, string> = {
  id: UUID, name: 'proc-1', projectId: 'card-1', executionId: 'exec-1', correlationId: 'corr-1', userId: 'u-target',
  assetType: 'principle', assetId: UUID,
};
export const paramsOf = (cap: Cap): Record<string, string> =>
  Object.fromEntries(pathParams(cap.http.path!).map((p) => [p, PARAM[p] ?? UUID]));
export const hasBody = (cap: Cap): boolean => cap.http.method !== 'GET' && cap.http.method !== 'DELETE';

/** The query each probe sends: what the handler needs before it decides anything else. */
export const QUERIES: Record<string, Record<string, string>> = {
  'admin_users.revoke_role': { tenant_id: HOME, role: 'workspace-member' },
};

export const BODIES: Record<string, unknown> = {
  'asset_console.create_principle': { title: 'P', statement: 'S' },
  'asset_console.update_principle': { title: 'P', statement: 'S' },
  'asset_console.create_requirement': { title: 'R', description: 'D', effort: 1 },
  'asset_console.update_requirement': { title: 'R', description: 'D', effort: 1 },
  'asset_console.create_decision': { title: 'D', context: 'C', decision: 'X' },
  'asset_console.update_decision': { title: 'D', context: 'C', decision: 'X' },
  'asset_console.update_project': { status: 'active' },
  'admin_users.grant_role': { tenant_id: HOME, role: 'workspace-member' },
  'asset_assignments.promote': { to: 'workspace' },
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
