// tests/unit/capabilities/p4b3-fixtures.ts
//
// Shared fixtures for the fr-agui P4b part-3 suites (account-*.test.ts): the 51
// capabilities (the caller's account under /api/me, tenant billing, workspace
// members, the repositories catalogue, the GitHub App callback, the bridge and the
// analytics rollups), the concrete request each probe sends (path parameters, the
// query a GET needs to pass the handler's own input checks, a body each handler's
// own validation accepts), and the drizzle builder stand-in. No database is touched
// and no mock.module() is used.
import { MY_ARTIFACT_CAPABILITIES, MY_CHANNEL_PREF_CAPABILITIES, MY_LICENCE_CAPABILITIES, MY_WORKSPACE_CAPABILITIES, MY_WORKSPACES_CAPABILITIES } from '../../../src/capabilities/account/me';
import { TENANT_BILLING_CAPABILITIES } from '../../../src/capabilities/account/billing';
import { GITHUB_APP_CALLBACK_CAPABILITIES } from '../../../src/capabilities/account/github-app';
import { MY_NOTIFICATION_CAPABILITIES, MY_NOTIFICATION_PREF_CAPABILITIES } from '../../../src/capabilities/account/notifications';
import { REPOSITORY_CAPABILITIES } from '../../../src/capabilities/account/repositories';
import { MY_BUDGET_STATUS_CAPABILITIES, MY_TOPUP_CAPABILITIES, MY_USAGE_CAPABILITIES } from '../../../src/capabilities/account/usage';
import { WORKSPACE_MEMBER_CAPABILITIES } from '../../../src/capabilities/account/workspace-members';
import type { Capability } from '../../../src/capabilities/define';
import { pathParams } from '../../../src/capabilities/derive-openapi';
import { ANALYTICS_CAPABILITIES } from '../../../src/capabilities/tools/analytics';
import { BRIDGE_CAPABILITIES } from '../../../src/capabilities/tools/bridge';

export const HOME = 'a100000c-0000-4000-8000-00000000000c';
export const OTHER = 'b200000d-0000-4000-8000-00000000000d';
export const UUID = '0195f48b-d000-7000-8000-0000000000b3';
export const T0 = '2026-10-01T00:00:00.000Z';

type Cap = Capability<unknown, unknown>;
export const ME: ReadonlyArray<Cap> = [
  ...MY_CHANNEL_PREF_CAPABILITIES, ...MY_NOTIFICATION_CAPABILITIES, ...MY_NOTIFICATION_PREF_CAPABILITIES, ...MY_LICENCE_CAPABILITIES,
  ...MY_WORKSPACE_CAPABILITIES, ...MY_WORKSPACES_CAPABILITIES, ...MY_ARTIFACT_CAPABILITIES, ...MY_USAGE_CAPABILITIES,
  ...MY_BUDGET_STATUS_CAPABILITIES, ...MY_TOPUP_CAPABILITIES,
];
export const BILLING: ReadonlyArray<Cap> = TENANT_BILLING_CAPABILITIES;
export const MEMBERS: ReadonlyArray<Cap> = WORKSPACE_MEMBER_CAPABILITIES;
export const REPOS: ReadonlyArray<Cap> = REPOSITORY_CAPABILITIES;
export const CALLBACK: ReadonlyArray<Cap> = GITHUB_APP_CALLBACK_CAPABILITIES as unknown as ReadonlyArray<Cap>;
export const BRIDGE: ReadonlyArray<Cap> = BRIDGE_CAPABILITIES;
export const ANALYTICS: ReadonlyArray<Cap> = ANALYTICS_CAPABILITIES;
/** The 50 user-authenticated operations (the GitHub App callback runs no validateAuth: a browser redirect). */
export const USER_CAPS: ReadonlyArray<Cap> = [...ME, ...BILLING, ...MEMBERS, ...REPOS, ...BRIDGE, ...ANALYTICS];
export const ALL: ReadonlyArray<Cap> = [...USER_CAPS, ...CALLBACK];

export const byId = (id: string): Cap => {
  const c = ALL.find((x) => x.id === id);
  if (!c) throw new Error(`no capability ${id}`);
  return c;
};

/** A concrete value per path parameter name. */
const PARAM: Record<string, string> = { id: UUID, userId: 'u-target', producer: 'coding' };
export const paramsOf = (cap: Cap): string[] => pathParams(cap.http.path!).map((p) => PARAM[p] ?? UUID);
export const hasBody = (cap: Cap): boolean => cap.http.method !== 'GET' && cap.http.method !== 'DELETE';

/** The query each probe sends: what the handler needs before it decides anything else. */
export const QUERIES: Record<string, Record<string, string>> = {
  'bridge.list_outputs': { project_id: UUID },
  'bridge.list_drafts': { project_id: UUID },
  'bridge.get_draft': { project_id: UUID },
  'bridge.lookup_link': { project_id: UUID, producer: 'coding', stable_id: 's1' },
  'analytics.breakdown': { dimension: 'tool', metric: 'cards_committed' },
  'workspace.revoke_member_role': { role: 'workspace-member' },
};

export const BODIES: Record<string, unknown> = {
  'me.replace_channel_prefs': { prefs: [{ channel: 'email', address: 'a@test' }] },
  'me.add_channel_pref': { channel: 'email', address: 'a@test' },
  'me.replace_notification_prefs': { prefs: [] },
  'me.top_up_budget': { package_id: 'tokens_1m', idempotency_key: 'idem-key-0001' },
  'workspace.grant_member_role': { role: 'workspace-member' },
  'repositories.create': { name: 'r', url: 'https://github.com/acme/r' },
  'repositories.update': { description: 'd' },
  'bridge.draft_cards_from_outputs': { project_id: UUID, producer: 'coding', output_ids: ['o1'] },
  'bridge.edit_draft': { project_id: UUID, patch: { title: 't' } },
  'bridge.submit_draft': { project_id: UUID },
  'bridge.reject_draft': { project_id: UUID },
  'bridge.commit_draft': { project_id: UUID },
};

/** A drizzle builder stand-in: every query EXECUTES (is awaited) against `next()`. */
export function storeChain(next: () => unknown): unknown {
  const p: unknown = new Proxy(function chain() {}, {
    get(_t, key) {
      if (key === 'then') {
        return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
          try {
            const v = next();
            if (v instanceof Error) reject(v);
            else resolve(v);
          } catch (e) {
            reject(e);
          }
        };
      }
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

export const urlOf = (input: unknown): string => String(input instanceof Request ? input.url : input);

/** The path a probe hits, with its parameters and query filled in. */
export function urlFor(cap: Cap, query: Record<string, string> = QUERIES[cap.id] ?? {}): string {
  const params = paramsOf(cap);
  let i = 0;
  const path = cap.http.path!.replace(/:\w+/g, () => params[i++]!);
  const qs = new URLSearchParams(query).toString();
  return `http://test${path}${qs ? `?${qs}` : ''}`;
}
