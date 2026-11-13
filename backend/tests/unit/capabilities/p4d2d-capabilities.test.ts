// tests/unit/capabilities/p4d2d-capabilities.test.ts
//
// fr-agui P4d-2d — the platform group, pinned:
//   * the exact set: 41 FROZEN literal operations (capabilities/platform/{service,admin,account}-frozen.ts and
//     system.ts: the n8n webhooks, the internal service routes, the bug-fix ledger write, the dispatch hub, the
//     LLM-provider / pricing / inference / conveyor-admin routes, the fr secret store, the GitHub App installations,
//     the usage reads and GET /health) and 29 NEW operations (capabilities/platform/{agui,coding,inbound}.ts: the
//     formerly LEGACY_UNDECLARED AG-UI transport + agent chat, the coding spine and jobs, the n8n execution reads,
//     the intake webhook, the client-error sink);
//   * each routed one is served by the handler the P0b route table used (same export, by name); GET /health is
//     `http.unrouted` (served before the router, no row) and has no handler;
//   * a frozen one keeps its operationId and is served verbatim: with the pinned, MEASURED additions removed (the
//     licence-door 403, a non-JSON 400, a no-credential 401 — the p4d2d-real-pipeline and
//     real-pipeline-licence-door suites that measured them were deleted 2026-10-29), its served bytes hash to main's (sha256);
//   * the conveyor catalogue reads (P4a3 / P0b frozen) gained only the door 403 (the P4d-1 carry);
//   * a new one has operationId = camelCase(id); none is agent-exposed;
//   * the licence allowlist is unchanged (an allowlisted route's `licence.ops` IS its row, the rest declare none);
//   * the campaign kill-switch is GONE (George): no route, no capability, no handler export.
//
// DB-free.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { Capability } from '../../../src/capabilities/define';
import { capabilityRouteRows } from '../../../src/capabilities/derive-router';
import { openApiPath } from '../../../src/capabilities/derive-openapi';
import { LICENCE_DOOR_403 } from '../../../src/capabilities/frozen-routes';
import { CAPABILITIES } from '../../../src/capabilities/registry';
import { LICENCE_ROUTE_ALLOWLIST, isLicenceRouteAllowed } from '../../../src/lib/licence-route-allowlist';
import { openapiSpec, SERVED_SPEC_ORDER } from '../../../src/capabilities/served-spec';
import { SPEC_DOCUMENT } from '../../../src/capabilities/spec-document';
import * as projectRoutes from '../../../src/routes/projects';
import base from './fixtures/route-table.p0b-base.json';
import { handlerRefOf } from '../../helpers/capabilities';

