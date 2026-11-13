// tests/integration/streams-slug.test.ts
//
// Streams Frontend Removal plan, Task 1.1.
//
// Verifies migration 050_streams_slug.sql:
//   - adds NOT NULL `slug text` column on streams,
//   - enforces UNIQUE per (tenant_id, slug) via `streams_tenant_slug_uniq`.
//
// The migration itself does NOT seed the 2 baseline rows on a fresh DB —
// that's the responsibility of the create-stream code path (POST
// /api/assets/streams or AG-UI streams.create) which now requires `slug`.
// This test exercises that round-trip directly against the repository.
//
// Same skip-if-unreachable pattern as
// streams-repository.integration.test.ts so the suite stays green on dev
// machines without a live DB.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, like, or } from 'drizzle-orm';

import { db, queryClient } from '../../src/db/client';
import { streams } from '../../src/db/schema';
import {
  createStream,
  DEFAULT_THRESHOLD_RULES,
} from '../../src/services/streams/repository';
// A tenant of its own: the slug index is per (tenant_id, slug). (Was the deleted
// workflow-improvement tenant; workflow-kind streams are refused since migration 230.)
const STREAM_TENANT = '0195f48b-1188-7000-8000-0000000051a9';

import { createDbSuite } from './helpers/db-suite';

const { itDb } = createDbSuite('streams-slug');

let reachable = false;

const TEST_SLUG_ROUND_TRIP = 'task-1-1-round-trip';
const TEST_SLUG_DUP = 'task-1-1-duplicate-test';

beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM streams LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[streams-slug.integration] postgres unreachable — skipping:',
      (err as Error).message,
    );
    return;
  }
  // Pre-clean any leftover rows from a previous failed run.
  await db
    .delete(streams)
    .where(
      and(
        eq(streams.tenant_id, STREAM_TENANT),
        inArray(streams.slug, [TEST_SLUG_ROUND_TRIP, TEST_SLUG_DUP]),
      ),
    );
});

afterAll(async () => {
  if (!reachable) return;
  await db
    .delete(streams)
    .where(
      and(
        eq(streams.tenant_id, STREAM_TENANT),
        inArray(streams.slug, [TEST_SLUG_ROUND_TRIP, TEST_SLUG_DUP]),
      ),
    );
});

itDb('createStream + slug round-trips through the streams.slug column', async () => {

  const created = await createStream({
    tenantId: STREAM_TENANT,
    kind: 'decision',
    name: 'task-1-1 round-trip stream',
    slug: TEST_SLUG_ROUND_TRIP,
    plankaProjectId: 'test-project-id',
    plankaBoardId: 'planka-tbd',
    thresholdRules: { ...DEFAULT_THRESHOLD_RULES },
  });
  expect(created.slug).toBe(TEST_SLUG_ROUND_TRIP);

  const rows = await db
    .select({ slug: streams.slug })
    .from(streams)
    .where(
      and(
        eq(streams.tenant_id, STREAM_TENANT),
        eq(streams.slug, TEST_SLUG_ROUND_TRIP),
      ),
    )
    .limit(1);
  expect(rows[0]?.slug).toBe(TEST_SLUG_ROUND_TRIP);
});

itDb('streams.slug is UNIQUE per (tenant_id, slug)', async () => {

  // First insert succeeds.
  await createStream({
    tenantId: STREAM_TENANT,
    kind: 'decision',
    name: 'task-1-1 duplicate seed',
    slug: TEST_SLUG_DUP,
    plankaProjectId: 'test-project-id',
    plankaBoardId: 'planka-tbd',
    thresholdRules: { ...DEFAULT_THRESHOLD_RULES },
  });

  // Second insert with the same (tenant_id, slug) must fail on the unique
  // index. Walk both the top-level error and `.cause` looking for
  // postgres's `code` (23505 = unique_violation) or duplicate-key text.
  let caught: unknown;
  try {
    await db.insert(streams).values({
      tenant_id: STREAM_TENANT,
      kind: 'decision',
      name: 'collision-test',
      slug: TEST_SLUG_DUP,
      planka_project_id: 'fake',
      planka_board_id: 'fake',
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const probe = (val: unknown): { code?: string; message?: string } | null =>
    val && typeof val === 'object' ? (val as Record<string, unknown>) : null;
  const top = probe(caught) ?? {};
  const cause = probe((caught as { cause?: unknown }).cause) ?? {};
  const code = (top.code as string | undefined) ?? (cause.code as string | undefined);
  const messages = [top.message, cause.message].filter(Boolean).join(' | ');
  const matched =
    code === '23505' || /duplicate key|unique/i.test(messages);
  expect(matched).toBe(true);
});
