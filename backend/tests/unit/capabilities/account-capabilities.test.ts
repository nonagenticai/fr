// tests/unit/capabilities/account-capabilities.test.ts
//
// fr-agui SPEC §13 P4b part 3 — spec drain: the caller's account under /api/me, tenant
// billing, workspace members, the repositories catalogue, the GitHub App callback, the
// analysis-to-kanban bridge and the analytics rollups. The routes the P4b-part-2 base
// (34e0e4d21) pinned in GRANDFATHERED_UNDECLARED under those groups are declared as
// capabilities (src/capabilities/{account,tools}/*) with NO behaviour change. Pinned here:
//
//   * the NEW set is EXACTLY the former pins, each on the handler the route table used;
//   * tenancy, agent exclusion (the callback is a browser redirect), operationId = camelCase(id);
//   * licence: none of these routes is on the licence allowlist;
//   * 🔐 secrets: the regenerated licence token (output), the callback's OAuth `code` and
//     install `state` (inputs) — and nothing else;
//   * the declared inputs ARE the routes' schemas where fr validates (moved to
//     side-effect-free modules); strict only where the route is strict;
//   * the bridge keeps its feature flag: deriveRouter mounts nine rows only with
//     FR_FEATURE_BRIDGE, the commit callback always;
//   * no router.add row is left for them.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { openApiPath, pathParams } from '../../../src/capabilities/derive-openapi';
import { deriveRouter } from '../../../src/capabilities/derive-router';
import { extractJsonSchema } from '../../../src/capabilities/json-schema';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import * as channelSchemas from '../../../src/routes/me/channels-schemas';
import * as topupSchemas from '../../../src/routes/me/budget-topup-schemas';
import * as prefSchemas from '../../../src/routes/me/notification-prefs-schemas';
import * as analyticsSchemas from '../../../src/routes/tools/analytics-schemas';
import * as memberSchemas from '../../../src/routes/workspace/members-schemas';
import { RepositoryCreateSchema } from '../../../src/types/api';
import { Router } from '../../../src/utils/router';
import { ALL, byId } from './p4b3-fixtures';
import { handlerRefOf } from '../../helpers/capabilities';

const BACKEND = join(import.meta.dir, '../../..');

