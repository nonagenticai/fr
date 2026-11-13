// tests/integration/routes/suggested-schedules-accept.integration.test.ts
//
// Spec 2 Plan 2-D Phase 5 Task 5.2 — full-path accept against a live
// postgres + drizzle, asserting BOTH rows in DB after the tx commits.
//
// AUTH_BYPASS pattern matches scheduled-triggers.integration.test.ts:
// the suite skips silently when migration 044 hasn't been applied (so a
// dev box without Docker doesn't fail the build) and uses `AUTH_BYPASS`
// to short-circuit `validateAuth` to a synthetic admin user.

import { afterAll, beforeAll, beforeEach, describe, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import {
  db,
  queryClient,
  projects,
  scheduledTriggers,
  suggestedSchedules,
} from '../../../src/db/client';
import {
  handleAcceptSuggestedSchedule,
  handleDismissSuggestedSchedule,
  handleInternalCreateSuggestedSchedule,
} from '../../../src/routes/suggested-schedules';
import { handleError } from '../../../src/utils/errors';

import { createDbSuite } from '../helpers/db-suite';

const sql = queryClient;
let reachable = false;
let cfProjectId: string | null = null;
let dProjectId: string | null = null;

const BYPASS_TENANT = '00000000-0000-0000-0000-000000000000';

const VALID_CONNECTOR_CFG = {
  kind: 'rss',
  secret_id: null,
  feed_url: 'https://example.com/rss',
  max_items: 50,
};

const VALID_PAYLOAD = {
  suggested_name: 'integ-rss-daily',
  suggested_cron: '0 9 * * *',
  suggested_timezone: 'UTC',
  suggested_source_connector: 'rss' as const,
  suggested_connector_config: VALID_CONNECTOR_CFG,
  suggested_payload_mapper: { card_title: '$.title' },
  suggested_target_list: 'INBOX',
  suggested_card_template: { card_type: 'work_intake_record' },
  suggested_enabled: true,
};

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM suggested_schedules LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[suggested-schedules-accept.integration] postgres unreachable or migration 044 not applied — skipping:',
      (err as Error).message,
    );
  }
  if (!reachable) return;
  process.env.AUTH_BYPASS = 'true';

  const [cf] = await db
    .insert(projects)
    .values({
      owner_id: BYPASS_TENANT,
      name: 'ss-integ-cf',
      repository_url: 'https://example.com/repo',
      shape: 'continuous_flow',
      // Dept-less projects carry their owning tenant here (routes/projects.ts);
      // the create/accept tenant gate resolves it through projectOwnerTenant.
      project_data: { keycloak_tenant_id: BYPASS_TENANT },
    })
    .returning({ id: projects.id });
  cfProjectId = cf!.id;

  const [d] = await db
    .insert(projects)
    .values({
      owner_id: BYPASS_TENANT,
      name: 'ss-integ-d',
      repository_url: 'https://example.com/repo',
      shape: 'deliverable',
      // Dept-less projects carry their owning tenant here (routes/projects.ts);
      // the create/accept tenant gate resolves it through projectOwnerTenant.
      project_data: { keycloak_tenant_id: BYPASS_TENANT },
    })
    .returning({ id: projects.id });
  dProjectId = d!.id;
});

afterAll(async () => {
  if (!reachable) return;
  if (cfProjectId) await db.delete(projects).where(eq(projects.id, cfProjectId));
  if (dProjectId) await db.delete(projects).where(eq(projects.id, dProjectId));
});