type Cap = Capability<unknown, unknown>;
const ALL = CAPABILITIES.filter((e) => e.file.startsWith('src/capabilities/platform/')).map((e) => e.cap as Cap);
const FROZEN = ALL.filter((c) => c.openapi?.frozen !== undefined);
const FRESH = ALL.filter((c) => c.openapi?.frozen === undefined);
const camel = (id: string) => id.replace(/[._]([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** id → [the literal's operationId, sha256 of main's served operation (a00fa6f24 + P4d-2c, which did not touch these)]. */
const FROZEN_OPS: Record<string, [string, string]> = {
  'system.health_check': ['healthCheck', '1bb3a0f6c5c7a58eeade5dfccb8d5d41fd6525c647cf473403009866ebc7341f'],
  'conveyor.list_tenant_priority_levels': ['listTenantPriorityLevels', '5ba4602f08f773a692d12783f47270a0e3b5997b4fad901aaa921741c9afbcca'],
  'conveyor.admin_import_tenant_catalogue_defaults': ['adminImportTenantCatalogueDefaults', '57e4a26424b8de9dbd5ebe3ebf465f7c6dd398590d71ef31de210ed181af9597'],
  'reports.mark_bug_report_fixed': ['markBugReportFixed', '1aeb0db19d6b235cfa0342bb1c6dcb5691a1b153e32251ec8fcdc89e293797a6'],
  'secrets.list_secrets': ['listSecrets', '842bc32c0ea27a199b88e46f5718e16f42ba3839f139ed7a1737bd09e7cb046b'],
  'secrets.create_secret': ['createSecret', 'c05e4ac2ce1e78880accae9045f3e346fc268216bdd6efa58161344ddc9ac71e'],
  'secrets.update_secret': ['updateSecret', '8164edec6ecc2df16758f10b2809b1a86091b1a1d71f5ccb8f46b1a448206e8f'],
  'secrets.delete_secret': ['deleteSecret', '190fa6631051805a61f9bec4fe35474b6bef8559f4d12adb9453ae7894b13f3e'],
  'webhooks.n8n_approval_request': ['n8nApprovalRequest', 'cac2275f6341dacd9c51c523d88bff6cf8630bf4ba1d4ce9dfecd7e5eb3f90ee'],
  'webhooks.n8n_card_approval': ['n8nCardApproval', '4b3d240c1720706bd6857c6dbbbb2e98c840a013b75a3fda1b281b2797410ffe'],
  'webhooks.n8n_report': ['persistReport', '95c215c52decd836ae09b3bb7e4504a6bc6719a538291e96b4f317ae108df96e'],
  'webhooks.n8n_card_phase_lease': ['n8nCardPhaseLease', 'dba21d2ae335f181edfe37d62a935f7d1bd1b7fde0b8e852600633979e0f6460'],
  'webhooks.n8n_plan_event': ['n8nPlanEvent', '887d68f2858b67fcb59d9e177400b3c3592a42338b0d2f96d1d3462e65b691de'],
  'webhooks.n8n_executed_activity': ['n8nExecutedActivity', '1debdfbe58844d61ad1731751e3cc20d5120769e9b4885bf4639908816feba6e'],
  'notifications.dispatch_notification': ['dispatchNotification', 'dfd3c90cd023005cb602d905c982e0d57571478d31738a8053d2b3797709b4a7'],
  'github_app.create_install_url': ['createGithubAppInstallUrl', 'c7d35dbe292ddf754cdd28812837f58306f3d978ecdd83dfb95953400a99aae7'],
  'github_app.confirm_claim': ['confirmGithubAppClaim', '738fa92a04177564f6b8ea22b000ca37f93b92df99054a45a2155b5ee0b5a103'],
  'github_app.list_installations': ['listGithubAppInstallations', 'ae4dc7d5c578d9828e01931ed288be38a255ac61f6a953ff602d869e677dbafe'],
  'github_app.revoke_installation': ['revokeGithubAppInstallation', 'd29d667b6ee4491e75361524e63b199ae611079d4361031e8782c802d3229287'],
  'internal.report_andon_read_failure': ['reportAndonReadFailure', 'aff4b6e80fd783ff5fd5a0bcd521d7a72b0255ffbffea9157f80a569637601eb'],
  'internal.get_card_platform_owner': ['getCardPlatformOwner', '680aab6840eb70434b50c841c535bff795a3b211f7565143c8e6a62388d9530e'],
  'internal.post_card_computed_check': ['postInternalCardComputedCheck', '9e2d0d19b66592a32ddc700b2c9f6087104c410859a1199347dd093c68b00eff'],
  'internal.get_projects_tenant_map': ['getProjectsTenantMap', '7181001906fb3d81316c0598481aad14fe3728e4539dca3d6b7693fd1c974891'],
  'billing.get_tenant_usage_breakdown': ['getTenantUsageBreakdown', '57a73e5c73c3ab71f5ab66d98c2c70cc882b0a7e36c6b635ce315f5780f2c51f'],
  'billing.get_my_usage_funding': ['getMyUsageFunding', '9ff4a4aeaea9ca62882e4d16978b2eb52241b668250ae2b5af27d7a9a35da7c0'],
  'settings.list_llm_provider_audit': ['listLlmProviderAudit', '7686862016819f698dce8b2a8efd8b2dfda97750a545f81eb038cd5f9d4958d7'],
  'settings.test_llm_provider_key': ['testLlmProviderKey', '0aec3c0b4ad0a119f47d1256a189a27df0b9d491df1a2829b894639e84d29984'],
  'llm_provider.admin_get_tenant_provider': ['adminGetTenantLlmProvider', '952d5b193eab5e578557b1eff1bb74830d5bd13c70855d5d5acaa822cfc761d5'],
  'llm_provider.admin_put_tenant_provider': ['adminPutTenantLlmProvider', '0a1b615c77c38685fd93e9db9d6282eb0d17392fe7bc72e660635da714fa5caa'],
  'llm_provider.admin_delete_tenant_provider': ['adminDeleteTenantLlmProvider', '35e0b25f2c9cdc80df2b8321f3843d8c6b03de1d4c473f2b2b0801c35857f4f9'],
  'llm_provider.admin_list_tenant_providers': ['adminListTenantLlmProviders', '8c837d6b7aaaa7677b2250a7c4decd7e4468138a986bc6d3ba2f9b0abe0d7bcb'],
  'llm_provider.admin_get_tenant_catalog': ['adminGetTenantLlmCatalog', 'd20f73573510aae1d6cb5d8f84b66eb527992bfe0f92cb15da7c3987f4d45f49'],
  'llm_provider.admin_list_tenant_audit': ['adminListTenantLlmAudit', '6391854c8c0902912fa83b227525fe22f8cd4f92648dfb75b66b005857ee9525'],
  'llm_provider.admin_test_tenant_provider': ['adminTestTenantLlmProvider', '0e03b77104b1ef444e3e304d0a2cfdf708243595ca5531f271e1c722e32e0cc8'],
  'pricing.list_fx_rates': ['adminListFxRates', '671924f04ce6924ff429f761d8f5fd2758dc4b623e7db198765e8dff9cbbd1ce'],
  'pricing.put_fx_rate': ['adminPutFxRate', 'b3543d52cd0266f0b82998852dfd7675481cd5ff88fafee3db313b0326572229'],
  'inference.get_config': ['adminGetInferenceConfig', 'cfd65ad50d11252fe34f7a310dcc2ad5da825e4ad0bbd5260ef6aaee22325d20'],
  'inference.get_tenant_policy': ['adminGetTenantInferencePolicy', '25363f59d8995069e6cc233516a2b7c6fa7e3b3803e349b51ac0a5a66742b1d4'],
  'inference.activate_tenant_policy': ['adminActivateTenantInferencePolicy', '3b77cedd899cc9a14dc7f5316d96723e06b592fe802e45df9a6e568ec2647749'],
  'inference.apply_tenant': ['adminApplyTenantInference', '056d0d901931d018abc2fe9c842c7d07ac131c97c71a517f8b437b2df8529be8'],
};

/** The conveyor reads that were the real-pipeline-licence-door suite's FROZEN_GAPS (P4d-1): only the door 403 added. */
const CONVEYOR_DOOR_FIXED: Record<string, [string, string]> = {
  'conveyor.list_project_types': ['listTenantProjectTypes', '8b5f743cedbd115d547b14a39e77b6bcc491ca2122b882dde47195469cbc773b'],
  'conveyor.get_catalogue_enums': ['getConveyorCatalogueEnums', 'e2fd187ba7aa6edc16b040383c1cd0935a086faefa6bf8ce3bb9dfff661a66e0'],
  'conveyor.get_project_type_card_types': ['getConveyorProjectTypeCardTypes', '9e764285d6fdce28f3752946367a1b844792c7d13341ecc8ae9c8b959cb56f56'],
  'conveyor.resolve_wip_limit': ['resolveConveyorWipLimit', 'ce8091339abc805930c0d99a1b5b18f7f3f57011a945a68d33054495947f4549'],
  'conveyor.list_catalogue': ['listConveyorCatalogue', 'cc0460f3f50c7489cffd05271500ef6ef7c568b8693b8669b4b3f944ee383ce5'],
  'conveyor.get_catalogue_item': ['getConveyorCatalogueItem', 'c19d4a7c96b8c721a901496d775eab1a235db11e147c79ef22e10f7b8ea549c6'],
};

/** The measured additions, by id: off the licence allowlist with no 403 / default ⇒ the door 403. */
const DOOR_403_ADDED = [
  'billing.get_my_usage_funding',
  'conveyor.list_tenant_priority_levels',
  'github_app.list_installations',
  'internal.get_card_platform_owner',
  'internal.get_projects_tenant_map',
  'internal.report_andon_read_failure',
  'secrets.create_secret',
  'secrets.delete_secret',
  'secrets.list_secrets',
  'secrets.update_secret',
  'webhooks.n8n_approval_request',
];
/** A non-JSON body is a 400 (the pipeline's, or the handler's own message); these declared no 400 / default. */
const NON_JSON_400_ADDED = [
  'llm_provider.admin_put_tenant_provider',
  'pricing.put_fx_rate',
  'reports.mark_bug_report_fixed',
  'secrets.create_secret',
  'secrets.update_secret',
  'webhooks.n8n_approval_request',
];
/** No credential at all is a 401; these declared no 401 / default. */
const UNAUTHORIZED_401_ADDED = [
  'reports.mark_bug_report_fixed',
  'secrets.create_secret',
  'secrets.delete_secret',
  'secrets.list_secrets',
  'secrets.update_secret',
  'webhooks.n8n_approval_request',
];

/** The 29 NEW operations (formerly LEGACY_UNDECLARED). */
const FRESH_IDS = [
  'agent.chat',
  'agui.create_thread', 'agui.delete_thread', 'agui.get_thread', 'agui.invoke', 'agui.issue_session', 'agui.list_actions', 'agui.list_threads',
  'agui.refresh_session', 'agui.revoke_session',
  'client_errors.report',
  'coding.analyze_codebase', 'coding.get_dependency_report', 'coding.get_dependency_snapshot', 'coding.get_graph', 'coding.get_quality_gate',
  'coding.initialize_graph', 'coding.list_containers', 'coding.provision_repository', 'coding.trigger_scan',
  'tools.cancel_coding_job', 'tools.get_coding_job', 'tools.get_coding_job_findings', 'tools.get_n8n_execution', 'tools.list_coding_analysis_types',
  'tools.list_coding_jobs', 'tools.list_n8n_executions', 'tools.trigger_coding_job',
  'webhooks.intake_trigger',
];
/** The moved operations on the licence route allowlist — unchanged by the move. */
const LICENCE_ALLOWED = [
  'internal.post_card_computed_check',
  'notifications.dispatch_notification',
  'reports.mark_bug_report_fixed',
  'webhooks.n8n_card_approval',
  'webhooks.n8n_card_phase_lease',
  'webhooks.n8n_executed_activity',
  'webhooks.n8n_plan_event',
  'webhooks.n8n_report',
];

/** route-order.test.ts `delegatedName`: an arrow that forwards exactly its own parameters IS that function. */
function delegatedName(handler: string): string {
  const m = /^\(req: Request((?:, \w+: string)*)\) => (\w+)\(req((?:, \w+)*)\)$/.exec(handler);
  if (m === null) return handler;
  const params = [...m[1]!.matchAll(/, (\w+): string/g)].map((x) => x[1]);
  const args = [...m[3]!.matchAll(/, (\w+)/g)].map((x) => x[1]);
  return JSON.stringify(params) === JSON.stringify(args) ? m[2]! : handler;
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * The declaration fixes to these frozen objects (the P4d-2e carry plus the 2026-11-01
 * asset-evaluator removal), UNDONE — so the sha pin above still proves every other byte is
 * main's. Each fix is asserted present before it is undone.
 *   system.health_check: the 200 gains `db` / `redis` / `degraded` (and `status`' enum), and a 503 is declared.
 *   llm_provider.admin_put_tenant_provider: the inline `apiKey` body field gains `x-secret`.
 *   internal.post_card_computed_check: the removed R10 grader token door leaves the description.
 */
function withoutP4d2eEdits(id: string, op: Record<string, any>): Record<string, any> {
  const o = structuredClone(op);
  if (id === 'system.health_check') {
    expect(Object.keys(o.responses)).toEqual(['200', '503']);
    delete o.responses['503'];
    const props = o.responses['200'].content['application/json'].schema.properties;
    expect(Object.keys(props)).toEqual(['status', 'version', 'timestamp', 'db', 'redis', 'degraded']);
    delete props.db;
    delete props.redis;
    delete props.degraded;
    expect(props.status.enum).toEqual(['ok', 'degraded']);
    props.status = { type: 'string', example: 'ok' };
  }
  if (id === 'llm_provider.admin_put_tenant_provider') {
    const apiKey = o.requestBody.content['application/json'].schema.properties.apiKey;
    expect(apiKey['x-secret']).toBe(true);
    delete apiKey['x-secret'];
  }
  if (id === 'internal.post_card_computed_check') {
    // 2026-11-01: the asset-evaluator R10 grader's token door is removed with the service. Assert
    // the sentence left the description, then restore main's bytes for the sha pin.
    expect(o.description).toContain('X-Internal-Token: FR_COMPUTED_CHECK_START_TOKEN');
    expect(o.description).not.toContain('FR_COMPUTED_CHECK_GRADER_TOKEN');
    o.description = o.description.replace(
      'X-Internal-Token: FR_COMPUTED_CHECK_START_TOKEN',
      'X-Internal-Token: FR_COMPUTED_CHECK_GRADER_TOKEN (R10 grader; check_kind r10_proof_core) or FR_COMPUTED_CHECK_START_TOKEN',
    );
  }
  return o;
}
type Op = { responses: Record<string, unknown> };
const servedOp = (c: Cap): Op => (openapiSpec.paths as unknown as Record<string, Record<string, Op>>)[openApiPath(c.http.path!)]![c.http.method.toLowerCase()]!;

describe('P4d-2d — the declared set', () => {
  test('the frozen ones keep their literal operationIds; the new ones use operationId = camelCase(id)', () => {
    expect(Object.fromEntries(FROZEN.map((c) => [c.id, c.http.operationId]))).toEqual(
      Object.fromEntries(Object.entries(FROZEN_OPS).map(([id, [op]]) => [id, op])),
    );
    for (const c of FROZEN) expect(c.openapi?.frozen?.operationId).toBe(c.http.operationId);
    expect(FRESH.map((c): string => c.id).sort()).toEqual(FRESH_IDS);
    for (const c of FRESH) expect(`${c.id} ${c.http.operationId}`).toBe(`${c.id} ${camel(c.id)}`);
  });

  test('every routed one is the route the P0b table served, on the SAME handler (by export name); none is agent-exposed', () => {
    const baseRows = (base as unknown as { rows: [string, string, string][] }).rows;
    for (const c of ALL) {
      expect(c.agent.expose).toBe(false);
      if (c.http.unrouted !== undefined) continue;
      const row = baseRows.find(([m, p]) => m === c.http.method && p === c.http.path);
      expect(`${c.id} ${row !== undefined}`).toBe(`${c.id} true`);
      expect(`${c.id} ${handlerRefOf(c.legacyHandler)?.exportName}`).toBe(`${c.id} ${delegatedName(row![2])}`);
    }
  });

  test('the principals and agent reasons say who calls: webhooks / internal are not users; the AG-UI routes are the transport', () => {
    const by = (c: Cap) => `${c.auth.principal}/${(c.agent as { reason: string }).reason}`;
    const got: Record<string, string[]> = {};
    for (const c of ALL) (got[by(c)] ??= []).push(c.id);
    for (const k of Object.keys(got)) got[k]!.sort();
    expect(Object.keys(got).sort()).toEqual(['public/transport', 'service/service-to-service', 'user/out-of-agent-scope', 'user/transport', 'webhook/service-to-service']);
    // P4d-2e (the P4d-2d audit's label nit): five n8n "webhooks" take ONLY a licence bearer (licenceOnly), not
    // X-Webhook-Secret — they are 'service' callers, beside the X-Internal-Token routes.
    expect(got['webhook/service-to-service']).toEqual(['webhooks.intake_trigger', 'webhooks.n8n_approval_request']);
    expect(got['service/service-to-service']).toEqual([
      'internal.get_card_platform_owner', 'internal.get_projects_tenant_map', 'internal.post_card_computed_check',
      'internal.report_andon_read_failure', 'webhooks.n8n_card_approval', 'webhooks.n8n_card_phase_lease',
      'webhooks.n8n_executed_activity', 'webhooks.n8n_plan_event', 'webhooks.n8n_report',
    ]);
    expect(got['public/transport']).toEqual(['client_errors.report', 'system.health_check']);
  });

  test("GET /health is `http.unrouted`: served by src/server.ts before the router, so no route row and no handler", () => {
    const health = ALL.find((c) => c.id === 'system.health_check')!;
    expect(health.http.unrouted).toContain('src/server.ts');
    expect(health.legacyHandler).toBeUndefined();
    expect(capabilityRouteRows().some((r) => r.path === '/health')).toBe(false);
    expect((openapiSpec.paths as unknown as Record<string, unknown>)['/health']).toBeDefined();
  });

  test('a frozen operation sits in the served-spec lock order and is served verbatim: minus the pinned, measured additions, the bytes are main\'s', () => {
    const door: string[] = [];
    const json: string[] = [];
    const unauth: string[] = [];
    for (const c of FROZEN) {
      const path = openApiPath(c.http.path!);
      const method = c.http.method.toLowerCase();
      // P4d-2e: the literal (and its markers) is gone; the position is the served-spec lock's.
      expect(SERVED_SPEC_ORDER).toContain(`${method.toUpperCase()} ${path}`);
      const op = servedOp(c);
      expect(op).toEqual(c.openapi!.frozen as never);
      const responses = { ...op.responses };
      if (DOOR_403_ADDED.includes(c.id)) {
        expect(responses['403']).toEqual(LICENCE_DOOR_403 as never);
        door.push(c.id);
        delete responses['403'];
      }
      if (NON_JSON_400_ADDED.includes(c.id)) {
        expect(JSON.stringify(responses['400'])).toContain('the body is not JSON');
        json.push(c.id);
        delete responses['400'];
      }
      if (UNAUTHORIZED_401_ADDED.includes(c.id)) {
        expect(responses['401']).toBeDefined();
        unauth.push(c.id);
        delete responses['401'];
      }
      expect(`${c.id} ${sha(withoutP4d2eEdits(c.id, { ...op, responses }))}`).toBe(`${c.id} ${FROZEN_OPS[c.id]![1]}`);
    }
    expect(door.sort()).toEqual(DOOR_403_ADDED);
    expect(json.sort()).toEqual(NON_JSON_400_ADDED);
    expect(unauth.sort()).toEqual(UNAUTHORIZED_401_ADDED);
  });

  test('the conveyor reads (the P4d-1 FROZEN_GAPS) gained exactly the door 403, nothing else', () => {
    for (const [id, [opId, hash]] of Object.entries(CONVEYOR_DOOR_FIXED)) {
      const c = CAPABILITIES.find((e) => e.cap.id === id)!.cap as Cap;
      expect(c.http.operationId).toBe(opId);
      const op = servedOp(c);
      expect(op.responses['403']).toEqual(LICENCE_DOOR_403 as never);
      const responses = { ...op.responses };
      delete responses['403'];
      expect(`${id} ${sha({ ...op, responses })}`).toBe(`${id} ${hash}`);
    }
  });

  test('the licence allowlist is unchanged: an allowlisted route declares exactly its row, the rest none', () => {
    const allowed: string[] = [];
    for (const c of ALL) {
      if (c.http.unrouted !== undefined) continue;
      const row = LICENCE_ROUTE_ALLOWLIST.find((r) => r.method === c.http.method && r.pattern === c.http.path);
      expect(`${c.id} ${JSON.stringify(c.licence?.ops)}`).toBe(`${c.id} ${JSON.stringify(row?.ops)}`);
      if (isLicenceRouteAllowed(c.http.method, c.http.path!)) allowed.push(c.id);
    }
    expect(allowed.sort()).toEqual(LICENCE_ALLOWED);
  });

  test("effects and success statuses are the handlers' own", () => {
    for (const c of ALL) {
      if (c.http.method === 'GET') expect(`${c.id} ${c.effect}`).toBe(`${c.id} read`);
      if (c.http.method === 'DELETE') expect(`${c.id} ${c.effect}`).toBe(`${c.id} destructive`);
    }
    const nonDefault = Object.fromEntries(FRESH.filter((c) => c.http.successStatus !== undefined).map((c) => [c.id, c.http.successStatus]));
    expect(nonDefault).toEqual({
      'agui.create_thread': 201,
      'agui.delete_thread': 204,
      'agui.issue_session': 201,
      'agui.revoke_session': 204,
      'client_errors.report': 202,
    });
    expect(FRESH.filter((c) => c.http.stream === 'ndjson').map((c): string => c.id).sort()).toEqual(['agent.chat', 'agui.invoke']);
  });

  test('the literal is drained (P4d-2e moved deleteProject, the last one, and deleted openapi.ts)', () => {
    expect(SPEC_DOCUMENT.paths).toEqual({});
    expect(CAPABILITIES.find((e) => e.cap.http.operationId === 'deleteProject')?.file).toBe('src/capabilities/projects/project-frozen.ts');
  });
});

describe('P4d-2d — the campaign kill-switch is deleted (George)', () => {
  test('no route, no capability, no handler export', () => {
    expect(capabilityRouteRows().some((r) => r.path.startsWith('/api/admin/campaigns'))).toBe(false);
    expect(CAPABILITIES.some((e) => (e.cap.http.path ?? '').startsWith('/api/admin/campaigns'))).toBe(false);
    expect(JSON.stringify(openapiSpec.paths)).not.toContain('/api/admin/campaigns');
    expect('handleGetCampaignKillSwitch' in projectRoutes).toBe(false);
    expect('handleSetCampaignKillSwitch' in projectRoutes).toBe(false);
  });
});