/** [METHOD, OpenAPI path, handler]: the P4b-part-3 pins of check-route-spec-coverage.ts @ 34e0e4d21. */
const FORMERLY_PINNED: ReadonlyArray<[string, string, string]> = [
  ['DELETE', '/api/me/channels/{id}', 'handleDeleteMyChannel'],
  ['DELETE', '/api/repositories/{id}', 'handleDeleteRepository'],
  ['DELETE', '/api/workspace/members/{userId}/roles', 'handleRevokeWorkspaceMemberRole'],
  ['GET', '/api/github-app/callback', 'handleGithubAppCallback'],
  ['GET', '/api/me/budget/packages', 'handleListTopupPackages'],
  ['GET', '/api/me/budget/status', 'handleGetMyBudgetStatus'],
  ['GET', '/api/me/budget/topups', 'handleListMyTopups'],
  ['GET', '/api/me/channels', 'handleListMyChannels'],
  ['GET', '/api/me/channel-commands', 'handleListChannelCommands'], // added with the mcp channel (Communication settings)
  ['GET', '/api/me/costs/by-correlation', 'handleGetMyCostByCorrelation'],
  ['GET', '/api/me/licenses', 'handleListMyLicenses'],
  ['GET', '/api/me/licenses/by-tenant', 'handleListMyLicensesByTenant'],
  ['GET', '/api/me/notification-prefs', 'handleListMyNotificationPrefs'],
  ['GET', '/api/me/notifications', 'handleListMyNotifications'],
  ['GET', '/api/me/notifications/unread-count', 'handleMyNotificationsUnreadCount'],
  ['GET', '/api/me/plan', 'handleGetMyPlan'],
  ['GET', '/api/me/projects/artifacts', 'handleGetMyProjectsArtifacts'],
  ['GET', '/api/me/usage/breakdown', 'handleGetMyUsageBreakdown'],
  ['GET', '/api/me/usage/by-tenant', 'handleGetMyUsageByTenant'],
  ['GET', '/api/me/usage/quota', 'handleGetMyUsageQuota'],
  ['GET', '/api/me/usage/series', 'handleGetMyUsageSeries'],
  ['GET', '/api/me/usage/summary', 'handleGetMyUsageSummary'],
  ['GET', '/api/me/workspace', 'handleGetMyWorkspace'],
  ['GET', '/api/me/workspaces', 'handleListMyWorkspaces'],
  ['GET', '/api/repositories', 'handleListRepositories'],
  ['GET', '/api/repositories/{id}', 'handleGetRepository'],
  ['GET', '/api/tenant/billing', 'handleGetTenantBilling'],
  // routes/tools/index.ts imported these four under aliases (handleAnalyticsSummary, …); the module exports:
  ['GET', '/api/tools/analytics/breakdown', 'handleBreakdown'],
  ['GET', '/api/tools/analytics/export.csv', 'handleExportCsv'],
  ['GET', '/api/tools/analytics/per-channel', 'handlePerChannel'],
  ['GET', '/api/tools/analytics/summary', 'handleSummary'],
  ['GET', '/api/tools/bridge/drafts', 'handleListDrafts'],
  ['GET', '/api/tools/bridge/drafts/{id}', 'handleGetDraft'],
  ['GET', '/api/tools/bridge/links', 'handleLookupLink'],
  ['GET', '/api/tools/bridge/sources', 'handleListSources'],
  ['GET', '/api/tools/bridge/sources/{producer}/outputs', 'handleListOutputs'],
  ['GET', '/api/workspace/members', 'handleListWorkspaceMembers'],
  ['PATCH', '/api/tools/bridge/drafts/{id}', 'handlePatchDraft'],
  ['POST', '/api/me/budget/topup', 'handleTopUpMyBudget'],
  ['POST', '/api/me/channels', 'handleAddMyChannel'],
  ['POST', '/api/me/licenses/{id}/regenerate-token', 'handleRegenerateMyLicenseToken'],
  ['POST', '/api/me/notifications/read-all', 'handleMarkAllMyNotificationsRead'],
  ['POST', '/api/me/notifications/{id}/read', 'handleMarkMyNotificationRead'],
  ['POST', '/api/repositories', 'handleCreateRepository'],
  ['POST', '/api/tools/bridge/drafts', 'handleCreateDrafts'],
  ['POST', '/api/tools/bridge/drafts/{id}/commit', 'handleCommitDraft'],
  ['POST', '/api/tools/bridge/drafts/{id}/reject', 'handleRejectDraft'],
  ['POST', '/api/tools/bridge/drafts/{id}/submit', 'handleSubmitDraft'],
  ['POST', '/api/workspace/members/{userId}/roles', 'handleGrantWorkspaceMemberRole'],
  ['PUT', '/api/me/channels', 'handleReplaceMyChannels'],
  ['PUT', '/api/me/notification-prefs', 'handleReplaceMyNotificationPrefs'],
  ['PUT', '/api/repositories/{id}', 'handleUpdateRepository'],
];

/** The two /api/me role bits P4c part 2 declared in capabilities/account/me.ts (pinned in admin-capabilities.test.ts). */
const P4C2_ME = new Set(['me.get_super_admin_status', 'me.list_dept_roles']);
const p4b3 = CAPABILITIES.filter(
  (e) => (e.file.startsWith('src/capabilities/account/') || e.file.startsWith('src/capabilities/tools/')) && !P4C2_ME.has(e.cap.id),
);
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
const rowKey = (r: readonly [string, string, string | undefined]) => `${r[0]} ${r[1]} -> ${r[2]}`;

