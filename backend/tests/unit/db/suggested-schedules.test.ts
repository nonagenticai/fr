// tests/unit/db/suggested-schedules.test.ts
//
// Spec 2 Plan 2-D Phase 5 Task 5.1 — schema roundtrip for the new
// `suggested_schedules` table introduced by migration 044.
//
// Pin three guarantees:
//
//   1. INSERT + SELECT roundtrip (default `status='new'`, default
//      `payload='{}'::jsonb`).
//   2. CHECK constraints reject invalid `source` and `status` values.
//   3. ON DELETE SET NULL on `promoted_trigger_id`: deleting the trigger
//      leaves the suggestion row visible (audit trail).
//
// Pattern matches sibling DB unit tests: real postgres via `queryClient`,
// scoped DELETE in `beforeEach`. No `mock.module('db/client', ...)` per
// memory `bun-mock-module-process-wide-leak`.

import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  db,
  queryClient,
  workspaces,
  projects,
  scheduledTriggers,
  suggestedSchedules,
} from '../../../src/db/client';
import { ensureWorkspace } from '../../../src/services/workspaces';

const W = '44444444-4444-4444-4444-444444444444';
const TENANT = W;

let projectId: string;
let triggerId: string;

beforeAll(async () => {
  // drizzle warm-up: a zero-row select loads the schema before the first real query.
  await db.select().from(workspaces).limit(0);
});

beforeEach(async () => {
  await queryClient`DELETE FROM workspaces WHERE id = ${W}`;
  await ensureWorkspace(W, 'sched-test-ws');

  const [p] = await db
    .insert(projects)
    .values({
      owner_id: TENANT,
      name: 'sched-test-cf',
      repository_url: 'https://example.com/repo',
      shape: 'continuous_flow',
    })
    .returning({ id: projects.id });
  projectId = p!.id;

  const [t] = await db
    .insert(scheduledTriggers)
    .values({
      tenant_id: TENANT,
      project_id: projectId,
      name: 'sched-test-trig',
      cron: '* * * * *',
      timezone: 'UTC',
      source_connector: 'rss',
      connector_config: { kind: 'rss', secret_id: null, feed_url: 'https://x', max_items: 1 },
      payload_mapper: { card_title: '$.title' },
      target_list: 'INBOX',
      card_template: { card_type: 'work_intake_record' },
      enabled: true,
    })
    .returning({ id: scheduledTriggers.id });
  triggerId = t!.id;
});

describe('suggested_schedules schema (migration 044)', () => {
  test('insert + select roundtrip with default status / payload', async () => {
    const [row] = await db
      .insert(suggestedSchedules)
      .values({
        tenant_id: TENANT,
        project_id: projectId,
        source: 'manual',
        ad_hoc_summary: 'Daily 09:00 RSS pull from foo.com',
      })
      .returning();
    expect(row).toBeDefined();
    expect(row!.tenant_id).toBe(TENANT);
    expect(row!.project_id).toBe(projectId);
    expect(row!.source).toBe('manual');
    expect(row!.status).toBe('new');
    expect(row!.payload).toEqual({});
    expect(row!.promoted_trigger_id).toBeNull();
    expect(row!.user_id).toBeNull();
    expect(row!.created_at).toBeInstanceOf(Date);
    expect(row!.updated_at).toBeInstanceOf(Date);

    const [fetched] = await db
      .select()
      .from(suggestedSchedules)
      .where(eq(suggestedSchedules.id, row!.id));
    expect(fetched?.id).toBe(row!.id);
    expect(fetched?.ad_hoc_summary).toBe('Daily 09:00 RSS pull from foo.com');
  });

  test('insert with heuristic source + populated payload roundtrips', async () => {
    const payload = {
      suggested_cron: '0 9 * * *',
      suggested_source_connector: 'rss',
      suggested_connector_config: { kind: 'rss', feed_url: 'https://example.com/rss' },
    };
    const [row] = await db
      .insert(suggestedSchedules)
      .values({
        tenant_id: TENANT,
        project_id: projectId,
        source: 'heuristic',
        ad_hoc_summary: 'auto-detected daily ingest',
        payload,
      })
      .returning();
    expect(row?.source).toBe('heuristic');
    expect(row?.payload).toEqual(payload);
  });

  test('CHECK constraint rejects invalid source', async () => {
    let thrown: unknown = null;
    try {
      await queryClient`
        INSERT INTO suggested_schedules (tenant_id, project_id, source, ad_hoc_summary)
        VALUES (${TENANT}, ${projectId}, 'bogus_source', 'x')
      `;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(String((thrown as Error).message)).toMatch(/check|source/i);
  });

  test('CHECK constraint rejects invalid status', async () => {
    let thrown: unknown = null;
    try {
      await queryClient`
        INSERT INTO suggested_schedules (tenant_id, project_id, source, ad_hoc_summary, status)
        VALUES (${TENANT}, ${projectId}, 'manual', 'x', 'frobnicated')
      `;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(String((thrown as Error).message)).toMatch(/check|status/i);
  });

  test('ON DELETE SET NULL on promoted_trigger_id keeps suggestion visible', async () => {
    const [row] = await db
      .insert(suggestedSchedules)
      .values({
        tenant_id: TENANT,
        project_id: projectId,
        source: 'manual',
        ad_hoc_summary: 'will be promoted',
        status: 'accepted',
        promoted_trigger_id: triggerId,
      })
      .returning();
    expect(row?.promoted_trigger_id).toBe(triggerId);

    await db.delete(scheduledTriggers).where(eq(scheduledTriggers.id, triggerId));

    const [after] = await db
      .select()
      .from(suggestedSchedules)
      .where(eq(suggestedSchedules.id, row!.id));
    expect(after).toBeDefined();
    expect(after!.promoted_trigger_id).toBeNull();
    expect(after!.status).toBe('accepted');
  });
});
