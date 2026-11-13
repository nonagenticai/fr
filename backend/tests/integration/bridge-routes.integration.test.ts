// tests/integration/bridge-routes.integration.test.ts
//
// Phase 2.E sub-batch 2.B — converted from tests/unit/bridge-routes.test.ts.
//
// Exercises the bridge handler contracts against the real CI Postgres:
//
//   - IDOR boundary: seed a draft with project_id=A, attempt access from
//     project_id=B → handler returns the bridge `draft_not_found` envelope
//     with HTTP 404. The real `draftService.get` / `.patch` / `.reject` /
//     submit / commit short-circuit on the project-id scope.
//
//   - project_id shape: a non-UUID project_id is a 400, not a Postgres 500.

import {
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test';
import { sql as drizzleSql } from 'drizzle-orm';

import { db, projects, queryClient } from '../../src/db/client';
import { cardDrafts } from '../../src/db/schema';
import {
  handleCommitDraft,
  handleCreateDrafts,
  handleGetDraft,
  handleLookupLink,
  handlePatchDraft,
  handleRejectDraft,
  handleSubmitDraft,
} from '../../src/routes/tools/bridge';
import { handleError } from '../../src/utils/errors';

import { createDbSuite } from './helpers/db-suite';

const sql = queryClient;

process.env.AUTH_BYPASS = 'true';

// Pinned UUIDs so cleanup is bounded to this suite.
const TENANT_ID = '00000000-0000-0000-0000-000000000000'; // matches AUTH_BYPASS user
const PROJECT_A = '00000000-0000-4000-8000-bccc00000a01';
const PROJECT_B = '00000000-0000-4000-8000-bccc00000a02';
const OWNER_ID = '00000000-0000-0000-0000-000000000000';
// Fixed draft IDs for IDOR seeds.
const DRAFT_A1 = '00000000-0000-4000-8000-bccc00000d01';
const DRAFT_A2 = '00000000-0000-4000-8000-bccc00000d02';
const DRAFT_A3 = '00000000-0000-4000-8000-bccc00000d03';
const DRAFT_A4 = '00000000-0000-4000-8000-bccc00000d04';
const DRAFT_A5 = '00000000-0000-4000-8000-bccc00000d05';

const ALL_TEST_PROJECTS = [PROJECT_A, PROJECT_B];

const BASE = 'http://test';

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM card_drafts LIMIT 1`;
    await sql`SELECT 1 FROM projects LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[bridge-routes.integration] DB not reachable, skipping. ' +
        'Start fr-postgres with bridge migrations applied. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }

  // Seed the projects rows we need (FK target for any approvals tests; we
  // don't submit/commit here, but card_drafts.project_id is uuid-not-FK so
  // this is mostly so dependent tests don't trip over missing parents).
  for (const id of ALL_TEST_PROJECTS) {
    await db.execute(drizzleSql`DELETE FROM projects WHERE id = ${id}`);
    await db.insert(projects).values({
      id,
      owner_id: OWNER_ID,
      name: `phase2e-2b-bridge-routes-${id.slice(-4)}`,
      repository_url: 'https://example.invalid/test.git',
      // H5: bridge routes load the project tenant-scoped (by this tag).
      project_data: { keycloak_tenant_id: TENANT_ID },
    });
  }
});

afterAll(async () => {
  if (!reachable) return;
  // Bounded cleanup: drop card_drafts for our test projects, then projects.
  for (const id of ALL_TEST_PROJECTS) {
    await db.execute(
      drizzleSql`DELETE FROM card_drafts WHERE project_id = ${id}`,
    );
    await db.execute(drizzleSql`DELETE FROM projects WHERE id = ${id}`);
  }
});

beforeEach(async () => {
  if (!reachable) return;
  for (const id of ALL_TEST_PROJECTS) {
    await db.execute(
      drizzleSql`DELETE FROM card_drafts WHERE project_id = ${id}`,
    );
  }
});

