// tests/unit/capabilities/define.test.ts
//
// fr-agui SPEC §3.3 — `defineCapability` refuses a declaration a derivation
// could not honour, at module load. Each case breaks exactly one rule of a
// declaration that is otherwise valid (the CONTROL proves it is).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  defineCapability,
  defaultConfirm,
  InvalidCapabilityError,
  isAgentExclusionReason,
  type Capability,
} from '../../../src/capabilities/define';
import { deriveOperation } from '../../../src/capabilities/derive-openapi';
import { lazyActionHandler, lazyHandler } from '../../../src/capabilities/lazy';
import { CAPABILITIES, assertRegistryConsistent, registryErrors } from '../../../src/capabilities/registry';
import { isAuthenticatedTenantUser, isAuthenticatedUser } from '../../../src/capabilities/rbac-rules';
import type { ActionContext } from '../../../src/agui/types';
import { getCapability, handlerRefOf } from '../../helpers/capabilities';

const ok = async () => new Response('ok');

function base(): Capability<unknown, unknown> {
  return {
    id: 'demo.read_thing',
    area: 'projects',
    summary: 'Read a thing',
    http: { method: 'GET', path: '/api/demo/:id', operationId: 'getDemoThing' },
    input: z.object({ id: z.string() }),
    output: z.unknown(),
    errors: [],
    auth: { principal: 'user', rbac: { type: 'public' } },
    tenancy: 'project',
    effect: 'read',
    confirm: 'none',
    agent: { expose: false, reason: 'out-of-agent-scope' },
    openapi: { tags: ['Projects'] },
    legacyHandler: ok,
  };
}

