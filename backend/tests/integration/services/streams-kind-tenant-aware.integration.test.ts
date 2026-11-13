// Verifies streams_kind_tenant_check as migration 230 left it:
//   * kind ∈ {workflow, prompt} is rejected on EVERY tenant (their
//     pinned improvement tenants were deleted 2026-11-03), the deleted tenant
//     included
//   * kind ∈ {principle, requirement, decision} accepts any tenant_id
//
// Skip-if-unreachable matches the suite-wide pattern.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';

import { config } from '../../../src/config';

import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('streams-kind-tenant-aware');

// This file deliberately does NOT borrow the shared `queryClient` /
// `db` from src/db/client. Two reasons, both learned the hard way:
//
//   1. TEARDOWN. The shared client is owned by the whole `bun test`
//      invocation — a
//      suite must never call `queryClient.end()` on it, because CI runs
//      ~74 integration files in ONE process off that single pool.
//      Borrowing it therefore leaves this file with no legal way to
//      close anything. Owning a private client makes teardown both
//      possible and safe. Pattern copied verbatim from
//      tests/integration/scripts/encrypt-credentials.integration.test.ts
//      (its own `postgres(...)` + `afterAll` → `sql.end({ timeout })`).
//
//   2. SERIALISATION. `max: 1` pins every statement in this file —
//      probe, cleanup DELETE, and the INSERTs — to a single backend, so
//      a cleanup DELETE can never be in flight on one pooled connection
//      while the next test's INSERT touches the same rows on another.
//      That interleaving across the shared 10-connection pool is the
//      only lock-contention shape this file could ever have produced;
//      one connection removes it by construction. (Nothing in the file
//      opens a transaction, takes an advisory lock, does SELECT … FOR
//      UPDATE, or runs DDL — see the constraint itself in migration
//      066, which is a pure expression, and the only trigger on
//      `streams`, 057's BEFORE INSERT default_engage_andon, which is a
//      pure field assignment.)
const sqlc = postgres(config.database.url, { max: 1, onnotice: () => {} });

const ARBITRARY_TENANT_A = '11111111-2222-4333-8444-555555555555';
const ARBITRARY_TENANT_B = '22222222-3333-4444-8555-666666666666';
const PLACEHOLDER = 'planka-tbd';
const DELETED_WORKFLOW_TENANT = '0195f48b-d000-7000-8000-000000000002';

let reachable = false;

beforeAll(async () => {
  try {
    await sqlc`SELECT 1 FROM streams LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[streams-kind-tenant-aware] postgres unreachable — skipping:',
      (err as Error).message,
    );
  }
});

async function cleanup(): Promise<void> {
  if (!reachable) return;
  await sqlc`
    DELETE FROM streams
     WHERE tenant_id IN (${ARBITRARY_TENANT_A}, ${ARBITRARY_TENANT_B})
  `;
}

afterAll(async () => {
  try {
    await cleanup();
  } finally {
    // Close the pool this file opened. Safe precisely because it is
    // private to this file — no sibling suite shares it.
    await sqlc.end({ timeout: 5 });
  }
});

// Why these two assertions go through an async IIFE instead of the obvious
// `await expect(sqlc\`…\`).rejects.toThrow(…)`:
//
// A postgres.js tagged template returns a LAZY thenable — the statement is not
// sent to the server until something calls `.then()` on it. Handing that object
// straight to `expect().rejects` never triggers execution, so the promise never
// settles and the test sits until bun's 5s timeout, twice, and the file exits
// 124. That is the whole "hang" this file was quarantined for, and it was
// recorded as "lock contention": measured live, Postgres held NO locks and had
// NO blocked backends during the hang — the file's connections sat in
// `idle:ClientRead`, i.e. the server was waiting for a client that had never
// sent the INSERT at all.
//
// Awaiting inside an async IIFE forces execution and produces a real rejected
// promise for `.rejects` to inspect.
describe('streams_kind_tenant_check (migration 230)', () => {
  itDb('kind=workflow is rejected', async () => {
    await cleanup();
    await expect(
      (async () => {
        await sqlc`
          INSERT INTO streams (tenant_id, kind, name, slug, planka_project_id, planka_board_id)
          VALUES (${ARBITRARY_TENANT_A}, 'workflow', 'illegal-w', 'illegal-w', ${PLACEHOLDER}, ${PLACEHOLDER})
        `;
      })(),
    ).rejects.toThrow(/streams_kind_tenant_check/);
  });

  itDb('kind=prompt is rejected', async () => {
    await cleanup();
    await expect(
      (async () => {
        await sqlc`
          INSERT INTO streams (tenant_id, kind, name, slug, planka_project_id, planka_board_id)
          VALUES (${ARBITRARY_TENANT_A}, 'prompt', 'illegal-p', 'illegal-p', ${PLACEHOLDER}, ${PLACEHOLDER})
        `;
      })(),
    ).rejects.toThrow(/streams_kind_tenant_check/);
  });

  itDb('kind=workflow is rejected even on the deleted workflow-improvement tenant', async () => {
    await expect(
      (async () => {
        await sqlc`
          INSERT INTO streams (tenant_id, kind, name, slug, planka_project_id, planka_board_id)
          VALUES (${DELETED_WORKFLOW_TENANT}, 'workflow', 'illegal-w2', 'illegal-w2', ${PLACEHOLDER}, ${PLACEHOLDER})
        `;
      })(),
    ).rejects.toThrow(/streams_kind_tenant_check/);
  });

  for (const kind of ['principle', 'requirement', 'decision'] as const) {
    itDb(`kind=${kind} accepts arbitrary tenant A`, async () => {
      await cleanup();
      const inserted = await sqlc<
        { id: string; kind: string; tenant_id: string }[]
      >`
        INSERT INTO streams (tenant_id, kind, name, slug, planka_project_id, planka_board_id)
        VALUES (
          ${ARBITRARY_TENANT_A},
          ${kind},
          ${`a-${kind}`},
          ${`a-${kind}`},
          ${PLACEHOLDER},
          ${PLACEHOLDER}
        )
        RETURNING id, kind, tenant_id
      `;
      expect(inserted.length).toBe(1);
      expect(inserted[0]!.kind).toBe(kind);
      expect(inserted[0]!.tenant_id).toBe(ARBITRARY_TENANT_A);
    });

    itDb(`kind=${kind} accepts arbitrary tenant B`, async () => {
      await cleanup();
      const inserted = await sqlc<
        { id: string; kind: string; tenant_id: string }[]
      >`
        INSERT INTO streams (tenant_id, kind, name, slug, planka_project_id, planka_board_id)
        VALUES (
          ${ARBITRARY_TENANT_B},
          ${kind},
          ${`b-${kind}`},
          ${`b-${kind}`},
          ${PLACEHOLDER},
          ${PLACEHOLDER}
        )
        RETURNING id, kind, tenant_id
      `;
      expect(inserted.length).toBe(1);
      expect(inserted[0]!.kind).toBe(kind);
      expect(inserted[0]!.tenant_id).toBe(ARBITRARY_TENANT_B);
    });
  }
});