/** The tenancy each declares: `self` for the caller-keyed stores, `platform` for the super_admin cross-tenant lists. */
const SELF = new Set(['me', 'repositories']);
const PLATFORM = new Set(['me.list_licenses_by_tenant', 'me.get_usage_by_tenant']);
const TENANT_ME = new Set([
  // me.list_licenses: the caller's own licences, but the ACTIVE WORKSPACE's whole usage + cost (routes/me/licenses.ts).
  'me.list_licenses', 'me.list_project_artifacts', 'me.get_usage_summary', 'me.get_usage_series', 'me.get_usage_breakdown', 'me.get_usage_quota',
  'me.get_cost_by_correlation', 'me.get_plan', 'me.get_budget_status', 'me.list_topup_packages', 'me.top_up_budget', 'me.list_topups',
]);

describe('P4b part 3 — the declarations', () => {
  test('the NEW operations are exactly the formerly-pinned routes, each on the handler the route table used', () => {
    expect(p4b3.map((e) => e.cap.id).sort()).toEqual(ALL.map((c) => c.id).sort());
    const declared = p4b3.map((e) => [e.cap.http.method, openApiPath(e.cap.http.path!), handlerRefOf(e.cap.legacyHandler)?.exportName] as const);
    expect(declared.map(rowKey).sort()).toEqual(FORMERLY_PINNED.map(rowKey).sort());
    for (const { cap: c } of p4b3) expect(c.openapi?.frozen).toBeUndefined();
  });

  test('every bound handler is a REAL exported function of the module it names', async () => {
    for (const { cap: c } of p4b3) {
      const ref = handlerRefOf(c.legacyHandler)!;
      const mod = (await import(join(BACKEND, ref.module))) as Record<string, unknown>;
      expect(`${c.id} ${ref.module}#${ref.exportName}: ${typeof mod[ref.exportName]}`).toBe(`${c.id} ${ref.module}#${ref.exportName}: function`);
    }
  });

  test('tenancy, agent exclusion, principal; operationId = camelCase(id)', () => {
    for (const { cap: c } of p4b3) {
      const tenancy = PLATFORM.has(c.id) ? 'platform' : TENANT_ME.has(c.id) ? 'tenant' : SELF.has(c.area) ? 'self' : 'tenant';
      const callback = c.id === 'github_app.install_callback';
      expect(`${c.id} ${c.tenancy} ${JSON.stringify(c.agent)} ${c.auth.principal} ${c.http.operationId}`).toBe(
        `${c.id} ${tenancy} {"expose":false,"reason":"${callback ? 'browser-redirect' : 'out-of-agent-scope'}"} ${callback ? 'public' : 'user'} ${camel(c.id)}`,
      );
    }
    // The callback: a 302, served with no bearer requirement and marked internal (not a typed-client op).
    const cb = byId('github_app.install_callback');
    expect([cb.http.successStatus, cb.openapi?.security, cb.openapi?.internal]).toEqual([302, [], true]);
  });

  test('no path parameter names a project (the project-scoped repository attach / detach stay pinned for P2)', () => {
    for (const { cap: c } of p4b3) expect(pathParams(c.http.path!).join(',')).not.toMatch(/project/i);
  });

  test('the routes are no longer router.add rows (deriveRouter registers them); their pinned siblings stay', () => {
    const server = readFileSync(join(BACKEND, 'src/server.ts'), 'utf8');
    const tools = readFileSync(join(BACKEND, 'src/routes/tools/index.ts'), 'utf8');
    const bridge = readFileSync(join(BACKEND, 'src/routes/tools/bridge.ts'), 'utf8');
    for (const { cap: c } of p4b3) {
      const re = new RegExp(`\\.add\\(\\s*'${c.http.method}',\\s*'${c.http.path!.replace(/[/.-]/g, '\\$&')}'`);
      expect(`${c.id} ${re.test(server) || re.test(tools) || re.test(bridge)}`).toBe(`${c.id} false`);
    }
    expect(bridge).not.toContain('router.add');
    expect(server).not.toContain('registerBridgeRoutes');
    expect(server).not.toContain('registerBridgeCommitRoute');
    for (const m of ["'./routes/repositories'", "'./routes/me/channels'", "'./routes/me/licenses'", "'./routes/tenant/billing'", "'./routes/workspace/members'"]) {
      expect(server).not.toContain(`from ${m}`);
    }
    // (GET /api/me/super-admin was a neighbour here until P4c part 2 declared it.)
    // P4d-2d declared those siblings (capabilities/platform/{account-frozen,inbound}.ts): no router.add row is left.
    expect(server).toContain('// GET /api/me/usage/funding is capability-derived (P4d-2d');
    expect(server).toContain('// POST /api/github-app/install-url is capability-derived (P4d-2d');
    expect(tools).not.toContain('router.add(');
  });

  test("effects: GETs read (the callback, which parks a claim, writes); deletes destructive; success statuses are the handlers' own", () => {
    for (const { cap: c } of p4b3) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} ${c.id === 'github_app.install_callback' ? 'write' : 'read'}`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect} ${c.confirm}`).toBe(`${c.id} destructive card-typed`);
      if (c.http.method !== 'GET' && c.http.method !== 'DELETE') expect(`${c.id} ${c.effect}`).toBe(`${c.id} write`);
    }
    const nonDefault = Object.fromEntries(p4b3.filter((e) => e.cap.http.successStatus !== undefined).map((e) => [e.cap.id, e.cap.http.successStatus]));
    expect(nonDefault).toEqual({
      'me.add_channel_pref': 201,
      'me.delete_channel_pref': 204,
      'me.top_up_budget': 201,
      'repositories.create': 201,
      'repositories.delete': 204,
      'bridge.draft_cards_from_outputs': 201,
      'github_app.install_callback': 302,
    });
  });
});

