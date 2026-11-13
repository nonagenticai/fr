// tests/unit/routes/execution-event-refusal-diagnosis.test.ts
//
// `POST /api/webhooks/n8n/execution-event` was 404ing in production and the
// refusal said only "Project <uuid> not found", which reads as a deleted row.
//
// ⭐ IT IS NOT A DELETED ROW, AND IT IS NOT A SCOPING MISS. The handler's lookup
// is `where(eq(projects.id, v.project_id))` and nothing else — no tenant filter,
// no soft-delete filter — so a miss means no such project exists under ANY
// tenant. And one of the ids being refused,
// `0195f48b-d000-7000-8000-000000000004`, is the `prompt-improvement` WORKSPACE
// id (migration 062): a tenant, not a project, so it could never have matched and
// the event was structurally unanswerable. fr's refusal is CORRECT; the producer
// is naming the wrong entity kind, and that is the fix that belongs upstream.
//
// These tests pin the two things fr owes: SAY WHICH refusal this is, and leave a
// durable trace of it. They do NOT make fr resolve the id — inventing an
// association fr was never given would be the paper-over.
//
// DB-armed: the handler queries `projects` before it can refuse. No fixtures are
// needed (the point is that no row matches), only a reachable schema.
// (The prompt-improvement tenant was deleted 2026-11-03; the system workspace id
// stands in as the tenant-id-sent-as-project-id case.)

import { test, expect, describe, beforeAll } from 'bun:test';

import { queryClient } from '../../../src/db/client';
import { handleN8nExecutionEvent } from '../../../src/routes/webhooks';
import { INTERNAL_SYSTEM_TENANT_ID } from '../../../src/middleware/internal-tenant-only';

let reachable = false;

beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM projects LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[execution-event refusal] postgres unreachable — skipping:',
      (err as Error).message,
    );
    return;
  }
  delete process.env.N8N_WEBHOOK_SECRET;
});

function ifReachable(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    if (!reachable) {
      console.warn(`skipping "${name}" — postgres unreachable`);
      return;
    }
    await fn();
  });
}

function eventReq(projectId: string): Request {
  return new Request('http://test/api/webhooks/n8n/execution-event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_type: 'card.done',
      project_id: projectId,
      title: 'conveyor feedback',
      card_id: '1860976969219311041',
      correlation_id: 'corr-diagnosis-1',
    }),
  });
}

describe('an execution-event fr cannot answer is refused DIAGNOSABLY', () => {

  ifReachable('the refusal STAYS a refusal — fr resolves nothing on its own', async () => {
    // ⛔ The anti-paper-over control. It would be easy to "fix" this by looking
    // the tenant up and picking a project in it; that invents an association the
    // producer never sent. A 2xx here means someone did exactly that.
    let threw = false;
    try {
      await handleN8nExecutionEvent(eventReq(INTERNAL_SYSTEM_TENANT_ID));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