describe('defineCapability', () => {
  test('CONTROL: the base declaration is valid', () => {
    expect(defineCapability(base()).id).toBe('demo.read_thing');
  });

  test.each<[string, (c: Capability<unknown, unknown>) => void]>([
    ['id shape', (c) => void (c.id = 'Demo.Thing' as `${string}.${string}`)],
    ['empty summary', (c) => void (c.summary = '  ')],
    ['operationId not camelCase', (c) => void (c.http.operationId = 'get-demo')],
    ['path not absolute', (c) => void (c.http.path = 'api/demo')],
    ['agent-native but not POST', (c) => void (c.http.path = null)],
    ['routed without any handler', (c) => void (c.legacyHandler = undefined)],
    ['frozen operationId mismatch', (c) => void (c.openapi = { frozen: { operationId: 'other' } })],
    ['a read that confirms', (c) => void (c.confirm = 'card')],
    ['a write that does not confirm', (c) => void (c.effect = 'write')],
    ['destructive without card-typed', (c) => {
      c.effect = 'destructive';
      c.confirm = 'card';
    }],
    ["parking:'never' on a read", (c) => void (c.parking = 'never')],
    ['secret path not a pointer', (c) => void (c.secrets = { input: ['github_access_token'] })],
    ['exclusion reason outside the vocabulary', (c) => void (c.agent = { expose: false, reason: 'client-only' as never })],
    ['exposed read without a handler', (c) => {
      c.agent = { expose: true, tier: 'core', cronSafe: true, idempotencyKey: () => 'k' };
    }],
    ['exposed write without a card', (c) => {
      c.effect = 'write';
      c.confirm = 'card';
      c.handler = async () => ({});
      c.agent = { expose: true, tier: 'core', cronSafe: false, idempotencyKey: () => 'k' };
    }],
    // P4a1: the non-JSON media-type fields.
    ['a multipart body on a GET', (c) => {
      c.http.requestBody = { contentType: 'multipart/form-data', fileFields: ['file'] };
    }],
    ['a multipart body naming no file part', (c) => {
      c.http.method = 'POST';
      c.http.requestBody = { contentType: 'multipart/form-data', fileFields: [] };
    }],
    ['responseContentType naming JSON', (c) => void (c.http.responseContentType = 'application/json')],
    // P4b: queryFields (named query parameters of a body method).
    ['queryFields on a GET (its whole input is the query already)', (c) => void (c.http.queryFields = ['tier'])],
    ['queryFields naming no field', (c) => {
      c.http.method = 'PUT';
      c.effect = 'write';
      c.confirm = 'card';
      c.http.queryFields = [];
    }],
    ['a new routed operation without tags', (c) => void (c.openapi = {})],
    // P4a1: openapi.responses (a non-CodedError response with its own body).
    ['openapi.responses reusing the success status', (c) => {
      c.openapi = { tags: ['Projects'], responses: [{ status: 200, description: 'again', schema: z.object({}) }] };
    }],
    ['openapi.responses reusing a declared error status', (c) => {
      c.errors = [{ status: 401, code: 'unauthorized' }];
      c.openapi = { tags: ['Projects'], responses: [{ status: 401, description: 'twice', schema: z.object({}) }] };
    }],
    ['openapi.responses on a frozen operation', (c) => {
      c.openapi = {
        frozen: { operationId: 'getDemoThing' },
        responses: [{ status: 202, description: 'parked', schema: z.object({}) }],
      };
    }],
    ['openapi.responses with a non-HTTP status', (c) => {
      c.openapi = { tags: ['Projects'], responses: [{ status: 42, description: 'no', schema: z.object({}) }] };
    }],
    // derive-openapi would otherwise publish `{}` for these (it used to `?? {}`).
    ['openapi.responses with a non-zod (unextractable) schema', (c) => {
      c.openapi = {
        tags: ['Projects'],
        responses: [{ status: 202, description: 'parked', schema: { type: 'object' } as unknown as z.ZodTypeAny }],
      };
    }],
    ['openapi.responses with a schema that extracts to {} (z.unknown)', (c) => {
      c.openapi = { tags: ['Projects'], responses: [{ status: 202, description: 'parked', schema: z.unknown() }] };
    }],
    // P4a2: `default` is a key like any status — declared once.
    ['openapi.responses declaring `default` twice', (c) => {
      c.openapi = {
        tags: ['Projects'],
        responses: [
          { status: 'default', description: 'relayed', schema: z.object({}) },
          { status: 'default', description: 'again', schema: z.object({}) },
        ],
      };
    }],
  ])('refuses: %s', (_name, mutate) => {
    const c = base();
    mutate(c);
    expect(() => defineCapability(c)).toThrow(InvalidCapabilityError);
  });

  test('CONTROL for the P4a1 refusals: a POST multipart body and a binary GET response are accepted', () => {
    const post = base();
    post.http.method = 'POST';
    post.http.requestBody = { contentType: 'multipart/form-data', fileFields: ['file'] };
    expect(defineCapability(post).http.requestBody?.fileFields).toEqual(['file']);
    const bytes = base();
    bytes.http.responseContentType = 'application/octet-stream';
    expect(defineCapability(bytes).http.responseContentType).toBe('application/octet-stream');
  });

  test('CONTROL for openapi.responses: a distinct status with a description is accepted', () => {
    const c = base();
    c.openapi = { tags: ['Projects'], responses: [{ status: 202, description: 'parked', schema: z.object({}) }] };
    expect(defineCapability(c).openapi?.responses?.map((r) => r.status)).toEqual([202]);
  });

  test("CONTROL for P4a2: OpenAPI's `default` response is accepted and served under the key 'default'", () => {
    const c = base();
    c.openapi = { tags: ['Projects'], responses: [{ status: 'default', description: 'relayed', schema: z.object({ error: z.string() }) }] };
    expect(defineCapability(c).openapi?.responses?.map((r) => r.status)).toEqual(['default']);
    const op = deriveOperation(c, { extensions: false }) as { responses: Record<string, { description: string }> };
    expect(op.responses.default!.description).toBe('relayed');
  });

  test('closed vocabulary; decision-pending carries a ref', () => {
    expect(isAgentExclusionReason('service-to-service')).toBe(true);
    expect(isAgentExclusionReason('decision-pending:OQ-13')).toBe(true);
    expect(isAgentExclusionReason('decision-pending:')).toBe(false);
    expect(isAgentExclusionReason('client-only')).toBe(false);
  });

  test('derived confirm default (SPEC §3.3)', () => {
    expect([defaultConfirm('read'), defaultConfirm('write'), defaultConfirm('destructive')]).toEqual([
      'none',
      'card',
      'card-typed',
    ]);
  });
});