beforeEach(async () => {
  if (!reachable || !cfProjectId) return;
  await db
    .delete(suggestedSchedules)
    .where(eq(suggestedSchedules.tenant_id, BYPASS_TENANT));
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

// Wrap handler calls so AppError throws translate to Response (the
// router does this in production via handleError; in unit/integration
// tests we replicate it here to avoid raw throws bubbling out).
async function call(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return handleError(err);
  }
}

const { itDb } = createDbSuite('suggested-schedules-accept');

async function createSuggestion(projectId: string, summary: string): Promise<string> {
  const res = await call(() =>
    handleInternalCreateSuggestedSchedule(
      makeJsonReq('POST', 'http://t/api/internal/suggested-schedules', {
        project_id: projectId,
        ad_hoc_summary: summary,
        payload: VALID_PAYLOAD,
      }),
    ),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe('suggested-schedules accept (integration)', () => {
  itDb('full flow: internal-create → accept → both rows present', async () => {
    const suggestionId = await createSuggestion(cfProjectId!, 'integ accept happy path');

    const acceptRes = await call(() =>
      handleAcceptSuggestedSchedule(
        makeJsonReq(
          'POST',
          `http://t/api/suggested-schedules/${suggestionId}/accept`,
        ),
        suggestionId,
      ),
    );
    expect(acceptRes.status).toBe(201);
    const newTrigger = (await acceptRes.json()) as {
      id: string;
      project_id: string;
      cron: string;
      source_connector: string;
      target_list: string;
      enabled: boolean;
    };

    // Both rows must be present in DB after the tx commits.
    const [trigInDb] = await db
      .select()
      .from(scheduledTriggers)
      .where(eq(scheduledTriggers.id, newTrigger.id));
    expect(trigInDb).toBeDefined();
    expect(trigInDb?.project_id).toBe(cfProjectId!);
    expect(trigInDb?.cron).toBe(VALID_PAYLOAD.suggested_cron);
    expect(trigInDb?.source_connector).toBe(VALID_PAYLOAD.suggested_source_connector);
    expect(trigInDb?.enabled).toBe(true);
    expect(trigInDb?.connector_config).toEqual(
      VALID_PAYLOAD.suggested_connector_config,
    );
    expect(trigInDb?.payload_mapper).toEqual(
      VALID_PAYLOAD.suggested_payload_mapper,
    );
    // Phase 8 Task 8.4 — accept must set from_suggestion_id so the FE
    // can render the "from suggestion #<short>" provenance badge on
    // /channels/[id]. Hand-created triggers leave this NULL (asserted
    // implicitly elsewhere — the field is only populated on this path).
    expect(trigInDb?.from_suggestion_id).toBe(suggestionId);

    const [suggInDb] = await db
      .select()
      .from(suggestedSchedules)
      .where(eq(suggestedSchedules.id, suggestionId));
    expect(suggInDb?.status).toBe('accepted');
    expect(suggInDb?.promoted_trigger_id).toBe(newTrigger.id);
  });

  itDb(
    'double-accept rolls back the second insert: only ONE trigger row',
    async () => {
      const suggestionId = await createSuggestion(cfProjectId!, 'integ double-accept');

      const ok = await call(() =>
        handleAcceptSuggestedSchedule(
          makeJsonReq(
            'POST',
            `http://t/api/suggested-schedules/${suggestionId}/accept`,
          ),
          suggestionId,
        ),
      );
      expect(ok.status).toBe(201);

      const second = await call(() =>
        handleAcceptSuggestedSchedule(
          makeJsonReq(
            'POST',
            `http://t/api/suggested-schedules/${suggestionId}/accept`,
          ),
          suggestionId,
        ),
      );
      expect(second.status).toBe(409);

      const triggers = await db
        .select()
        .from(scheduledTriggers)
        .where(eq(scheduledTriggers.tenant_id, BYPASS_TENANT));
      expect(triggers.length).toBe(1);
    },
  );

  itDb(
    'accept on deliverable-shape project leaves no trigger row (422 + rollback)',
    async () => {
      const suggestionId = await createSuggestion(dProjectId!, 'integ wrong-shape');

      const res = await call(() =>
        handleAcceptSuggestedSchedule(
          makeJsonReq(
            'POST',
            `http://t/api/suggested-schedules/${suggestionId}/accept`,
          ),
          suggestionId,
        ),
      );
      expect(res.status).toBe(422);

      const triggers = await db
        .select()
        .from(scheduledTriggers)
        .where(eq(scheduledTriggers.tenant_id, BYPASS_TENANT));
      expect(triggers.length).toBe(0);

      const [sugg] = await db
        .select()
        .from(suggestedSchedules)
        .where(eq(suggestedSchedules.id, suggestionId));
      expect(sugg?.status).toBe('new');
      expect(sugg?.promoted_trigger_id).toBeNull();
    },
  );

  itDb('dismiss after accept → 409', async () => {
    const suggestionId = await createSuggestion(cfProjectId!, 'integ accept-then-dismiss');

    const ok = await call(() =>
      handleAcceptSuggestedSchedule(
        makeJsonReq(
          'POST',
          `http://t/api/suggested-schedules/${suggestionId}/accept`,
        ),
        suggestionId,
      ),
    );
    expect(ok.status).toBe(201);

    const dismissRes = await call(() =>
      handleDismissSuggestedSchedule(
        makeJsonReq(
          'POST',
          `http://t/api/suggested-schedules/${suggestionId}/dismiss`,
        ),
        suggestionId,
      ),
    );
    expect(dismissRes.status).toBe(409);
  });
});
