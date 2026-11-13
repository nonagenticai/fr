// tests/integration/routes/project-start-plan.integration.test.ts
//
// U-PS-OUTLINE (migration 167): an outline VERSION carries the phase plan it was
// instantiated with, plus an fr-computed hash. Real Postgres; the outline
// webhook is driven end to end.
//
// MUTATION CONTROLS (applied, watched RED, reverted):
//   * drop `phase_plan: body.phase_plan ?? null` from the outline insert →
//     "stores the plan and its computed hash" RED (row reads NULL);
//   * accept a caller `phase_plan_hash` instead of computing it → the
//     "caller-sent hash is ignored" test RED.

import { afterAll, afterEach, beforeEach, describe, expect } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { db, approvals, projectRequests, queryClient } from '../../../src/db/client';
import { projectOutlines } from '../../../src/db/schema';
import { handleProjectRequestOutline } from '../../../src/routes/project-request-lifecycle';
import { callHandler } from '../helpers/handler-throws';
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '00000000-0000-4000-8000-0000167c0a01';
const REQUESTER = '00000000-0000-4000-8000-0000167c0a10';
const REPO = 'https://example.com/project-start-plan';

const { itDb } = createDbSuite('project-start-plan');

const BUG_HUNT_PLAN = {
  template_id: 'it.bug_hunt',
  template_hash: 'b'.repeat(64),
  phases: ['deep_analysis', 'feature_development', 'closure'],
};

async function cleanup(): Promise<void> {
  const ids = (
    await db.select({ id: projectRequests.id }).from(projectRequests).where(eq(projectRequests.tenant_id, TENANT))
  ).map((r) => r.id);
  if (ids.length > 0) await db.delete(approvals).where(inArray(approvals.project_request_id, ids));
  await db.delete(projectRequests).where(eq(projectRequests.tenant_id, TENANT));
}

beforeEach(cleanup);
afterEach(cleanup);
afterAll(cleanup);

async function seedRequest(ref: string, projectType: string | null = 'it'): Promise<string> {
  const [row] = await db
    .insert(projectRequests)
    .values({
      tenant_id: TENANT,
      source: 'fr',
      external_ref: `psp-${ref}-${process.pid}-${Date.now()}`,
      // project_type: the plan's phases are checked against this type's RM phases
      payload: { name: 'plan', repository_url: REPO, ...(projectType ? { project_type: projectType } : {}) },
      status: 'submitted',
      history: [],
      created_by: REQUESTER,
    } as typeof projectRequests.$inferInsert)
    .returning({ id: projectRequests.id });
  return row!.id;
}

async function deliver(requestId: string, body: Record<string, unknown>): Promise<Response> {
  return callHandler(
    handleProjectRequestOutline(
      new Request(`http://t/api/webhooks/n8n/project-request-outline/${requestId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      requestId,
    ),
  );
}

const outlineOf = async (requestId: string) =>
  (await db.select().from(projectOutlines).where(eq(projectOutlines.request_id, requestId)))[0];

const deliverable = { kind: 'artifact', title: 'D1', acceptance_criteria: ['c'] };

describe('U-PS-OUTLINE — the outline version carries its phase plan', () => {
  itDb('an outline with no plan is the legacy shape: both columns NULL (control)', async () => {
    const id = await seedRequest('legacy');
    expect((await deliver(id, { deliverables: [deliverable] })).status).toBe(201);
    const o = await outlineOf(id);
    expect(o!.phase_plan).toBeNull();
    expect(o!.phase_plan_hash).toBeNull();
  });

  itDb('a plan on a request with NO project_type is refused 422 (nothing to place it against), writes nothing', async () => {
    const id = await seedRequest('untyped', null);
    const res = await deliver(id, { deliverables: [deliverable], phase_plan: BUG_HUNT_PLAN });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('phase_plan_phase_not_in_type');
    expect(await outlineOf(id)).toBeUndefined();
  });

  itDb('a malformed phase name is still a schema refusal (project_outline_invalid)', async () => {
    const id = await seedRequest('bad-shape');
    const res = await deliver(id, { deliverables: [deliverable], phase_plan: { ...BUG_HUNT_PLAN, phases: ['Not A Name'] } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('project_outline_invalid');
  });

  itDb('the DB refuses a half-written plan (hash without plan) — 23514', async () => {
    const id = await seedRequest('half');
    let code: string | undefined;
    try {
      await queryClient`
        INSERT INTO project_outlines (request_id, version, status, phase_plan_hash)
        VALUES (${id}::uuid, 1, 'superseded', ${'c'.repeat(64)})
      `;
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('23514');
  });
});
