// Seed representative data into the CI ephemeral Postgres before
// `bun run migrate` runs.
//
// Why this exists: migrations like
// `029_backfill_workspaces_default_dept.sql` evaluate expressions
// (COALESCE, JOIN, INSERT FROM ...) only when the source table has rows.
// CI's ephemeral DB is empty at boot, so the row-conditional code paths
// never execute and class-of-bug type mismatches silently no-op. The
// 2026-04-29 outage was caused by exactly this gap: a COALESCE(text, uuid)
// shipped to prod after passing CI smoke against an empty `user_roles`.
//
// Each seed row is the minimum needed to exercise a known migration
// pattern. When you add a new migration that references an existing
// table's rows (`INSERT ... SELECT FROM x`, `UPDATE ... FROM x`, JOINs
// against existing data), add a representative row here.
//
// Idempotent — safe to re-run. Each INSERT uses `ON CONFLICT DO NOTHING`
// against a stable composite key.

import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[ci-seed] DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(url);

try {
  // user_roles: at least one row so `029_backfill_workspaces_default_dept`
  // and any future migration that does `SELECT ... FROM user_roles`
  // actually evaluates its expressions. tenant_id MUST be a real
  // UUID7-shaped value because migration 029 inserts it into a uuid
  // column without an explicit cast in the source SELECT.
  //
  // The role is 'workspace-admin', and it MUST be a value the product
  // actually issues. It was 'admin' — which no grant path can write, and
  // which migration 104 now forbids outright via
  // `CHECK (role IN ('workspace-admin','workspace-member'))`. That seed row
  // would have aborted 104 in CI on its own guard clause, reporting a data
  // problem in a database whose only 'admin' row this file had just created.
  // Seed data has to be REPRESENTATIVE — a value production cannot contain
  // tests migrations against a world that does not exist.
  const tenantId = '01934567-89ab-7def-8123-456789abcdef';
  await sql`
    INSERT INTO user_roles (user_id, tenant_id, tenant_name, role, granted_by)
    VALUES (
      'ci-seed-user-1',
      ${tenantId}::uuid,
      'CI Seed Tenant',
      'workspace-admin',
      'system-ci-seed'
    )
    ON CONFLICT (user_id, tenant_id, role) DO NOTHING
  `;

  // System bootstrap workspace. The AUTH_BYPASS code path in
  // src/middleware/auth.ts hands every request a synthetic user with
  // tenantId = '00000000-0000-0000-0000-000000000000'. Several integration
  // routes (anything that goes through `applyEffectiveFilter`, channels-
  // registry, etc.) use that tenantId as `workspace_id` when writing to
  // `asset_assignments` / `channels`, both of which carry an FK to
  // `workspaces`. Without a row here, those writes 23503 in CI even though
  // the route logic is correct. Idempotent via ON CONFLICT.
  const SYSTEM_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';
  await sql`
    INSERT INTO workspaces (id, name)
    VALUES (${SYSTEM_WORKSPACE_ID}::uuid, 'System Bootstrap (AUTH_BYPASS)')
    ON CONFLICT (id) DO NOTHING
  `;

  // ── THE GLOBAL ANDON SINGLETON (migration 065) ─────────────────────────────
  //
  // ⛔ WITHOUT THIS ROW THE CI DATABASE HAS NO ANDON CORD AT ALL, and since
  // 2026-09-24 that is not cosmetic: `handleN8nRouterDedupe` consults the cord
  // before it claims a dedupe key and FAILS CLOSED on an absent singleton
  // (`{routed:false, reason:'andon_uninitialised'}`, no claim written, no
  // `duplicate` verdict). Nine webhook test cases
  // asserted `duplicate === false` and received `undefined`, each one preceded by
  // `{"outcome":"andon_uninitialised"}` in the log. Those failures were REAL — they
  // were fr telling us the CI database is a broken install, not a released cord.
  //
  // ⭐ WHY CI LACKS A ROW THAT 065 EXPLICITLY INSERTS, WHICH IS THE WHOLE POINT:
  // CI does not RUN 065. `drizzle-kit push` builds the schema from `schema.ts`, so
  // the `andon_state` TABLE arrives — push manages DDL and emits no DML. Then
  // `bun run migrate` finds `_migrations` empty on a DB that already has
  // `projects`, takes the BACKFILL path in `src/db/migration-runner.ts`, and
  // STAMPS every migration filename applied without executing it. 065's
  // `INSERT INTO andon_state (id, engaged) VALUES (1, FALSE)` is therefore never
  // executed on any push-bootstrapped database. Table present, zero rows. It is
  // exactly the class `COLUMN_PROBES` exists for ("push builds a schema; it has no
  // RECEIPT the backfill writes for itself"), and the row is DML.
  //
  // ⛔ WHY NOT A `COLUMN_PROBES` ENTRY FOR 065, which is the obvious move and is
  // WRONG: a probe would leave 065 PENDING and the apply loop would re-run it
  // WHOLE — and 065 ends with `CREATE OR REPLACE FUNCTION andon_state_history_trg`
  // + `CREATE TRIGGER trg_andon_state_history`, both of which migration 085
  // deliberately DROPPED so the application is the single recorder of every flip.
  // 085 would stay stamped-applied (its DROPs are already satisfied), so the
  // trigger would come back ONLY in CI and every engage/release would write TWO
  // `andon_state_history` rows — CI diverging from prod on the audit trail the
  // andon exists to keep. 085's own header even records that "in CI the trigger
  // never existed". A seed row here is idempotent, touches nothing else, and keeps
  // that true.
  //
  // ⚠️ `engaged = FALSE` is the RELEASED cord, and it is the same value 065 seeds
  // in prod — this restores parity, it does not weaken anything. The fail-closed
  // behaviour on an ABSENT singleton stays exactly as it is.
  //
  // ⚠️ SCOPE, STATED: this fixes CI. A future prod/staging database bootstrapped
  // the same push+backfill way would ALSO come up with no singleton, and there the
  // fail-closed brake would halt AA dispatch fleet-wide from the first card move.
  // The current prod DB does carry the row, so that is an exposure on a REBUILD,
  // not a live defect.
  //
  // ✅ CORRECTED: that durable fix IS IN THIS CHANGE — migration
  // `131_andon_singleton_reassert.sql`, forward-only, carrying a ROW-PRESENCE
  // probe registered in `src/db/migration-runner.ts` (`reapplyIfProbeFails:
  // true`, `SELECT EXISTS (SELECT 1 FROM andon_state WHERE id = 1)`) so a fresh
  // database EXECUTES it instead of stamping it, and a later wipe of the row
  // un-stamps and re-runs it instead of failing every boot. This comment previously said the migration was "outside this
  // change's ownership and is reported rather than smuggled in here", which was
  // true when it was written and became false in the same PR. The seed below is
  // therefore no longer the only line of defence; it stays because it is what
  // makes CI green BEFORE the migration runner is involved at all (`push`
  // creates the table, this seeds the row, 131 re-asserts it on every
  // non-`push` bootstrap).
  await sql`
    INSERT INTO andon_state (id, engaged) VALUES (1, FALSE)
    ON CONFLICT (id) DO NOTHING
  `;

  console.log('[ci-seed] OK');
} finally {
  await sql.end();
}
