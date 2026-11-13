// tests/unit/capabilities/derive-agent.test.ts
//
// fr-agui SPEC §3.4 (c) — the P0a agent actions are DERIVED from their capability
// declarations (P0b).

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { approvalsDecideAction } from '../../../src/agui/actions/approvals-decide';
import { listProjectTypesAction, projectsCreateAction } from '../../../src/agui/actions/projects-create';
import type { ActionContext } from '../../../src/agui/types';
import { approvalsDecideCapability } from '../../../src/capabilities/approvals/decide';
import { conveyorListProjectTypesCapability } from '../../../src/capabilities/conveyor/list-project-types';
import type { Capability } from '../../../src/capabilities/define';
import {
  AgentDerivationError,
  deriveAgentAction,
  isWebOnlyWrite,
  projectParamOf,
  secretFieldsOf,
} from '../../../src/capabilities/derive-agent';
import { projectsGetCapability } from '../../../src/capabilities/projects/get';
import {
  PROJECT_REQUEST_CAPABILITIES,
  projectRequestsCreateCapability,
  projectRequestsSubmitCapability,
} from '../../../src/capabilities/project-requests/requests';
import { deriveMcp, deriveMcpTool } from '../../../src/capabilities/derive-mcp';
import { extractJsonSchema } from '../../../src/capabilities/json-schema';
import { projectsCreateCapability } from '../../../src/capabilities/projects/create';
import { projectsListCapability } from '../../../src/capabilities/projects/list';
import { handlerRefOf } from '../../helpers/capabilities';

const ctx: ActionContext = {
  userId: 'u-1',
  projectId: null,
  correlationId: 'c-1',
  initiator: 'human',
  channel: 'telegram',
  tenantId: 't-1',
  tenantName: 'Acme',
};

describe('the P0a agent actions are derivations of their capabilities', () => {
  test('the exported actions ARE derivations (handler is the declaration handler, late-bound)', () => {
    expect(projectsCreateAction.handler).toBe(projectsCreateCapability.handler!);
    expect(handlerRefOf(projectsCreateAction.handler)).toEqual({
      module: 'src/agui/actions/projects-create.ts',
      exportName: 'projectsCreateChannelHandler',
    });
    expect(handlerRefOf(approvalsDecideAction.handler)?.exportName).toBe('channelDecide');
    expect(handlerRefOf(listProjectTypesAction.handler)?.exportName).toBe('listProjectTypesHandler');
  });
});

describe('deriveAgentAction — each mapping is load-bearing (mutation cases)', () => {
  const variant = <I, O>(cap: Capability<I, O>, patch: Partial<Capability<I, O>>): Capability<I, O> => ({ ...cap, ...patch });

  test('kind follows effect', () => {
    const a = deriveAgentAction(variant(projectsCreateCapability, { effect: 'read', confirm: 'none' }));
    expect(a.kind).toBe('read');
    expect(a.confirm).toBeUndefined();
  });

  test('description gains the long text when present', () => {
    const a = deriveAgentAction(variant(conveyorListProjectTypesCapability, { description: 'More.' }));
    expect(a.description).toBe(`${conveyorListProjectTypesCapability.summary}\n\nMore.`);
  });

  test('secretFields come from secrets.input pointers; idempotent from the Idempotency-Key header', () => {
    const noSecrets = deriveAgentAction(variant(projectsCreateCapability, { secrets: undefined }));
    expect(noSecrets.confirm?.secretFields).toBeUndefined();
    const noHeader = deriveAgentAction(
      variant(projectsCreateCapability, { http: { ...projectsCreateCapability.http, idempotencyHeader: undefined } }),
    );
    expect(noHeader.confirm?.idempotent).toBeUndefined();
    // projects.create declares no secret since the per-project GitHub token was removed (George 2026-10-18).
    expect(secretFieldsOf(projectsCreateCapability)).toBeUndefined();
    expect(secretFieldsOf(variant(projectsCreateCapability, { secrets: { input: ['/api_key'] } }))).toEqual(['api_key']);
    expect(deriveAgentAction(variant(projectsCreateCapability, { secrets: { input: ['/api_key'] } })).confirm?.secretFields).toEqual(['api_key']);
    expect(() => secretFieldsOf(variant(projectsCreateCapability, { secrets: { input: ['/a/b'] } }))).toThrow(
      AgentDerivationError,
    );
  });

  test("parking:'never' and approval map through; reads default to auto approval", () => {
    expect(deriveAgentAction(variant(approvalsDecideCapability, { parking: 'policy' })).parking).toBeUndefined();
    expect(deriveAgentAction(conveyorListProjectTypesCapability).approval).toEqual({ type: 'auto' });
  });

  test('confirm path and method come from http', () => {
    const a = deriveAgentAction(approvalsDecideCapability);
    expect(a.confirm?.http).toEqual({ method: 'PUT', path: '/api/approvals/:approvalId' });
  });

  test('refuses a non-exposed capability, and a confirming write without a card', () => {
    // P1b: projects.list is exposed now; the bridge intake is the non-exposed fixture.
    expect(() => deriveAgentAction(projectRequestsCreateCapability)).toThrow(AgentDerivationError);
    const agent = projectsCreateCapability.agent;
    if (!agent.expose) throw new Error('fixture');
    expect(() => deriveAgentAction(variant(projectsCreateCapability, { agent: { ...agent, card: undefined } }))).toThrow(
      AgentDerivationError,
    );
  });
});

