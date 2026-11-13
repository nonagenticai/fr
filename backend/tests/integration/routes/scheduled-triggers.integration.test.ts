// tests/integration/routes/scheduled-triggers.integration.test.ts
//
// Spec 2 Plan 2-A — scheduled_triggers route tests.
//
// Skip-if-unreachable pattern (matches kaizen-log.integration.test.ts):
// the suite probes the table and skips silently if migration 041 hasn't
// been applied. Locally this means the suite is a no-op when Docker
// isn't running; CI's ephemeral Postgres always has migrations applied
// before tests run.

import { afterAll, beforeAll, beforeEach, describe, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  db,
  queryClient,
  projects,
  scheduledTriggers,
  scheduledTriggerRuns,
} from '../../../src/db/client';
import {
  handleCreateScheduledTrigger,
  handleListScheduledTriggers,
  handleGetScheduledTrigger,
  handlePatchScheduledTrigger,
  handleDeleteScheduledTrigger,
  handleRunNowScheduledTrigger,
  handleListScheduledTriggerRuns,
} from '../../../src/routes/scheduled-triggers';
// scheduled-triggers handlers throw AppError-shaped errors (BadRequestError,
// ValidationError, NotFoundError) for invalid input; the prod path is the
// top-level catch in src/server.ts:1453 which mirrors them to a JSON
// Response. Integration tests bypass server.ts and call the handler
// directly, so we wrap each call in `callHandler` to apply the same
// throw → Response mapping. See tests/integration/helpers/handler-throws.ts.
import { callHandler } from '../helpers/handler-throws';
import { withRequestContext } from '../../../src/middleware/request-context';

import { createDbSuite } from '../helpers/db-suite';

const sql = queryClient;
let reachable = false;
let cfProjectId: string | null = null;
let dProjectId: string | null = null;

const BYPASS_TENANT = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM scheduled_triggers LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[scheduled-triggers.integration] postgres unreachable or migration 041 not applied — skipping:',
      (err as Error).message,
    );
  }
  if (!reachable) return;
  process.env.AUTH_BYPASS = 'true';

  const [cf] = await db
    .insert(projects)
    .values({
      owner_id: BYPASS_TENANT,
      name: 'sched-triggers-cf',
      repository_url: 'https://example.com/repo',
      // Owning tenant (projectOwnerTenant): the create gate 404s a project
      // that is not the caller's, and the AUTH_BYPASS caller is BYPASS_TENANT.
      project_data: { keycloak_tenant_id: BYPASS_TENANT },
      shape: 'continuous_flow',
    })
    .returning({ id: projects.id });
  cfProjectId = cf!.id;

  const [d] = await db
    .insert(projects)
    .values({
      owner_id: BYPASS_TENANT,
      name: 'sched-triggers-d',
      repository_url: 'https://example.com/repo',
      // Owning tenant (projectOwnerTenant): the create gate 404s a project
      // that is not the caller's, and the AUTH_BYPASS caller is BYPASS_TENANT.
      project_data: { keycloak_tenant_id: BYPASS_TENANT },
      shape: 'deliverable',
    })
    .returning({ id: projects.id });
  dProjectId = d!.id;
});

afterAll(async () => {
  if (!reachable) return;
  if (cfProjectId) {
    await db.delete(projects).where(eq(projects.id, cfProjectId));
  }
  if (dProjectId) {
    await db.delete(projects).where(eq(projects.id, dProjectId));
  }
});

beforeEach(async () => {
  if (!reachable || !cfProjectId) return;
  await db
    .delete(scheduledTriggerRuns)
    .where(eq(scheduledTriggerRuns.tenant_id, BYPASS_TENANT));
  await db
    .delete(scheduledTriggers)
    .where(eq(scheduledTriggers.tenant_id, BYPASS_TENANT));
});