/** The P4a spec-drain units pin their own sets (kag- / research- / library-capabilities.test.ts). */
const notSpecDrain = (e: { cap: { area: string }; file: string }) =>
  !['kag', 'research', 'media'].includes(e.cap.area) &&
  !e.file.startsWith('src/capabilities/library/') &&
  !e.file.startsWith('src/capabilities/settings/') &&
  !e.file.startsWith('src/capabilities/schedules/') &&
  !e.file.startsWith('src/capabilities/operate/') &&
  !e.file.startsWith('src/capabilities/account/') &&
  !e.file.startsWith('src/capabilities/tools/') &&
  !e.file.startsWith('src/capabilities/observe/') &&
  !e.file.startsWith('src/capabilities/admin/') &&
  // fr #1683 agent members: operation ids pinned by served-spec.lock.json (check-served-spec.test.ts).
  !e.file.startsWith('src/capabilities/agent-members/') &&
  e.file !== 'src/capabilities/conveyor/catalogue.ts' &&
  // P2 (its own set-pinning suite was deleted 2026-10-29).
  e.file !== 'src/capabilities/projects/assets.ts' &&
  // P3 pins its own set (tests/unit/capabilities/project-execution-capabilities.test.ts).
  e.file !== 'src/capabilities/projects/execution.ts' &&
  // P2-c1 pins its own set (tests/unit/capabilities/project-quality-people-capabilities.test.ts).
  e.file !== 'src/capabilities/projects/quality-people.ts' &&
  // P2-c2 pins its own set (tests/unit/capabilities/project-outputs-capabilities.test.ts).
  e.file !== 'src/capabilities/projects/outputs.ts' &&
  // P4d-2b (its own set-pinning suite was deleted 2026-10-29).
  !e.file.startsWith('src/capabilities/kanban/') &&
  // P4d-2a (its own set-pinning suite was deleted 2026-10-29).
  e.file !== 'src/capabilities/approvals/approvals.ts' &&
  e.file !== 'src/capabilities/projects/collaboration.ts' &&
  e.file !== 'src/capabilities/projects/project-routes.ts' &&
  // P4d-2a part 2 (its own set-pinning suite was deleted 2026-10-29).
  e.file !== 'src/capabilities/projects/project-frozen.ts' &&
  e.file !== 'src/capabilities/cards/cards.ts' &&
  e.file !== 'src/capabilities/decompositions/decompositions.ts' &&
  // P4d-2d — the platform group (pinned in p4d2d-capabilities.test.ts).
  !e.file.startsWith('src/capabilities/platform/') &&
  // P4d-2e — the artifact browser (its set-pinning suite was deleted 2026-10-29).
  e.file !== 'src/capabilities/projects/artifacts.ts' &&
  // R311 PR 5 — the conveyor failure callbacks + start retry (pinned in conveyor-failures-capabilities.test.ts).
  e.file !== 'src/capabilities/conveyor/failures.ts' &&
  // Cockpit A5 — the flow-run ingest (pinned in conveyor-flow-runs-capabilities.test.ts).
  e.file !== 'src/capabilities/conveyor/flow-runs.ts' &&
  // R2 — the project's registers (pinned in project-registers-capabilities.test.ts).
  e.file !== 'src/capabilities/projects/registers.ts' &&
  // R3 / DOC-3 — the project's outputs + document render (pinned in project-documents-capabilities.test.ts).
  e.file !== 'src/capabilities/projects/documents.ts' &&
  // The project page's conveyor history (pinned in conveyor-history-capabilities.test.ts).
  e.file !== 'src/capabilities/projects/conveyor-history.ts';