describe('P4b part 3 — licence: none of these routes is allowlisted', () => {
  test('no route here is on the licence allowlist, and none declares licence ops', () => {
    for (const { cap: c } of p4b3) {
      expect(`${c.id} ${LICENCE_ROUTE_ALLOWLIST.some((r) => r.method === c.http.method && r.pattern === c.http.path)}`).toBe(`${c.id} false`);
      expect(c.licence).toBeUndefined();
    }
  });
});

describe('P4b part 3 — 🔐 secrets, and inputs', () => {
  test('the only secrets: the regenerated licence token (output); the OAuth code and install state of the callback (inputs); a repository url (in + out)', () => {
    const inputs = Object.fromEntries(p4b3.filter((e) => e.cap.secrets?.input).map((e) => [e.cap.id, e.cap.secrets!.input]));
    expect(inputs).toEqual({
      'github_app.install_callback': ['/state', '/code'],
      'repositories.create': ['/url'],
      'repositories.update': ['/url'],
    });
    const outputs = Object.fromEntries(p4b3.filter((e) => e.cap.secrets?.output).map((e) => [e.cap.id, e.cap.secrets!.output]));
    expect(outputs).toEqual({
      'me.regenerate_license_token': ['/token'],
      'repositories.list': ['/items/url'],
      'repositories.create': ['/url'],
      'repositories.get': ['/url'],
      'repositories.update': ['/url'],
    });
    // Declaration only: every repositories row is agent-excluded and served by its legacyHandler (nothing is redacted).
    for (const e of p4b3.filter((x) => x.cap.area === 'repositories')) {
      expect(`${e.cap.id} ${e.cap.agent.expose} ${e.cap.legacyHandler !== undefined}`).toBe(`${e.cap.id} false true`);
    }
    // The licence LIST carries no token: licenses' LicenseResponse emits none, so none is declared.
    const listed = extractJsonSchema(byId('me.list_licenses').output) as { properties: { licenses: { items: { properties: Record<string, unknown> } } } };
    for (const k of ['token', 'token_hash', 'key']) expect(listed.properties.licenses.items.properties[k]).toBeUndefined();
  });

  test("the shared schemas ARE the routes' (moved to side-effect-free modules)", () => {
    expect(byId('me.add_channel_pref').input).toBe(channelSchemas.PrefSchema);
    expect(byId('me.replace_channel_prefs').input).toBe(channelSchemas.ReplaceBodySchema);
    expect(byId('me.replace_notification_prefs').input).toBe(prefSchemas.ReplaceBodySchema);
    expect(byId('me.top_up_budget').input).toBe(topupSchemas.TopupBody);
    expect(byId('repositories.create').input).toBe(RepositoryCreateSchema);
    expect(byId('analytics.summary').input).toBe(analyticsSchemas.summaryInput);
    expect(byId('analytics.breakdown').input).toBe(analyticsSchemas.breakdownInput);
    expect(byId('analytics.per_channel').input).toBe(analyticsSchemas.perChannelInput);
    expect(byId('analytics.export').input).toBe(analyticsSchemas.exportInput);
    expect(byId('analytics.summary').output).toBe(analyticsSchemas.summaryOutput);
    // The grant body: the route's strict schema plus the path userId — still strict.
    const grant = byId('workspace.grant_member_role').input;
    expect(grant.safeParse({ userId: 'u', role: 'workspace-member' }).success).toBe(true);
    expect(grant.safeParse({ userId: 'u', role: 'workspace-member', tenant_id: 't' }).success).toBe(false);
    expect(memberSchemas.GrantBody.safeParse({ role: 'workspace-admin', tenant_id: 't' }).success).toBe(false);
  });

  test('strict exactly where the route is: the grant and top-up bodies refuse unknown keys; nothing else does', () => {
    const strict = p4b3.filter((e) => (extractJsonSchema(e.cap.input) as { additionalProperties?: unknown }).additionalProperties === false).map((e) => e.cap.id);
    expect(strict.sort()).toEqual(['me.top_up_budget', 'workspace.grant_member_role']);
    // The bridge bodies are TypeScript casts in the route (no schema): extras pass, the types are declared.
    const create = byId('bridge.draft_cards_from_outputs').input;
    expect(create.safeParse({ project_id: 'p', producer: 'coding', output_ids: ['o'], future: 1 }).success).toBe(true);
    expect(create.safeParse({ project_id: 'p', producer: 'coding', output_ids: 'o' }).success).toBe(false);
  });

  test('lenient query parameters are declared as the strings the handlers read (never narrower)', () => {
    for (const [id, field] of [
      ['me.get_usage_summary', 'window'], ['me.get_usage_series', 'granularity'], ['me.list_notifications', 'limit'],
      ['repositories.list', 'onboarded_to'], ['me.list_project_artifacts', 'kind'], ['bridge.list_drafts', 'limit'],
    ] as const) {
      expect(`${id}.${field} ${byId(id).input.safeParse({ ...requiredOf(id), [field]: 'anything' }).success}`).toBe(`${id}.${field} true`);
    }
  });
});