function makeJsonReq(
  method: string,
  url: string,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const { itDb } = createDbSuite('scheduled-triggers');

describe('POST /api/scheduled-triggers', () => {
  itDb(
    'rejects when project.shape = deliverable (422 shape_mismatch)',
    async () => {
      const res = await callHandler(
        handleCreateScheduledTrigger(
          makeJsonReq('POST', 'http://test/api/scheduled-triggers', {
            project_id: dProjectId,
            name: 't',
            cron: '* * * * *',
            timezone: 'UTC',
            source_connector: 'rss',
            connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
            payload_mapper: { title: '$.title' },
            card_template: { card_type: 'work_intake_record' },
          }),
        ),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { details?: { code?: string } };
      expect(body.details?.code).toBe('shape_mismatch');
    },
  );

  itDb('rejects an invalid cron expression (400)', async () => {
    const res = await callHandler(
      handleCreateScheduledTrigger(
        makeJsonReq('POST', 'http://test/api/scheduled-triggers', {
          project_id: cfProjectId,
          name: 't',
          cron: 'not a cron',
          timezone: 'UTC',
          source_connector: 'rss',
          connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
          payload_mapper: { title: '$.title' },
          card_template: { card_type: 'work_intake_record' },
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  itDb('rejects an invalid timezone (400)', async () => {
    const res = await callHandler(
      handleCreateScheduledTrigger(
        makeJsonReq('POST', 'http://test/api/scheduled-triggers', {
          project_id: cfProjectId,
          name: 't',
          cron: '* * * * *',
          timezone: 'Mars/Olympus_Mons',
          source_connector: 'rss',
          connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
          payload_mapper: { title: '$.title' },
          card_template: { card_type: 'work_intake_record' },
        }),
      ),
    );
    expect(res.status).toBe(400);
  });

  itDb(
    'accepts a valid trigger on a continuous_flow project (201)',
    async () => {
      const res = await handleCreateScheduledTrigger(
        makeJsonReq('POST', 'http://test/api/scheduled-triggers', {
          project_id: cfProjectId,
          name: 'rss daily',
          cron: '0 9 * * *',
          timezone: 'UTC',
          source_connector: 'rss',
          connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
          payload_mapper: { title: '$.title' },
          card_template: { card_type: 'work_intake_record' },
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        tenant_id: string;
        enabled: boolean;
        target_list: string;
      };
      expect(body.id).toBeDefined();
      expect(body.tenant_id).toBe(BYPASS_TENANT);
      expect(body.enabled).toBe(true);
      expect(body.target_list).toBe('INBOX');
    },
  );
});

describe('GET /api/scheduled-triggers', () => {
  itDb('lists triggers scoped to caller tenant', async () => {
    await db.insert(scheduledTriggers).values({
      tenant_id: BYPASS_TENANT,
      project_id: cfProjectId!,
      name: 'list-test',
      cron: '* * * * *',
      timezone: 'UTC',
      source_connector: 'rss',
      connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
      payload_mapper: { title: '$.title' },
      card_template: { card_type: 'work_intake_record' },
    });
    const res = await handleListScheduledTriggers(
      makeJsonReq('GET', 'http://test/api/scheduled-triggers'),
    );
    expect(res.status).toBe(200);
    // Plan 2-C Task 0.5.2 — list returns ListResponse<T> = { items, total }.
    const body = (await res.json()) as {
      items: Array<{ tenant_id: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.length).toBe(body.total);
    expect(body.items.every((r) => r.tenant_id === BYPASS_TENANT)).toBe(true);
  });

  itDb('honors ?project_id= filter', async () => {
    await db.insert(scheduledTriggers).values({
      tenant_id: BYPASS_TENANT,
      project_id: cfProjectId!,
      name: 'filter-test',
      cron: '* * * * *',
      timezone: 'UTC',
      source_connector: 'rss',
      connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
      payload_mapper: { title: '$.title' },
      card_template: { card_type: 'work_intake_record' },
    });
    const res = await handleListScheduledTriggers(
      makeJsonReq(
        'GET',
        `http://test/api/scheduled-triggers?project_id=${cfProjectId}`,
      ),
    );
    const body = (await res.json()) as {
      items: Array<{ project_id: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.every((r) => r.project_id === cfProjectId)).toBe(true);
  });
});

describe('GET /api/scheduled-triggers/:id', () => {
  itDb('returns the row for a tenant-owned id', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'get-test',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
      })
      .returning({ id: scheduledTriggers.id });
    const res = await handleGetScheduledTrigger(
      makeJsonReq('GET', `http://test/api/scheduled-triggers/${t!.id}`),
      t!.id,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(t!.id);
  });

  itDb('404s on unknown id', async () => {
    const fakeId = '00000000-0000-4000-8000-000000000bad';
    const res = await callHandler(
      handleGetScheduledTrigger(
        makeJsonReq('GET', `http://test/api/scheduled-triggers/${fakeId}`),
        fakeId,
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/scheduled-triggers/:id', () => {
  itDb('toggles enabled', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'patch-target',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
      })
      .returning({ id: scheduledTriggers.id });
    const res = await handlePatchScheduledTrigger(
      makeJsonReq('PATCH', `http://test/api/scheduled-triggers/${t!.id}`, {
        enabled: false,
      }),
      t!.id,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  itDb('rejects changing project_id (422 immutable_field)', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'patch-immutable',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
      })
      .returning({ id: scheduledTriggers.id });
    const res = await callHandler(
      handlePatchScheduledTrigger(
        makeJsonReq('PATCH', `http://test/api/scheduled-triggers/${t!.id}`, {
          project_id: dProjectId,
        }),
        t!.id,
      ),
    );
    expect(res.status).toBe(422);
  });

  itDb('validates cron+timezone on patch', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'patch-cron',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
      })
      .returning({ id: scheduledTriggers.id });
    const res = await callHandler(
      handlePatchScheduledTrigger(
        makeJsonReq('PATCH', `http://test/api/scheduled-triggers/${t!.id}`, {
          cron: 'not a cron',
        }),
        t!.id,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/scheduled-triggers/:id', () => {
  itDb('removes the row and returns 204', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'delete-target',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
      })
      .returning({ id: scheduledTriggers.id });
    const res = await handleDeleteScheduledTrigger(
      makeJsonReq('DELETE', `http://test/api/scheduled-triggers/${t!.id}`),
      t!.id,
    );
    expect(res.status).toBe(204);
    const after = await db
      .select()
      .from(scheduledTriggers)
      .where(eq(scheduledTriggers.id, t!.id));
    expect(after.length).toBe(0);
  });
});

describe('POST /api/scheduled-triggers/:id/run-now', () => {
  itDb(
    'records a manual run with status=skipped_no_connector',
    async () => {
      const [t] = await db
        .insert(scheduledTriggers)
        .values({
          tenant_id: BYPASS_TENANT,
          project_id: cfProjectId!,
          name: 'manual-run',
          cron: '* * * * *',
          timezone: 'UTC',
          source_connector: 'rss',
          connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
          payload_mapper: { title: '$.title' },
          card_template: { card_type: 'work_intake_record' },
        })
        .returning({ id: scheduledTriggers.id });

      const res = await handleRunNowScheduledTrigger(
        makeJsonReq(
          'POST',
          `http://test/api/scheduled-triggers/${t!.id}/run-now`,
        ),
        t!.id,
      );
      expect(res.status).toBe(200);

      const runs = await db
        .select()
        .from(scheduledTriggerRuns)
        .where(eq(scheduledTriggerRuns.trigger_id, t!.id));
      expect(runs.length).toBe(1);
      expect(runs[0]!.status).toBe('skipped_no_connector');
      expect(runs[0]!.kind).toBe('manual');
      expect(runs[0]!.trigger_kind).toBe('scheduled_intake');
    },
  );
});

describe('GET /api/scheduled-triggers/:id/runs', () => {
  itDb('returns audit rows newest-first, limit-capped', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'audit-target',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: {
            kind: 'rss',
            secret_id: null,
            feed_url: 'https://example.com/rss',
          },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
      })
      .returning({ id: scheduledTriggers.id });

    // Insert 3 runs spaced in time.
    const base = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await db.insert(scheduledTriggerRuns).values({
        trigger_kind: 'scheduled_intake',
        trigger_id: t!.id,
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        fired_at: new Date(base - i * 60_000),
        status: 'skipped_no_connector',
      });
    }

    const res = await handleListScheduledTriggerRuns(
      makeJsonReq(
        'GET',
        `http://test/api/scheduled-triggers/${t!.id}/runs?limit=2`,
      ),
      t!.id,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ fired_at: string }>;
      total: number | null;
      total_kind: 'exact' | 'at_least' | 'unknown';
    };
    // ⚠️ THIS ASSERTION USED TO READ `expect(body.total).toBe(2)` — it pinned
    // the defect. Three runs were seeded and two requested, so `total: 2` was
    // the PAGE SIZE reported as a match count, and the test enforced that lie.
    // `handleListScheduledTriggerRuns` now runs a parallel `count()` over the
    // SAME `where` the page was drawn from, so the honest answer is 3.
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.total_kind).toBe('exact');
    // Newest first: row[0].fired_at >= row[1].fired_at.
    expect(new Date(body.items[0]!.fired_at).getTime()).toBeGreaterThanOrEqual(
      new Date(body.items[1]!.fired_at).getTime(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HONEST COUNTS (src/lib/resolution.ts serializeCount)
//
// ⚠️ `total` USED TO BE `rows.length` — the size of the page `.limit(limit)`
// had just cut (50 by default, 200 at most). A trigger with 5,000 runs read
// `total: 50`. The case above shows how thoroughly that lie was normalised:
// the existing audit test ASSERTED it. This one pins the fix on its own terms,
// at a wider margin, so a single off-by-one in the seed cannot make both pass.
//
// Reverting `handleListScheduledTriggerRuns` to `{ items: rows, total:
// rows.length }` turns this RED: `total` would read 3, not 7.
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/scheduled-triggers/:id/runs — honest total', () => {
  itDb('a page smaller than the match set still reports the TRUE total', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'honest-total-target',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: {
          kind: 'rss',
          secret_id: null,
          feed_url: 'https://example.com/rss',
        },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
      })
      .returning({ id: scheduledTriggers.id });

    // 7 runs, requested 3 — the smallest seed that comfortably exceeds the
    // limit. The property under test is `total !== items.length`, which needs
    // only that the page be cut.
    const SEEDED = 7;
    const LIMIT = 3;
    const base = Date.now();
    await db.insert(scheduledTriggerRuns).values(
      Array.from({ length: SEEDED }, (_, i) => ({
        trigger_kind: 'scheduled_intake' as const,
        trigger_id: t!.id,
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        fired_at: new Date(base - i * 60_000),
        status: 'skipped_no_connector' as const,
      })),
    );

    const res = await handleListScheduledTriggerRuns(
      makeJsonReq(
        'GET',
        `http://test/api/scheduled-triggers/${t!.id}/runs?limit=${LIMIT}`,
      ),
      t!.id,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      total: number | null;
      total_kind: 'exact' | 'at_least' | 'unknown';
    };

    // CONTROL — the limit really bound, so `total` and `items.length` are
    // genuinely different numbers here rather than accidentally equal.
    expect(body.items.length).toBe(LIMIT);
    expect(SEEDED).toBeGreaterThan(LIMIT);

    // THE PROPERTY: the true count, and a statement that it IS the true count.
    expect(body.total).toBe(SEEDED);
    expect(body.total).not.toBe(body.items.length);
    expect(body.total_kind).toBe('exact');

    // The headers carry the same three facts. `X-Truncated: false` is correct
    // despite the cut page: a COUNT(*) ran, so the TOTAL is not truncated even
    // though the PAGE was — those are different facts and stay apart.
    expect(res.headers.get('X-Total-Relation')).toBe('exact');
    expect(res.headers.get('X-Truncated')).toBe('false');
    expect(res.headers.get('X-Applied-Limit')).toBe(String(LIMIT));
  });
});

// `scheduled_trigger_runs.error_message` and `scheduled_triggers.last_run_error`
// hold raw text for rows written before the tick/intake write-path fixes (and a
// raw catch can always regress). The executions table renders both, so a
// non-super-admin reader only sees fr-shaped sentences; the columns are kept.
describe('run-error text is client-safe on read', () => {
  const RAW =
    'connect ECONNREFUSED 10.43.0.7:5432 (pgbouncer.example.com) relation "x" does not exist';
  const FR_OWN = 'no destination configured: no_webhook_url';
  const GENERIC = 'The run failed — the detail is available to an operator';

  function frame(callerIsSuperAdmin: boolean) {
    return {
      correlationId: 'sched-triggers-run-error-redaction',
      initiator: 'human' as const,
      channel: 'web' as const,
      bearerToken: 'test',
      userId: 'bypass-user',
      subjectId: 'bypass-user',
      tenantId: BYPASS_TENANT,
      jwtTenantId: BYPASS_TENANT,
      callerIsSuperAdmin,
    };
  }

  itDb('runs list, trigger list and trigger get redact raw text for a non-super-admin', async () => {
    const [t] = await db
      .insert(scheduledTriggers)
      .values({
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        name: 'run-error-redaction',
        cron: '* * * * *',
        timezone: 'UTC',
        source_connector: 'rss',
        connector_config: { kind: 'rss', secret_id: null, feed_url: 'https://example.com/rss' },
        payload_mapper: { title: '$.title' },
        card_template: { card_type: 'work_intake_record' },
        last_run_status: 'partial_failure',
        last_run_error: RAW,
      })
      .returning({ id: scheduledTriggers.id });
    const base = Date.now();
    for (const [i, msg] of [RAW, FR_OWN].entries()) {
      await db.insert(scheduledTriggerRuns).values({
        trigger_kind: 'scheduled_intake',
        trigger_id: t!.id,
        tenant_id: BYPASS_TENANT,
        project_id: cfProjectId!,
        fired_at: new Date(base - i * 60_000),
        status: 'partial_failure',
        error_message: msg,
      });
    }

    const read = async (superAdmin: boolean) => {
      return withRequestContext(frame(superAdmin), async () => {
        const runs = (await (
          await handleListScheduledTriggerRuns(
            makeJsonReq('GET', `http://test/api/scheduled-triggers/${t!.id}/runs`),
            t!.id,
          )
        ).json()) as { items: Array<{ error_message: string | null }> };
        const one = (await (
          await handleGetScheduledTrigger(
            makeJsonReq('GET', `http://test/api/scheduled-triggers/${t!.id}`),
            t!.id,
          )
        ).json()) as { last_run_error: string | null };
        const list = (await (
          await handleListScheduledTriggers(
            makeJsonReq('GET', `http://test/api/scheduled-triggers?project_id=${cfProjectId}`),
          )
        ).json()) as { items: Array<{ id: string; last_run_error: string | null }> };
        return { runs, one, list };
      });
    };

    const customer = await read(false);
    expect(customer.runs.items.map((r) => r.error_message)).toEqual([GENERIC, FR_OWN]);
    expect(customer.one.last_run_error).toBe(GENERIC);
    expect(customer.list.items.find((r) => r.id === t!.id)?.last_run_error).toBe(GENERIC);
    expect(JSON.stringify(customer)).not.toContain('svc.cluster.local');

    const operator = await read(true);
    expect(operator.runs.items.map((r) => r.error_message)).toEqual([RAW, FR_OWN]);
    expect(operator.one.last_run_error).toBe(RAW);

    // The stored columns are untouched.
    const [stored] = await db
      .select({ e: scheduledTriggers.last_run_error })
      .from(scheduledTriggers)
      .where(eq(scheduledTriggers.id, t!.id));
    expect(stored!.e).toBe(RAW);
  });
});