describe('registry', () => {
  test('the P0b set plus the P1b project_requests / internal / webhooks sets, consistent (KAG pinned in kag-capabilities.test.ts, research / media in research-capabilities.test.ts, the P4a3 library in library-capabilities.test.ts, the P4b settings in settings-capabilities.test.ts, P4b part 2 in schedules-operate-capabilities.test.ts, P4b part 3 in account-capabilities.test.ts, P4c part 1 in oversight-capabilities.test.ts)', () => {
    expect(CAPABILITIES.filter(notSpecDrain).map((e) => e.cap.id).sort()).toEqual([
      'approvals.decide',
      // P1c: the confirm-card route for agent-native writes (POST /api/capabilities/:id/invoke).
      'capabilities.invoke',
      'conveyor.list_project_types',
      'internal.create_channel',
      'internal.create_decision',
      'internal.create_principle',
      'internal.create_requirement',
      'internal.create_suggested_schedule',
      'internal.create_trigger',
      'internal.get_andon',
      'internal.get_github_app_binding',
      'project_requests.approve',
      'project_requests.create',
      'project_requests.draft_from_text',
      'project_requests.get',
      'project_requests.list',
      'project_requests.list_outlines',
      'project_requests.patch',
      'project_requests.reject',
      'project_requests.submit',
      'project_requests.verify_repo_access',
      'project_requests.withdraw',
      'projects.create',
      'projects.get',
      'projects.list',
      'webhooks.budget_threshold',
      'webhooks.email_incoming',
      'webhooks.mcp_incoming',
      'webhooks.n8n_execution_event',
      'webhooks.n8n_project_request_outline',
      'webhooks.n8n_router_dedupe',
      'webhooks.teams_incoming',
      'webhooks.telegram_incoming',
    ]);
    expect(registryErrors()).toEqual([]);
    expect(() => assertRegistryConsistent()).not.toThrow();
    expect(getCapability('projects.get')?.http.operationId).toBe('getProject');
  });

  test('duplicate id / operationId / route are each reported', () => {
    const one = CAPABILITIES[0]!;
    const errs = registryErrors([one, one]);
    expect(errs.some((e) => e.startsWith('duplicate id'))).toBe(true);
    expect(errs.some((e) => e.startsWith('duplicate operationId'))).toBe(true);
    expect(errs.some((e) => e.startsWith('duplicate route'))).toBe(true);
  });

  test('every declaring file named in the registry declares that id', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const { cap, file } of CAPABILITIES) {
      expect(readFileSync(join(import.meta.dir, '../../..', file), 'utf8')).toContain(`id: '${cap.id}'`);
    }
  });

  test('OperationIds are FROZEN to the pre-P0b values; the P1b operations are NEW (pinned)', () => {
    const ids = Object.fromEntries(
      CAPABILITIES.filter(notSpecDrain).map((e) => [e.cap.id, e.cap.http.operationId]),
    );
    expect(ids).toEqual({
      'projects.create': 'createProject',
      'projects.list': 'listProjects',
      'projects.get': 'getProject',
      'conveyor.list_project_types': 'listTenantProjectTypes',
      'approvals.decide': 'updateApproval',
      // P1c: a NEW route, so a new id.
      'capabilities.invoke': 'invokeCapability',
      // P1b: these routes had no spec operation before, so every id is new.
      'project_requests.create': 'projectRequestsCreate',
      'project_requests.draft_from_text': 'projectRequestsDraftFromText',
      'project_requests.verify_repo_access': 'projectRequestsVerifyRepoAccess',
      'project_requests.list': 'projectRequestsList',
      'project_requests.get': 'projectRequestsGet',
      'project_requests.patch': 'projectRequestsPatch',
      'project_requests.approve': 'projectRequestsApprove',
      'project_requests.reject': 'projectRequestsReject',
      'project_requests.submit': 'projectRequestsSubmit',
      'project_requests.withdraw': 'projectRequestsWithdraw',
      'project_requests.list_outlines': 'projectRequestsListOutlines',
      'internal.create_requirement': 'internalCreateRequirement',
      'internal.create_principle': 'internalCreatePrinciple',
      'internal.create_decision': 'internalCreateDecision',
      'internal.create_trigger': 'internalCreateTrigger',
      'internal.create_channel': 'internalCreateChannel',
      'internal.create_suggested_schedule': 'internalCreateSuggestedSchedule',
      'internal.get_andon': 'internalGetAndon',
      'internal.get_github_app_binding': 'internalGetGithubAppBinding',
      'webhooks.budget_threshold': 'webhookBudgetThreshold',
      'webhooks.email_incoming': 'webhookEmailIncoming',
      'webhooks.mcp_incoming': 'webhookMcpIncoming',
      'webhooks.n8n_execution_event': 'webhookN8nExecutionEvent',
      'webhooks.n8n_router_dedupe': 'webhookN8nRouterDedupe',
      'webhooks.n8n_project_request_outline': 'webhookN8nProjectRequestOutline',
      'webhooks.teams_incoming': 'webhookTeamsIncoming',
      'webhooks.telegram_incoming': 'webhookTelegramIncoming',
    });
  });
});

