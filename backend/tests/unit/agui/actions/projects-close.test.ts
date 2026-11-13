// tests/unit/agui/actions/projects-close.test.ts
//
// `projects.close` — the conveyor's CLOSE step (FR-CLOSE-CONTRACT.md): the
// registration SHAPE the MCP channel relies on, and every refusal it can
// produce, against the real CI postgres.
//
// ⛔ The SUCCESS path (RM answers 200 closing the pm_project → `status:
// 'delivered'`) needs a live requirements_management and is proven live; there
// is deliberately no fake RM here (owner ruling 2026-10-29: no test doubles).
// What CI CAN prove without one: the handler refuses in each case exactly as
// the contract says, and it refuses BEFORE anything changeable runs.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, projects } from '../../../../src/db/client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from '../../../../src/integrations/_lib/service-credential';
import type { ActionContext } from '../../../../src/agui/types';
import { getAction, listActions } from '../../../../src/agui/registry';
import {
  closeProjectRm,
  projectsCloseHandler,
  projectsCloseOutputSchema,
  registerProjectLifecycleActions,
  type ProjectsCloseOutput,
} from '../../../../src/agui/actions/project-lifecycle';

const OWNER = '99999999-9999-4999-8999-999999999911';
const TENANT = '99999999-9999-4999-8999-999999999912';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999913';

const savedToken = process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
afterEach(async () => {
  if (savedToken === undefined) delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
  else process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = savedToken;
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
});
afterAll(() => {
  if (savedToken === undefined) delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
  else process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = savedToken;
});

/** The agent member's channel context on the mcp path (verified grammar ⇒ initiator 'human'). */
const ctx: ActionContext = {
  userId: OWNER,
  projectId: null,
  correlationId: 'cid-projects-close',
  initiator: 'human',
  channel: 'mcp',
  tenantId: TENANT,
  tenantRoles: [],
  realmRoles: [],
};

async function project(projectData: Record<string, unknown>, status = 'active') {
  const [row] = await db
    .insert(projects)
    .values({ owner_id: OWNER, name: 'projects close', status, project_data: projectData })
    .returning();
  return row!;
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
  return row!.status;
}

async function refusal(p: Promise<unknown>): Promise<{ status?: number; code?: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return { status: (err as { statusCode?: number }).statusCode, code: (err as { code?: string }).code };
  }
}

describe('projects.close registration shape (the MCP channel’s typed invocation)', () => {
  test('it is registered exactly once, as an agent-usable write', () => {
    registerProjectLifecycleActions();
    registerProjectLifecycleActions(); // idempotent: no throw, no duplicate
    const close = listActions().filter((a) => a.name === 'projects.close');
    expect(close).toHaveLength(1);
    const action = close[0]!;
    expect(action.kind).toBe('write');
    // A write MUST declare an approval policy (registry refuses kind:'write' + auto).
    expect(action.approval).toEqual({ type: 'single-approver', approver: 'initiator' });
    // The agent member's own typed invocation self-approves inline (fr#1683);
    // any other initiator still parks for a person.
    expect(action.autoApproveForInitiator).toBe(true);
    // Bound project threads inject `id` from the thread and refuse any other.
    expect(action.projectParam).toBe('id');
    expect(action.description.length).toBeGreaterThan(0);
    expect(getAction('projects.close')).toBe(action);
  });

  test('the answer carries exactly the contract keys', () => {
    expect(Object.keys(projectsCloseOutputSchema.shape).sort()).toEqual(
      [
        'already_closed',
        'closed',
        'delivered_at',
        'delivery_evidence',
        'deliverables',
        'id',
        'name',
        'phase',
        'project_type',
        'rm_pm_project_id',
        'status',
        'url',
      ].sort(),
    );
  });

  test('an already-closed answer validates against the shape (closed:true, already_closed:true)', () => {
    const answer: ProjectsCloseOutput = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'a project',
      project_type: 'it',
      status: 'delivered',
      phase: 'closure',
      url: '/projects/11111111-1111-4111-8111-111111111111',
      delivered_at: '2026-11-06T10:00:00.000Z',
      delivery_evidence: { source: 'rm_project_closed', rm_pm_project_id: 'rm-1' },
      deliverables: [{ title: 'handover' }],
      closed: true,
      already_closed: true,
      rm_pm_project_id: 'rm-1',
    };
    expect(projectsCloseOutputSchema.parse(answer)).toEqual(answer);
  });

  test('the idempotency key is derived from the id (a replay is the same close)', () => {
    const action = getAction('projects.close')!;
    expect(action.idempotencyKey({ id: 'a' })).toBe('projects.close:a');
    expect(action.idempotencyKey({})).toBe('projects.close:');
  });
});

describe('projects.close refusals (real CI postgres)', () => {
  test('a missing id is invalid_input — never a project_not_found or an RM call', async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV]; // any RM call would throw instead
    expect(await refusal(projectsCloseHandler({}, ctx))).toEqual({ status: 400, code: 'invalid_input' });
  });

  test('a malformed id is invalid_input', async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
    expect(await refusal(projectsCloseHandler({ id: 'not-a-uuid' }, ctx))).toEqual({
      status: 400,
      code: 'invalid_input',
    });
    expect(await refusal(projectsCloseHandler({ id: '  ' }, ctx))).toEqual({ status: 400, code: 'invalid_input' });
  });

  test('an unknown id is 404 project_not_found', async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
    expect(await refusal(projectsCloseHandler({ id: crypto.randomUUID() }, ctx))).toEqual({
      status: 404,
      code: 'project_not_found',
    });
  });

  test("another tenant's project is the SAME 404, never a 403 that leaks existence", async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
    const foreign = await project({ keycloak_tenant_id: OTHER_TENANT });
    expect(await refusal(projectsCloseHandler({ id: foreign.id }, ctx))).toEqual({
      status: 404,
      code: 'project_not_found',
    });
    expect(await statusOf(foreign.id)).toBe('active');
  });

  test('an archived project is refused project_archived before any RM call', async () => {
    // The token is PRESENT here on purpose: a wrongly-ordered close would dial
    // the (unroutable) RM and answer 502 instead of the 409 asserted.
    const archived = await project({ keycloak_tenant_id: TENANT }, 'archived');
    expect(await refusal(projectsCloseHandler({ id: archived.id }, ctx))).toEqual({
      status: 409,
      code: 'project_archived',
    });
    expect(await statusOf(archived.id)).toBe('archived');
  });

  test('RM unavailable/refusing is 502 rm_project_close_failed, and the project stays live', async () => {
    // fr refuses to send without its RM token (`tenantBearerRequired`), so this
    // is the RM failure the close must map — nothing changed, no guess.
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
    const live = await project({ keycloak_tenant_id: TENANT });
    expect(await refusal(projectsCloseHandler({ id: live.id }, ctx))).toEqual({
      status: 502,
      code: 'rm_project_close_failed',
    });
    expect(await statusOf(live.id)).toBe('active');
  });

  test('a project with no tenant tag has no RM project to close: 409 no_rm_project, no RM call', async () => {
    // A tagless project is visible to NO tenant (the load fails closed), so the
    // handler 404s it before the RM step — the mapping itself is proved here,
    // exactly as tests/unit/db/archive-closes-rm.test.ts proves the archive's.
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV]; // any RM call would throw (502) instead
    const tagless = await project({});
    expect(await refusal(closeProjectRm(tagless))).toEqual({ status: 409, code: 'no_rm_project' });
  });
});