describe('deriveMcp — descriptors only (SPEC §3.4 d)', () => {
  test('one descriptor per agent-exposed capability, schema = the agent schema', () => {
    const names = deriveMcp().map((d) => d.name).sort();
    expect(names).toEqual(
      [
        'approvals.decide',
        'conveyor.list_project_types',
        'projects.create',
        // P1b — the doorway reads and the request lifecycle (not the bridge intake).
        'projects.get',
        'projects.list',
        ...PROJECT_REQUEST_CAPABILITIES.filter((c) => c.id !== 'project_requests.create').map((c) => c.id),
        // P2 — the D12 read-only PM library (project reads).
        'projects.list_pm_programmes',
        'projects.list_pm_projects',
        'projects.list_pm_risks',
        // P3 — execution observability (project reads).
        'projects.get_wip',
        'projects.list_agent_actions',
        'projects.list_blocked_cards',
        'projects.list_cards_by_type',
        'projects.list_conveyor_executions',
        'projects.list_conveyor_notices',
        'projects.list_executions',
        'projects.list_flow_runs',
        // P2-c1 — quality and knowledge allocation (project reads).
        'projects.get_quality',
        'projects.get_quality_history',
        'projects.get_knowledge_allocation',
        // The project cord's read (project read).
        'projects.get_andon',
        // The Governance tab's conformance verdict (tenant route, bound project as `projectId`).
        'architecture.get_governance_conformance',
      ].sort(),
    );
    const create = deriveMcpTool(projectsCreateCapability);
    expect(create.inputSchema).toEqual(extractJsonSchema(projectsCreateAction.input)!);
    expect(create.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(deriveMcpTool(conveyorListProjectTypesCapability).annotations.readOnlyHint).toBe(true);
  });

  test('destructiveHint follows effect', () => {
    const d = deriveMcpTool({ ...projectsCreateCapability, effect: 'destructive', confirm: 'card-typed' });
    expect(d.annotations.destructiveHint).toBe(true);
    expect(deriveMcpTool({ ...projectsCreateCapability, input: z.object({}) }).inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('P1b — project parameter and web-only writes (SPEC §5.7 rule 3, §5.2 W)', () => {
  const variant = <I, O>(cap: Capability<I, O>, patch: Partial<Capability<I, O>>): Capability<I, O> => ({ ...cap, ...patch });
  test('projectParamOf: the /api/projects/:<param> segment of a tenancy:project capability, nothing else', () => {
    expect(projectParamOf(projectsGetCapability)).toBe('id');
    expect(deriveAgentAction(projectsGetCapability).projectParam).toBe('id');
    // tenancy:'tenant' ⇒ no project parameter, even on a /api/projects path.
    expect(projectParamOf(projectsListCapability)).toBeUndefined();
    expect(deriveAgentAction(projectsListCapability).projectParam).toBeUndefined();
    // …and a tenancy:'tenant' capability ON a /api/projects/:id path has none either.
    expect(projectParamOf(variant(projectsGetCapability, { tenancy: 'tenant' }))).toBeUndefined();
    expect(projectParamOf(variant(projectsGetCapability, { http: { ...projectsGetCapability.http, path: '/api/projects/:projectId/brief' } }))).toBe('projectId');
  });

  test('an exposed tenancy:project capability whose route does not carry the project is refused', () => {
    const odd = variant(projectsGetCapability, { http: { ...projectsGetCapability.http, path: '/api/things/:id' } });
    expect(() => deriveAgentAction(odd)).toThrow(AgentDerivationError);
  });

  test('a write with no server-side handler is webOnly; a write with one is offered on every channel', async () => {
    expect(isWebOnlyWrite(projectRequestsSubmitCapability)).toBe(true);
    const submit = deriveAgentAction(projectRequestsSubmitCapability);
    expect(submit.webOnly).toBe(true);
    expect(submit.confirm).toEqual({ http: { method: 'POST', path: '/api/project-requests/:id/submit' }, card: 'project-request' });
    // Its handler is unreachable by construction; if reached it refuses, it never runs the route.
    await expect(submit.handler({ id: 'x' }, ctx)).rejects.toThrow(/confirm card/);
    expect(isWebOnlyWrite(projectsCreateCapability)).toBe(false);
    expect(deriveAgentAction(projectsCreateCapability).webOnly).toBeUndefined();
    // A read is never webOnly.
    expect(isWebOnlyWrite(projectsGetCapability)).toBe(false);
  });

  test('removing a write\'s handler makes it web-only, never a channel write that cannot run', () => {
    const noHandler = variant(projectsCreateCapability, { handler: undefined });
    expect(isWebOnlyWrite(noHandler)).toBe(true);
    expect(deriveAgentAction(noHandler).webOnly).toBe(true);
  });
});