describe('lazy handlers', () => {
  test('resolve the named export once, forward arguments, carry the ref', async () => {
    let loads = 0;
    const h = lazyHandler(
      async () => {
        loads += 1;
        return { route: async (req: Request, id: string) => new Response(`${req.method}:${id}`) };
      },
      { module: 'src/x.ts', exportName: 'route' },
    );
    expect(await (await h(new Request('http://x/'), 'abc')).text()).toBe('GET:abc');
    await h(new Request('http://x/'), 'def');
    expect(loads).toBe(1);
    expect(handlerRefOf(h)).toEqual({ module: 'src/x.ts', exportName: 'route' });
    expect(h.name).toBe('route');
  });

  test('a missing export is an error at the call, naming it', async () => {
    const h = lazyActionHandler(async () => ({}), { module: 'src/x.ts', exportName: 'nope' });
    await expect(h({}, {} as never)).rejects.toThrow('src/x.ts#nope');
  });

  test('every routed P0b capability binds a real exported route handler', async () => {
    // P4d-2d: `GET /health` is `http.unrouted` (served before the router): no row, so no handler.
    for (const { cap } of CAPABILITIES.filter((e) => e.cap.http.unrouted === undefined)) {
      const ref = handlerRefOf(cap.legacyHandler);
      expect(ref).toBeDefined();
      const mod = (await import(`../../../${ref!.module.replace(/\.ts$/, '')}`)) as Record<string, unknown>;
      expect(typeof mod[ref!.exportName]).toBe('function');
    }
  });
});

describe('rbac-rules', () => {
  const ctx = (over: Partial<ActionContext>): ActionContext =>
    ({ userId: 'u1', tenantId: 't1', projectId: null, correlationId: 'c', initiator: 'human', channel: 'web', ...over }) as ActionContext;

  test('isAuthenticatedUser needs a user, NOT a tenant (the validateAuth bar the KAG routes set)', async () => {
    const route = { method: 'GET', path: '/api/assets/kag/documents' } as const;
    expect(await isAuthenticatedUser(ctx({}), route)).toBe(true);
    expect(await isAuthenticatedUser(ctx({ tenantId: undefined }), route)).toBe(true);
    expect(await isAuthenticatedUser(ctx({ userId: '' }), route)).toBe(false);
    // …which is exactly where it differs from the tenant-user bar.
    expect(await isAuthenticatedTenantUser(ctx({ tenantId: undefined }))).toBe(false);
  });
});
