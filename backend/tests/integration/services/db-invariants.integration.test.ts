// Plan 7 Stage 0a §4 + round-2 CHECK-parity follow-up — CI/prod parity invariant.
//
// drizzle-kit push (CI's bootstrap step) does NOT emit CHECK constraints that
// live only in hand-written SQL migrations, and the migration-runner stamps
// those migrations "applied" without executing their SQL on a push-bootstrapped
// DB (no 000-baseline; probe-aware skip). So the ONLY way a hand-written CHECK
// lands in a CI-shaped DB is a matching table-level `check()` in schema.ts that
// push emits. If that declaration is missing, CI silently relaxes a
// prod-enforced invariant — the exact drift this test fails on.
//
// This asserts every structurally-complex CHECK closed in the round-2 parity
// pass exists on a push-bootstrapped DB AND that its pg_get_constraintdef is
// byte-for-byte identical to the form the SQL migration produces in prod
// (verified: migrations 065 / 060 / 044). Existence alone is not enough — a
// re-worded expression would pass an EXISTS probe while quietly diverging from
// prod, so we pin the canonical constraint text too.
//
// PR #727 (scheduled-trigger enum CHECKs) proved parity the same way: declare
// the constraint in schema.ts, and this integration test — run against a
// drizzle-kit-push DB (`DATABASE_URL`) — hard-fails RED without it.
//
// Skip-if-unreachable. Otherwise: hard fail when a constraint is missing or
// its definition drifts from the prod-canonical form.

import { test, expect, beforeAll } from 'bun:test';
import { queryClient } from '../../../src/db/client';

import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('db-invariants');

let reachable = false;

beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM streams LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[db-invariants] postgres unreachable — skipping:',
      (err as Error).message,
    );
  }
});

// name → { table, def }. `def` is the exact `pg_get_constraintdef(oid)` string
// Postgres emits for the constraint as written in its source migration
// (065 andon_state singleton, 066 streams kind/tenant rewrite — the CURRENT
// prod form: lineage 038→060→062→066, NOT the stale 060 — and 044 streams
// notification_channels jsonb-array guard). Captured from a real Postgres 18 by
// applying the migration SQL verbatim; drizzle-push must canonicalize to the
// identical string.
const PARITY_CHECKS: { name: string; table: string; def: string }[] = [
  {
    name: 'andon_state_id_check',
    table: 'andon_state',
    def: 'CHECK ((id = 1))',
  },
  {
    name: 'streams_kind_tenant_check',
    table: 'streams',
    def:
      // Migration 230: the workflow / prompt / procedure arms named the deleted improvement tenants.
      "CHECK ((((kind)::text = 'principle'::text) OR ((kind)::text = 'requirement'::text) OR " +
      "((kind)::text = 'decision'::text)))",
  },
  {
    name: 'streams_notification_channels_is_array',
    table: 'streams',
    def: "CHECK ((jsonb_typeof(notification_channels) = 'array'::text))",
  },
];

for (const { name, table, def } of PARITY_CHECKS) {
  itDb(`${name} exists on ${table} (CI/prod CHECK parity)`, async () => {
    const rows = await queryClient<{ def: string | null }[]>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = ${name}
        AND conrelid = ${table}::regclass
    `;
    // Missing constraint → undefined → fails here. This is the RED state on a
    // push DB built from a schema.ts that lacks the table-level check().
    expect(rows[0]?.def).toBe(def);
  });
}

itDb('stream_kind enum carries all 5 labels (workflow/prompt + 3 asset kinds)', async () => {
  const rows = await queryClient<{ enumlabel: string }[]>`
    SELECT enumlabel FROM pg_enum
    WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'stream_kind')
    ORDER BY enumlabel
  `;
  const labels = rows.map((r) => r.enumlabel).sort();
  // 'procedure' (migration 066) was removed by migration 233 with the
  // procedures asset type.
  expect(labels).toEqual([
    'decision',
    'principle',
    'prompt',
    'requirement',
    'workflow',
  ]);
});