interface SeedDraftOpts {
  id: string;
  project_id: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

async function seedDraft(opts: SeedDraftOpts): Promise<void> {
  await db.insert(cardDrafts).values({
    id: opts.id,
    project_id: opts.project_id,
    drafter_id: OWNER_ID,
    initiator: 'user',
    producer: 'coding',
    run_id: 'run-test',
    output_id: `out-${opts.id.slice(-4)}`,
    stable_id: `stable-${opts.id.slice(-4)}`,
    content_digest: `digest-${opts.id.slice(-4)}`,
    title: 'seed-title',
    body_md: 'seed-body',
    labels: [],
    status: opts.status ?? 'editing',
    metadata: opts.metadata ?? {},
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function expectNotFoundBody(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const body = (await readJson(res)) as {
    data?: unknown;
    error?: { code?: string };
  };
  expect(body.data).toBeUndefined();
  expect(body.error?.code).toBe('draft_not_found');
}

const { itDb } = createDbSuite('bridge-routes');

describe('Bridge route IDOR — project_id boundary', () => {
  itDb(
    'GET draft from project B cannot read project A draft',
    async () => {
      await seedDraft({ id: DRAFT_A1, project_id: PROJECT_A });
      const req = new Request(
        `${BASE}/api/tools/bridge/drafts/${DRAFT_A1}?project_id=${PROJECT_B}`,
      );
      const res = await handleGetDraft(req, DRAFT_A1);
      await expectNotFoundBody(res);
    },
  );

  itDb(
    'PATCH from wrong project surfaces draft_not_found, does not invoke patch',
    async () => {
      await seedDraft({ id: DRAFT_A2, project_id: PROJECT_A, title: 'orig' } as SeedDraftOpts & { title: string });
      const req = new Request(`${BASE}/api/tools/bridge/drafts/${DRAFT_A2}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: PROJECT_B,
          patch: { title: 'should-not-apply' },
        }),
      });
      const res = await handlePatchDraft(req, DRAFT_A2);
      await expectNotFoundBody(res);
      // DB-state assertion: title unchanged.
      const [row] = await db
        .select()
        .from(cardDrafts)
        .where(drizzleSql`id = ${DRAFT_A2}`)
        .limit(1);
      expect(row?.title).toBe('seed-title');
    },
  );

  itDb('REJECT from wrong project does not invoke reject', async () => {
    await seedDraft({ id: DRAFT_A3, project_id: PROJECT_A });
    const req = new Request(
      `${BASE}/api/tools/bridge/drafts/${DRAFT_A3}/reject`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: PROJECT_B }),
      },
    );
    const res = await handleRejectDraft(req, DRAFT_A3);
    await expectNotFoundBody(res);
    const [row] = await db
      .select()
      .from(cardDrafts)
      .where(drizzleSql`id = ${DRAFT_A3}`)
      .limit(1);
    expect(row?.status).toBe('editing');
  });

  itDb('SUBMIT from wrong project does not invoke submit', async () => {
    await seedDraft({ id: DRAFT_A4, project_id: PROJECT_A });
    const req = new Request(
      `${BASE}/api/tools/bridge/drafts/${DRAFT_A4}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: PROJECT_B }),
      },
    );
    const res = await handleSubmitDraft(req, DRAFT_A4);
    await expectNotFoundBody(res);
    const [row] = await db
      .select()
      .from(cardDrafts)
      .where(drizzleSql`id = ${DRAFT_A4}`)
      .limit(1);
    expect(row?.status).toBe('editing');
  });

  itDb('COMMIT from wrong project does not invoke commit', async () => {
    await seedDraft({
      id: DRAFT_A5,
      project_id: PROJECT_A,
      status: 'submitted',
    });
    const req = new Request(
      `${BASE}/api/tools/bridge/drafts/${DRAFT_A5}/commit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: PROJECT_B }),
      },
    );
    const res = await handleCommitDraft(req, DRAFT_A5);
    await expectNotFoundBody(res);
    const [row] = await db
      .select()
      .from(cardDrafts)
      .where(drizzleSql`id = ${DRAFT_A5}`)
      .limit(1);
    expect(row?.status).toBe('submitted');
  });
});

describe('Bridge project_id shape — a non-UUID is a 400, not a Postgres 500', () => {
  // Measured in production, not imagined. `GET /api/projects` emits
  // stream-backed pseudo-projects whose ids look like
  // `stream:9b9fc446-3fff-4587-be44-68908427ea32`. Passing one to the bridge
  // reached a `uuid` column and the pod logged
  //   PostgresError 22P02 invalid input syntax for type uuid
  //   [http] GET /api/tools/bridge/links 500
  // The presence of project_id was checked here all along; its SHAPE was not.
  const PSEUDO = 'stream:9b9fc446-3fff-4587-be44-68908427ea32';

  async function statusOf(fn: () => Promise<Response>): Promise<number> {
    try {
      return (await fn()).status;
    } catch (err) {
      // Asserted THROUGH handleError, never by catching a throw: #908 exists
      // because a comment claimed the router converted an error and it did not.
      return handleError(err).status;
    }
  }

  itDb('links: a non-UUID project_id → 400', async () => {
    const req = new Request(
      `${BASE}/api/tools/bridge/links?producer=kag&stable_id=probe&project_id=${encodeURIComponent(PSEUDO)}`,
    );
    const status = await statusOf(() => handleLookupLink(req));
    expect(status).toBe(400);
    expect(status).not.toBe(500);
  });

  itDb('links: a well-formed project_id is NOT rejected by the shape guard', async () => {
    // The control. Without it the assertion above is satisfied by a guard that
    // rejects everything, and the route would be broken in a new way.
    const req = new Request(
      `${BASE}/api/tools/bridge/links?producer=kag&stable_id=probe&project_id=${PROJECT_A}`,
    );
    const status = await statusOf(() => handleLookupLink(req));
    expect(status).not.toBe(400);
  });

  itDb('a body-supplied non-UUID project_id → 400 as well', async () => {
    // create/patch/submit/reject/commit take project_id from the JSON body, not
    // the query string, so they need the same guard — one check in
    // buildBridgeCtx rather than five copies that drift.
    const req = new Request(`${BASE}/api/tools/bridge/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: PSEUDO, producer: 'kag', output_ids: ['x'] }),
    });
    const status = await statusOf(() => handleCreateDrafts(req));
    expect(status).toBe(400);
    expect(status).not.toBe(500);
  });
});