function requiredOf(id: string): Record<string, unknown> {
  return id === 'bridge.list_drafts' ? { project_id: 'p' } : {};
}

describe('P4b part 3 — the bridge feature flag survives the move', () => {
  test('nine rows carry mountedWhen; the commit callback mounts always; deriveRouter honours it', () => {
    const bridge = p4b3.filter((e) => e.cap.area === 'bridge');
    expect(bridge.filter((e) => e.cap.http.mountedWhen === undefined).map((e) => e.cap.id)).toEqual(['bridge.commit_draft']);
    const off = bridge.map((e) => ({ ...e, cap: { ...e.cap, http: { ...e.cap.http, ...(e.cap.http.mountedWhen ? { mountedWhen: () => false } : {}) } } }));
    const router = new Router();
    deriveRouter(router, off, []);
    expect(router.list().map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/tools/bridge/drafts/:id/commit']);
    const on = new Router();
    deriveRouter(on, bridge, []);
    expect(on.list().length).toBe(bridge.length);
  });
});

describe('P4b part 3 — the REAL FR_FEATURE_BRIDGE binding (read at module load: a subprocess per value)', () => {
  // The test above injects its own `() => false`, so it cannot see the binding in tools/bridge.ts. This one
  // loads the real registry in a fresh process with the env set and derives the router from CAPABILITIES.
  const PROBE = [
    "import { deriveRouter } from './src/capabilities/derive-router';",
    "import { CAPABILITIES } from './src/capabilities/registry';",
    "import { Router } from './src/utils/router';",
    'const r = new Router(); deriveRouter(r, CAPABILITIES, []);',
    'console.log(JSON.stringify(r.list().map((x) => `${x.method} ${x.path}`)));',
  ].join('\n');
  const derive = (flag: string | undefined): string[] => {
    const env: Record<string, string | undefined> = { ...process.env };
    if (flag === undefined) delete env.FR_FEATURE_BRIDGE;
    else env.FR_FEATURE_BRIDGE = flag;
    const out = spawnSync(process.execPath, ['-e', PROBE], { cwd: BACKEND, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
    expect(`exit ${out.status} ${out.status === 0 ? '' : out.stderr}`).toBe('exit 0 ');
    return JSON.parse(out.stdout.trim().split('\n').pop()!) as string[];
  };
  const BRIDGE_ROWS = [
    'GET /api/tools/bridge/sources', 'GET /api/tools/bridge/sources/:producer/outputs', 'POST /api/tools/bridge/drafts',
    'GET /api/tools/bridge/drafts', 'GET /api/tools/bridge/drafts/:id', 'PATCH /api/tools/bridge/drafts/:id',
    'POST /api/tools/bridge/drafts/:id/submit', 'POST /api/tools/bridge/drafts/:id/reject', 'POST /api/tools/bridge/drafts/:id/commit',
    'GET /api/tools/bridge/links',
  ];
  const bridgeOf = (rows: string[]) => rows.filter((r) => r.split(' ')[1]!.startsWith('/api/tools/bridge/'));

  test('FR_FEATURE_BRIDGE=false: exactly the commit callback; on / unset: all ten; nothing else moves', () => {
    const off = derive('false');
    const on = derive('true');
    const unset = derive(undefined);
    expect(bridgeOf(off)).toEqual(['POST /api/tools/bridge/drafts/:id/commit']);
    expect([...bridgeOf(on)].sort()).toEqual([...BRIDGE_ROWS].sort());
    expect(unset).toEqual(on);
    // No count of the surface here: `bridgeOf(on)` equals BRIDGE_ROWS and
    // `bridgeOf(off)` equals the single commit callback above, so a missing or
    // extra bridge row already fails; the difference is implied.
    expect(off.filter((r) => !bridgeOf([r]).length)).toEqual(on.filter((r) => !bridgeOf([r]).length));
  }, 120_000);
});

describe('P4b part 3 — the served spec', () => {
  test('every NEW operation is tagged with a declared tag; the CSV export and the redirect are not JSON', async () => {
    const { openapiSpec } = await import('../../../src/capabilities/served-spec');
    const declaredTags = new Set((openapiSpec as unknown as { tags: Array<{ name: string }> }).tags.map((t) => t.name));
    type Op = { tags: string[]; operationId: string; responses: Record<string, { content?: Record<string, unknown>; headers?: Record<string, unknown> }>; 'x-internal'?: boolean; security?: unknown[] };
    const paths = openapiSpec.paths as unknown as Record<string, Record<string, Op>>;
    for (const { cap: c } of p4b3) {
      const op = paths[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;
      expect(op.operationId).toBe(c.http.operationId);
      expect(op.tags.length).toBe(1);
      expect(declaredTags.has(op.tags[0]!)).toBe(true);
    }
    const csv = paths['/api/tools/analytics/export.csv']!.get!;
    expect(Object.keys(csv.responses['200']!.content!)).toEqual(['text/csv']);
    const cb = paths['/api/github-app/callback']!.get!;
    expect(cb.responses['302']!.content).toBeUndefined();
    expect(cb.responses['302']!.headers).toHaveProperty('Location');
    expect([cb['x-internal'], cb.security]).toEqual([true, []]);
  });
});
