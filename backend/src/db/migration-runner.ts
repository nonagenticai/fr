// src/db/migration-runner.ts
//
// Sequential SQL migration runner.
//
// Replaces the previous `drizzle-kit push` fallback, which was destructive and
// only ran if the `projects` table was entirely absent. The runner:
//   * reads backend/migrations/NNN_*.sql in numeric order,
//   * tracks applied filenames in a `_migrations` table,
//   * wraps each file in a transaction (rollback + throw on error),
//   * uses a Postgres session advisory lock so concurrent pods serialize,
//   * backfills `_migrations` when encountering a pre-existing `projects` table
//     (prod pre-dates this runner; assume history is fully applied) and then
//     verifies a list of known target columns / tables (the COLUMN_PROBES
//     registry below) actually exist — any backfill candidate whose target
//     is missing is left in `pending` so the apply loop self-heals it, and
//     any post-run probe miss raises a hard error for an operator to
//     reconcile manually. Add a probe whenever a future migration introduces
//     a column/table whose absence would cause silent test or runtime failures.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

import { LOCK_KEYS } from './advisory-lock-keys';

/** Advisory-lock key. Registered in src/db/advisory-lock-keys.ts — the only place one may be declared. */
const ADVISORY_LOCK_KEY = LOCK_KEYS.migrationRunner;

/** Default location of migration SQL files, relative to the backend package root. */
const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dir, '..', '..', 'migrations');

/** Matches `NNN_whatever.sql` (three or more leading digits). */
const MIGRATION_FILE_RE = /^(\d{3,})_.*\.sql$/;

export interface ApplyMigrationsOptions {
  /** Directory containing NNN_*.sql files. Defaults to `<backend>/migrations`. */
  migrationsDir?: string;
}

/**
 * A column / table probe used in two phases:
 *
 *   1. Backfill skip: when the runner detects an empty `_migrations` table
 *      on a DB whose `projects` table predates the runner, every migration
 *      with a probe whose target is currently MISSING is left in `pending`
 *      so the normal apply loop runs it (self-heal). Migrations without a
 *      probe are stamped applied — that's the original behaviour for files
 *      whose absence would not silently break tests / runtime code.
 *
 *   2. Post-run integrity check: after the apply loop, every probe is
 *      re-evaluated. Any probe whose target is still missing throws a hard
 *      error so an operator must reconcile the schema manually before the
 *      service starts serving traffic.
 *
 * Add a probe whenever a future migration introduces a column / table whose
 * absence would cause silent test failures (uniform RBAC failures in CI on
 * a stale DB are the canonical example — see Spec 2 Plan 2-C Phase 0).
 */
type Probe = {
  migration: string;
  check: (sql: postgres.ISql) => Promise<boolean>;
  /**
   * ⭐ SELF-HEAL AN ALREADY-STAMPED MIGRATION WHOSE PROBE FAILS.
   *
   * ⛔ THE WEDGE THIS CLOSES. The apply loop below runs only migrations that are
   * NOT in `_migrations`. So a database that ran an EARLIER DRAFT of a file —
   * the same filename, different contents — is stamped applied forever, and any
   * corrective logic inside that file (113's definition-comparing DO block is
   * the live example) is unreachable BY CONSTRUCTION. The probe then fails, the
   * post-run integrity check throws, and it throws on EVERY BOOT with no way
   * out except hand-written SQL against `_migrations`. Nothing in the runner
   * could ever fix it, because the fix was inside the file it refused to re-run.
   *
   * That is not hypothetical: it is created by an ordinary rebase. A developer
   * worktree or a re-used CI database that applied an in-flight draft of a
   * migration and then pulled the corrected version lands in it.
   *
   * When this is set, an applied migration whose probe reads FALSE is
   * un-stamped and handed back to the apply loop, in the SAME transaction, so
   * the file runs again and re-stamps itself.
   *
   * ⛔ ONLY SET THIS ON A FILE THAT IS GENUINELY IDEMPOTENT — every statement
   * `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` / guarded by a definition
   * comparison, and no unconditional INSERT, DELETE or destructive ALTER. A
   * re-run of a non-idempotent file is a data-loss event, which is strictly
   * worse than the boot failure it would be curing. Read the file and satisfy
   * yourself statement by statement; do not set it by analogy.
   */
  reapplyIfProbeFails?: boolean;
};

const COLUMN_PROBES: Probe[] = [
  {
    migration: '006_projects_planka_project_id.sql',
    check: (sql) => columnExists(sql, 'projects', 'planka_project_id'),
  },
  {
    migration: '026_workspaces_and_departments.sql',
    check: (sql) => columnExists(sql, 'projects', 'dept_id'),
  },
  {
    migration: '027_dept_member_roles.sql',
    check: (sql) => tableExists(sql, 'department_members'),
  },
  {
    migration: '034_channels_registry.sql',
    check: (sql) => tableExists(sql, 'channels'),
  },
  {
    migration: '044_streams_notification_channels.sql',
    check: (sql) => columnExists(sql, 'streams', 'notification_channels'),
  },
  {
    migration: '045_spec_2_continuous_flow.sql',
    check: (sql) => tableExists(sql, 'scheduled_triggers'),
  },
  {
    migration: '049_suggested_schedules.sql',
    check: (sql) => tableExists(sql, 'suggested_schedules'),
  },
  {
    migration: '051_scheduled_triggers_from_suggestion.sql',
    check: (sql) =>
      columnExists(sql, 'scheduled_triggers', 'from_suggestion_id'),
  },
  // Partial unique index that arbitrates concurrent identical
  // POST /api/tools/bridge/drafts (race-loser path returns 200 + replayed=true).
  // The index isn't part of the drizzle schema (drizzle doesn't model partial
  // expression indexes on JSONB), so `drizzle-kit push` doesn't create it on
  // a fresh CI DB — without this probe the migration is marked applied at
  // backfill time and the bridge race test silently produces two 201s.
  {
    migration: '020_bridge_idempotency_unique_idx.sql',
    check: (sql) => indexExists(sql, 'card_drafts_idempotency_unique_idx'),
  },
  // CHECK constraint restricting user_roles.role to the two roles the product
  // issues. ⚠️ CORRECTED 2026-09-06 — this said "Drizzle has no CHECK primitive,
  // so `drizzle-kit push` does not create it". The premise is false (see the 113
  // entry below: `check` is imported in schema.ts and push emits what it
  // declares); the OBSERVATION still holds for one narrower reason — nobody has
  // declared `user_roles_role_check` in schema.ts, so push does not create it
  // there. ⛔ That makes this probe CONDITIONAL ON AN OMISSION: declare that
  // check in schema.ts for parity and this probe silently goes vacuous, and 104
  // is stamped applied without its DELETE ever running. 104 carries DML, so if
  // it is ever declared there, move this probe onto 104's own data effect the
  // way 113's now is. WITHOUT THIS PROBE the backfill stamps 104 applied
  // against a database that never got the constraint. MEASURED on a fresh
  // postgres:18 bootstrapped exactly as CI does (push -> ci-seed -> migrate):
  // `_migrations` held 104_user_roles_role_check.sql, `pg_constraint` held
  // nothing, and inserting role='admin' succeeded. The migration's ordering (the
  // DELETE must precede the ADD CONSTRAINT) and its guard clause would have been
  // exercised on exactly zero CI runs while CI reported green.
  {
    migration: '104_user_roles_role_check.sql',
    check: (sql) => constraintExists(sql, 'user_roles', 'user_roles_role_check'),
  },
  // Unique index on (user_id, channel, thread_id) backing the upsert in
  // session-store.ts (`ON CONFLICT (user_id, channel, thread_id)`). Drizzle
  // schema doesn't define it (uniqueIndex on a 3-col tuple was historically
  // declared in SQL only), so drizzle-kit push doesn't create it. Without
  // this probe the agent-runtime integration suite blows up with
  // "no unique or exclusion constraint matching the ON CONFLICT specification".
  {
    migration: '025_agent_runtime_sessions.sql',
    check: (sql) =>
      indexExists(sql, 'idx_agent_runtime_sessions_user_channel_thread'),
  },
  // Spec 2 super-admin user provisioning (Task 1). Records every Keycloak
  // create + license mint + budget set with status; absence would silently
  // break the super-admin route's audit insert path on a stale DB.
  {
    migration: '056_provisioning_audit.sql',
    check: (sql) => tableExists(sql, 'provisioning_audit'),
  },
  // Plan 7 Stage 0a — stream_kind enum extension (principle/requirement/
  // decision) and a kind-aware streams_kind_tenant_check rewrite.
  // drizzle-kit push doesn't emit CHECK constraints OR enum extensions for
  // an existing type, so on a CI DB bootstrapped via push the new labels
  // and the new constraint shape are both absent. Probe the enum-label
  // presence; absence forces re-apply, which runs both the ALTER TYPE ADD
  // VALUE and the CHECK rewrite from a single SQL file.
  {
    migration: '059_streams_kind_tenant_aware.sql',
    check: async (sql) => {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'stream_kind')
            AND enumlabel = 'principle'
        ) AS exists
      `;
      return Boolean(rows[0]?.exists);
    },
  },
  // PR 2/3 of the task #25 scope-B lane — N:M project↔repo join table +
  // the supporting (user_id, url) unique on `repositories` that the
  // create-or-attach handler's `ON CONFLICT` clause names. Probe the
  // table since the join row is the only way the attach/promote handlers
  // can resolve membership; a missing table silently 404s every list.
  {
    migration: '072_project_repositories.sql',
    check: (sql) => tableExists(sql, 'project_repositories'),
  },
  // 073 — execution.ready_signoff approval_kind enum label. Like 059's
  // stream_kind extension, drizzle-kit push doesn't emit enum extensions for
  // an existing type, so on a CI DB bootstrapped via push the label is absent.
  // Probe the pg_enum label; absence forces re-apply of the ALTER TYPE.
  {
    migration: '073_approval_kind_execution_ready_signoff.sql',
    check: async (sql) => {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'approval_kind')
            AND enumlabel = 'execution.ready_signoff'
        ) AS exists
      `;
      return Boolean(rows[0]?.exists);
    },
  },
  // 074 — project_stakeholders, the source-of-truth roster the execution
  // approval create-path reads. A missing table silently 422s every
  // POST /api/execution/approvals (no approvers resolvable).
  {
    migration: '074_project_stakeholders.sql',
    check: (sql) => tableExists(sql, 'project_stakeholders'),
  },
  // 076 (campaign_governance_controls) HAD a probe here. REMOVED with migration 197, which
  // drops that table and campaign_jobs (their code was deleted in fr-agui P4d-2a / P4d-2d):
  // a probe on a table a later migration drops reads FALSE on every boot, and the post-run
  // integrity check throws on the first miss. Without a probe, 076 is stamped on backfill and
  // 197's DROP ... IF EXISTS is a no-op on a fresh database.
  // WS1 Phase 1A — project-execution notification hub. The `notifications`
  // table is the durable per-user inbox + drives the unread badge; its
  // absence would silently 500 every /api/me/notifications read and drop
  // every lifecycle/outcome event on the floor. (notification_prefs shares
  // the same migration, so probing one table covers both.)
  {
    migration: '077_project_execution_notifications.sql',
    check: (sql) => tableExists(sql, 'notifications'),
  },
  // 081 — macro lifecycle phase backing the redesign's phase rail. Absence
  // makes handleGetProject/handleListProjects omit `project_phase` and 500s the
  // phase read/write endpoints on a stale DB (drizzle-kit push DOES add the
  // column on a fresh CI DB, but the probe self-heals a pre-runner prod DB).
  {
    migration: '081_project_phase.sql',
    check: (sql) => columnExists(sql, 'projects', 'project_phase'),
  },
  // 086 — improvement.canary_action approval_kind enum label (WS-3). Like 073's
  // execution.ready_signoff, drizzle-kit push doesn't emit enum extensions for
  // an existing type, so on a CI DB bootstrapped via push the label is absent.
  // Probe the pg_enum label; absence forces re-apply of the ALTER TYPE. Without
  // it the canary Rollback/Extend approval INSERT 500s on a push-bootstrapped DB.
  {
    migration: '086_approvals_kind_canary.sql',
    check: async (sql) => {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'approval_kind')
            AND enumlabel = 'improvement.canary_action'
        ) AS exists
      `;
      return Boolean(rows[0]?.exists);
    },
  },
  // 087 — documents.kag_document_id, the STABLE content-derived id the purge keys on.
  // Absence is the silent kind this registry exists for: the column is only ever read
  // through a `?? kag_ingestion_id` fallback, so a DB missing it degrades to purging by
  // the per-run job id instead of failing loudly.
  {
    migration: '087_documents_kag_document_id.sql',
    check: (sql) => columnExists(sql, 'documents', 'kag_document_id'),
  },
  // 093 — budget_alert_receipts, the idempotency store the billing budget-alert
  // webhook receiver keys its ON CONFLICT on. Absence would silently 500 every
  // POST /api/webhooks/billing/budget-threshold (insert into a missing table),
  // dropping budget notifications on the floor.
  {
    migration: '093_budget_alert_receipts.sql',
    check: (sql) => tableExists(sql, 'budget_alert_receipts'),
  },
  // 094 — scheduled_triggers.permanent_failure_count, the ledger the cron tick
  // writes back on EVERY trigger arm. Its absence is not a degraded read, it is
  // a fleet-wide outage: the UPDATE throws, the throw escapes the
  // `queryClient.begin(...)` spanning every enabled trigger of every tenant, and
  // the whole tick rolls back — so no trigger's `last_run_at` ever advances and
  // the entire scheduler wedges with one console.error per minute as the only
  // symptom. (disabled_reason ships in the same migration, so probing one column
  // covers both.)
  {
    migration: '094_scheduled_triggers_permanent_failure_ledger.sql',
    check: (sql) =>
      columnExists(sql, 'scheduled_triggers', 'permanent_failure_count'),
  },

  // 099 — documents.kag_degraded, the flag that stops fr rendering a green
  // "completed" over a graph that lost 86% of its chunks. Its absence is the
  // SILENT kind this registry exists for: every reader is null-tolerant (NULL ==
  // "unknown degradation"), so a DB missing the column degrades straight back to
  // the pre-099 defect — every document looks clean — with no error anywhere.
  // (The other five columns ship in the same migration, so probing one covers all.)
  {
    migration: '099_documents_kag_degraded.sql',
    check: (sql) => columnExists(sql, 'documents', 'kag_degraded'),
  },

  // 082 — router_dedupe. ⚠️ FOUND WHILE BUILDING 100, NOT A DRIVE-BY: this probe was
  // MISSING, and the consequence is measured, not theoretical. The table is raw-SQL
  // only (not in the drizzle schema), so on a `drizzle-kit push`-bootstrapped CI
  // database the backfill stamped 082 applied against a DB with no `router_dedupe`
  // table — verified locally 2026-08-17 on a fresh postgres:18 bootstrapped exactly
  // as scripts/ci-test.sh does. The four `handleN8nRouterDedupe` tests guarded on `SELECT 1 FROM router_dedupe` and
  // therefore SKIPPED on every CI run, INCLUDING the 8-concurrent-claim atomicity
  // test that is the whole proof of the router's TOCTOU backstop. 082's SQL is
  // CREATE TABLE / INDEX IF NOT EXISTS, so re-applying it is a no-op wherever the
  // table already exists (prod).
  {
    migration: '082_router_dedupe.sql',
    check: (sql) => tableExists(sql, 'router_dedupe'),
  },

  // 100 — card_phase_lease, the atomic card claim (PRODUCTION_READINESS.md Part 3).
  // The table is NOT in the drizzle schema (it is raw-SQL like `router_dedupe`), so
  // `drizzle-kit push` does not create it on a fresh CI DB; without this probe the
  // backfill stamps 100 applied against a database that never got the table, the
  // lease suite's `SELECT 1 FROM card_phase_lease` guard fails, and every atomicity
  // test SKIPS while CI reports green. That is the exact "green that proves nothing"
  // shape this registry exists to prevent — and it is not hypothetical: `082_router_
  // dedupe.sql` has no probe, so the 8-concurrent-claim atomicity test it ships with
  // has been skipping on every push-bootstrapped CI database since it landed.
  {
    migration: '100_card_phase_lease.sql',
    check: (sql) => tableExists(sql, 'card_phase_lease'),
  },

  // 101 — approval triage + approver routing. ALTER TABLE on an existing table, so
  // unlike 100 the table always exists and `tableExists` would pass vacuously on a DB
  // that never ran the migration. Probe a COLUMN the migration introduces instead —
  // the approval-routing suite guards on `approver_user_id` and would otherwise SKIP
  // on a drizzle-push-bootstrapped CI database while reporting green, which is exactly
  // the 082_router_dedupe shape this registry exists to prevent.
  //
  // ⚠️ CORRECTED 2026-08-29: `approver_user_id` WAS ALSO VACUOUS, one level down.
  // Drizzle models that column, so `drizzle-kit push` creates it, so the probe
  // passed on every fresh CI database and 101 was stamped applied without running.
  // MEASURED on a fresh postgres:18 bootstrapped as CI does: all four triage
  // columns present (push made them), `approvals_triage_verdict_check` ABSENT, and
  // `approvals` carried no CHECK constraint at all. The verdict enum was therefore
  // unenforced on every CI run — a test writing an invalid triage_verdict would
  // have passed. The probe then targeted the CHECK.
  //
  // ── ⚠️ MOVED AGAIN 2026-09-23, OFF THE CHECK AND ONTO THE INDEX ────────────────
  // The 2026-08-29 note ended "the only honest witness that the file ran". The
  // "honest" half was right; the "only" half was NOT MEASURED, and it is false.
  // 101 emits FOUR kinds of artefact, and drizzle models only some of them:
  //
  //   six ADD COLUMNs ......... MODELLED (schema.ts declares all six) → vacuous
  //   the verdict CHECK ....... not modelled → honest, but see below
  //   approvals_approver_pending_idx  ) partial indexes, and schema.ts declares
  //   approvals_undelivered_idx       ) NO index on `approvals` at all → honest
  //
  // MEASURED 2026-09-23 by reading `src/db/schema.ts`: the `approvals` pgTable's
  // extras argument (:1189-1194) contains exactly ONE entry — the migration-113
  // `approvals_callback_resolution_check` — and ZERO `index()` / `uniqueIndex()`
  // declarations. Repo-wide, the strings `approvals_undelivered_idx` and
  // `approvals_approver_pending_idx` occur ONLY inside 101's .sql file. So both
  // indexes are as un-pushable as the CHECK was, and the CHECK was never the only
  // candidate.
  //
  // ⭐ WHY MOVE, GIVEN THE CHECK PROBE WORKS TODAY. Because the CHECK is SCHEDULED
  // FOR DEMOLITION and the index is not. The four `triage_*` columns are write-only
  // (see the tombstone on `TriageApprovalSchema`'s old home in routes/approvals.ts
  // and the schema.ts note at the columns), their last writers were removed in this
  // change, and migration **130** will DROP the columns and the CHECK. A probe
  // pointed at an artefact a queued migration deletes does not survive that
  // migration: 130 would make 101's probe read FALSE on every boot, and the
  // post-run integrity check throws on the first miss — turning a correct cleanup
  // into a cluster-wide boot failure. Moving the probe FIRST, in the release that
  // stops the writes, is what makes 130 a safe, ordinary migration later.
  //
  // ⚠️ AND NOT THE OTHER INDEX. `approvals_approver_pending_idx` is keyed on
  // `approver_user_id`, a column `routes/execution-approvals.ts` records as having
  // ZERO readers in backend/src and which B10a is queued to remove. Probing it
  // would reproduce this exact problem one migration later, which is the whole
  // defect this comment is about. `approvals_undelivered_idx` is on `expires_at`
  // WHERE `status='pending' AND notified_at IS NULL` — the escalation sweep's live
  // predicate, both columns load-bearing, neither queued for removal.
  //
  // ⛔ THIS PROBE IS STILL CONDITIONAL ON AN OMISSION, exactly as the 104 entry
  // above warns about its own CHECK: it is honest only because nobody has declared
  // the index in schema.ts. Declare it there for push/migrate parity and this probe
  // SILENTLY GOES VACUOUS and 101 is stamped applied without running. If that ever
  // happens, do not "fix" it by re-pointing at another schema-declared object —
  // give 101 a `_migration_effects` receipt row the way 113 has, which is the only
  // witness class `drizzle-kit push` cannot produce at all.
  // Pinned by tests/unit/routes/triage-column-retirement.test.ts.
  {
    migration: '101_approval_triage.sql',
    check: (sql) => indexExists(sql, 'approvals_undelivered_idx'),
  },

  // 102 — router_dedupe.tenant_id → planka_scope_id. Same reason 082 needs a
  // probe, one step further: `router_dedupe` is raw-SQL only (not in the drizzle
  // schema), so on a `drizzle-kit push`-bootstrapped CI database the backfill
  // would stamp 102 applied against a table that still carries the OLD column
  // name. The handler's INSERT names `planka_scope_id`, so every
  // `handleN8nRouterDedupe` test would fail — or, worse, the suite's
  // `SELECT 1 FROM router_dedupe` reachability guard would still pass and the
  // failures would read as an unrelated column error. Probe the COLUMN the
  // rename introduces (not the table — `tableExists` would pass vacuously on a
  // DB that only ever ran 082).
  {
    migration: '102_router_dedupe_planka_scope_id.sql',
    check: (sql) => columnExists(sql, 'router_dedupe', 'planka_scope_id'),
  },

  // 103 — the last ten `tenant_id` columns text -> uuid. Two things make this
  // probe an unusual shape, and BOTH are load-bearing.
  //
  //   1. It checks TYPE, not existence. Every one of the ten columns already
  //      EXISTS on any DB that ran the earlier migrations, so `columnExists`
  //      would pass VACUOUSLY on a DB whose columns are still `text` and the
  //      backfill would stamp 103 applied over an unconverted schema. A
  //      `kaizen_candidates.tenant_id` left as `text` is precisely how the
  //      string `platform_incident_commander` got persisted as a tenant (see
  //      scripts/check-tenant-field-misuse.ts).
  //
  //   2. It checks ALL of them, not one representative. ⚠️ MEASURED, NOT
  //      HYPOTHETICAL: this probe first named `analytics_rollups` alone, on the
  //      reasoning that 103 converts all ten in one loop. That was wrong, and a
  //      fresh CI-shaped bootstrap proved it — `card_phase_lease` is raw-SQL
  //      only (not in src/db/schema.ts, like `router_dedupe`), so on a
  //      `drizzle-kit push`-bootstrapped DB `analytics_rollups` arrives ALREADY
  //      uuid from the schema while `card_phase_lease` does not exist yet at
  //      backfill time and is created as `text` by migration 100 later in the
  //      same run. The representative probe passed, 103 was stamped applied,
  //      and `card_phase_lease.tenant_id` shipped as `text` — 21 of 22 columns
  //      converted, silently.
  //
  // So the probe is a CONJUNCTION, and the second half is the part that is easy
  // to get wrong:
  //   (a) none of 103's ten target tables still has a `text` tenant_id, AND
  //   (b) `card_phase_lease` exists at all.
  //
  // (b) looks redundant — probe 100 above already requires that table — but it
  // is what makes 103 ORDER-SAFE, and its absence was measured, not imagined.
  // `card_phase_lease` is raw-SQL only (not in src/db/schema.ts, like
  // `router_dedupe`), so on a `drizzle-kit push`-bootstrapped CI database it
  // does not exist at backfill time while every OTHER target arrives already
  // `uuid` from the schema. With (a) alone the probe passed at backfill —
  // nothing was `text` because the only straggler did not exist yet — 103 was
  // stamped applied, migration 100 then created the table as `text` later in
  // the same run, and the post-run integrity check blew up with the whole
  // transaction rolled back. 21 of 22 columns converted; CI red for a reason
  // that reads like an unrelated schema fault. With (b), the probe fails at
  // backfill, 103 stays PENDING, and the apply loop runs it in numeric order —
  // after 100 — which converts the table.
  {
    migration: '103_tenant_id_text_to_uuid.sql',
    check: async (sql) => {
      const [row] = await sql<{ text_targets: string }[]>`
        SELECT count(*)::text AS text_targets
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'tenant_id'
          AND data_type = 'text'
          AND table_name IN (
            'analytics_rollups', 'budget_alert_receipts', 'campaign_jobs',
            'card_phase_lease', 'kaizen_candidates', 'notifications',
            'scheduled_reports', 'scheduled_trigger_runs',
            'scheduled_triggers', 'suggested_schedules'
          )
      `;
      if (row?.text_targets !== '0') return false;
      return tableExists(sql, 'card_phase_lease');
    },
  },

  // 111 recreates the two partial unique indexes that 030 already created —
  // UNDER THE SAME TWO NAMES. So `indexExists` is VACUOUS here: it is true
  // under the broken shape and the fixed one alike, and a probe that cannot
  // tell them apart would stamp 111 applied on a database that still has the
  // tenant-blind index. The probe therefore reads the index DEFINITION and
  // requires `workspace_id` to be the LEADING key column, which is exactly
  // what 111 changes and what the migration header states it relies on.
  {
    migration: '111_asset_assignments_tenant_scoped_uniqueness.sql',
    check: async (sql) => {
      const rows = await sql<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'asset_assignments'
          AND indexname IN (
            'asset_assignments_uq_workspace',
            'asset_assignments_uq_with_target'
          )
          AND indexdef LIKE '%(workspace_id,%'
      `;
      return rows.length === 2;
    },
  },

  // 113 tells n8n's 2xx TRANSPORT ACK apart from the EFFECT (the Planka card
  // actually leaving BLOCKED). It carries DML — a backfill copying every
  // existing `callback_delivered_at` into the new `callback_acked_at`, because
  // that is precisely what those values have always measured. Probing a COLUMN
  // would be useless: push creates the columns from schema.ts, so a column probe
  // is TRUE on a fresh CI DB and the file gets stamped applied with the backfill
  // never run.
  //
  // ⛔ AND IT IS NOT PROBED ON ITS CHECK CONSTRAINT EITHER. ⚠️ CORRECTED
  // 2026-09-06 — it was, on the stated grounds that "drizzle has no CHECK
  // primitive and push emits none (measured for 104)". THAT PREMISE IS FALSE.
  // `check` is imported at src/db/schema.ts:18 and used 25 times, and a scratch
  // `drizzle-kit push` against an empty postgres:18 emitted four CHECK
  // constraints (andon_state_id_check, streams_kind_tenant_check,
  // streams_notification_channels_check, suggested_schedules_status_check).
  // `approvals_callback_resolution_check` was absent from a push-built DB for
  // ONE reason: nobody had declared it in schema.ts. schema.ts and
  // db-invariants.integration.test.ts instruct the next author to do exactly
  // that for CI/prod parity — and the moment they did, this probe would have
  // gone permanently TRUE and 113 would have been stamped-not-run, in silence.
  // (It is declared there now, so that failure mode is not hypothetical: this
  // probe would be vacuous TODAY.)
  //
  // The probe therefore reads something `drizzle-kit push` can NEVER emit: the
  // RECEIPT the backfill writes for itself. push builds a schema; it has no
  // mechanism that inserts a row. The receipt is written by the same
  // data-modifying CTE as the UPDATE, so it cannot exist unless the backfill
  // ran, and it stays true forever once written.
  //
  // ⚠️ The probe asks whether the statement RAN, not how many rows it touched.
  // On a fresh DB the backfill correctly updates zero rows, so a row-count probe
  // would be FALSE after a legitimate apply and would hard-fail every boot.
  //
  // ⭐ AND IT IS THE ONE MIGRATION MARKED `reapplyIfProbeFails`. 113 shipped an
  // earlier draft (a three-value CHECK list, no receipt table), so a database
  // that applied that draft is stamped applied, cannot re-run the file, and
  // therefore can never reach the definition-comparing DO block that would fix
  // its constraint — while this probe fails and hard-errors every boot.
  //
  // ⚠️ RE-RUN SAFETY CHECKED STATEMENT BY STATEMENT, not by analogy:
  //   * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — six of them, all guarded.
  //   * the CHECK constraint's `DO $$` block compares `pg_get_constraintdef`
  //     and only drops when the definition is the stale one.
  //   * `CREATE TABLE IF NOT EXISTS _migration_effects`.
  //   * the backfill CTE is `WHERE callback_delivered_at IS NOT NULL AND
  //     callback_acked_at IS NULL`, so it never overwrites a value the new code
  //     has written, and its receipt INSERT is `ON CONFLICT DO NOTHING`, which
  //     preserves the ORIGINAL row count rather than replacing it with a re-run's
  //     zero.
  //   * `CREATE INDEX IF NOT EXISTS` / `DROP INDEX IF EXISTS`.
  // There is no unconditional INSERT, DELETE or destructive ALTER in the file.
  {
    migration: '113_approval_callback_effect_marker.sql',
    reapplyIfProbeFails: true,
    check: (sql) =>
      migrationEffectRecorded(sql, '113_approval_callback_effect_marker.sql'),
  },

  // 114 VOIDS ROWS AND CREATES A UNIQUE INDEX, so it is DML and needs a probe.
  //
  // ⛔ The obvious probe -- "no card holds two pending gates" -- is WRONG here, and
  // wrong in the direction that silently skips the migration. On a fresh
  // push-shaped database `approvals` is EMPTY, so that condition is vacuously
  // TRUE, 114 would be stamped applied without running, and the unique index --
  // the entire point of the file -- would never exist. The arbiter would then be
  // missing and every mint would raise 42P10.
  //
  // The effect marker has neither failure mode: `drizzle-kit push` can create a
  // table but cannot insert a row into one, and the row is written by the same
  // statement that performs the void.
  {
    migration: '114_approvals_one_open_gate_per_card.sql',
    reapplyIfProbeFails: true,
    check: (sql) =>
      migrationEffectRecorded(sql, '114_approvals_one_open_gate_per_card.sql'),
  },

  // 117 REVERSES 107's DATA EFFECT AGAINST A DEADLINE, so "stamped applied,
  // never ran" is not a cosmetic failure here — it is 191 pending approvals
  // expiring on 2026-09-10 into a state `handleUpdateApproval` 422s forever,
  // while `_migrations` says the reversal shipped and CI is green.
  //
  // 107 itself is deliberately UNPROBED and its header explains why: the
  // obvious probe ("no stamped pending row carries a deadline") is re-evaluated
  // on EVERY boot, so one future such row would hard-error the backend at
  // startup. That reasoning is right, and this entry does not repeat the
  // mistake — the receipt probe asks only whether the statement RAN, which is
  // true forever once true, and `drizzle-kit push` cannot INSERT A ROW.
  //
  // `reapplyIfProbeFails` is set, and 117's header carries the statement-by-
  // statement idempotence argument the flag requires (the UPDATE has
  // `AND expires_at IS NOT NULL`, so a second run matches zero rows; the receipt
  // INSERT is ON CONFLICT DO NOTHING; there is no schema change at all).
  //
  // ⭐ THE FLAG IS SAFE IN THE ONE DIRECTION THAT MATTERS. It can only fire when
  // the receipt is ABSENT, i.e. when the UPDATE has never run — so re-running is
  // always correct in exactly the case that triggers it. It can never re-fire
  // after a legitimate apply and clear deadlines that a deliberate future
  // re-application of the 107 policy had restored.
  {
    migration: '117_reverse_default_expiry_backfill.sql',
    reapplyIfProbeFails: true,
    check: (sql) =>
      migrationEffectRecorded(sql, '117_reverse_default_expiry_backfill.sql'),
  },

  // Add probes here whenever a future migration introduces a column/table
  // whose absence would cause silent test failures.
  {
    migration: '118_budget_topups_idempotency_key.sql',
    check: (sql) => columnExists(sql, 'budget_topups', 'idempotency_key'),
  },

  // 119 widens `approvals_callback_resolution_check` to admit the fifth terminal
  // value, `hold_acknowledged` — the receiver's own 200 body reporting that it is
  // holding the card on purpose (see workers/deblock-callback-redelivery.ts ::
  // classifyReceiverHold).
  //
  // ⚠️ A CONSTRAINT PROBE, WHICH THE 113 ENTRY ABOVE SPENDS A SCREEN REFUSING. The
  // refusal there is CORRECT AND IT DOES NOT APPLY HERE, and the difference is the
  // only thing worth reading in this comment: 113 carries DML — a backfill
  // `drizzle-kit push` cannot reproduce — so a probe that a push-built database
  // satisfies would stamp it applied with its backfill never run, losing an effect.
  // 119 carries NO DML AT ALL. Its entire effect IS the constraint definition, and
  // that definition is emitted by two independent paths on purpose: `check()` in
  // src/db/schema.ts on a push-built CI database, this file on a migrated one. So a
  // probe that reads TRUE on a push DB is not vacuous, it is the property being
  // asserted, satisfied by the other emitter.
  //
  // ⛔ IT READS THE DEFINITION, NOT THE NAME. `constraintExists` would be TRUE
  // against the stale FOUR-value constraint that this file exists to replace — the
  // exact shape that let 113 ship a three-value draft, report success, and then
  // reject every `send_exhausted` write at runtime. `reapplyIfProbeFails` is set
  // for that same reason: a database stamped applied under an older definition must
  // be able to reach the definition-comparing DO block again, and the file is
  // idempotent statement by statement (see its header — no INSERT, no UPDATE, no
  // DELETE, no destructive ALTER).
  //
  // ⛔ IT RESOLVES THE TABLE BY NAME THROUGH pg_class, NOT WITH `::regclass`, AND
  // THAT IS NOT STYLE. `'approvals'::regclass` RAISES 42P01 when the table is
  // absent, and a probe is evaluated in two places where it can be — the
  // backfill loop, which asks every probe BEFORE the apply loop has created
  // anything, and `runIntegrityChecks` on the no-pending early return. Both run
  // inside the runner's OUTER TRANSACTION, so the raise does not read as "probe
  // false": it aborts the whole boot. Measured — the regclass form turned 5 of
  // this suite's scenarios red with `relation "approvals" does not exist`, from
  // the backfill path, on a fixture DB that has `projects` but not yet
  // `approvals`. `migrationEffectRecorded`'s docstring states the rule outright
  // ("the table-existence test comes first on purpose ... querying a missing
  // relation would abort it") and `constraintExists` is written this same way.
  // A missing table must make this return FALSE — which leaves 119 in `pending`
  // for the apply loop, exactly as its siblings do.
  {
    migration: '119_approval_callback_hold_acknowledged.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          JOIN pg_class     t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname  = 'public'
           AND t.relname  = 'approvals'
           AND c.conname  = 'approvals_callback_resolution_check'
      `;
      return rows.length === 1 && rows[0]!.def.includes('hold_acknowledged');
    },
  },
  // 120 adds the column the stream detector reads to mint a WORKABLE improvement
  // card (before it, the minter passed a TENANT id as project_id and 508 live
  // cards could never resolve a repository). Pure DDL, so unlike 113/117 there is
  // no data effect to receipt and the property is simply "the column is there" —
  // true in both environments for the right reason: a push-built CI database gets
  // it from schema.ts, a migrated database from the .sql file. Mirrors the 044
  // streams entry above.
  //
  // ⛔ EVERY ENTRY HERE NEEDS A MATCHING FIXTURE IN tests/unit/db/migration-runner.
  // test.ts :: SYNTHETIC_MIGRATIONS. There is NO per-probe opt-out and no guard
  // field: `runIntegrityChecks` iterates this WHOLE array unconditionally after
  // every apply, including the synthetic one, so a probe whose file is absent from
  // that fixture list reds all 13 tests in that suite rather than the one it
  // describes. Adding this probe without its fixture did exactly that — CI run
  // 34783097961 — as 117, 118 and 119 each warned in turn.
  //
  // ⚠️ APPEND NEW PROBES HERE, at the end. The array is not sorted (020, 025, 082
  // and 103 all sit out of numeric order for readability reasons of their own), but
  // 111 through 119 were each appended, and `runIntegrityChecks` throws on the
  // FIRST miss — so a newest-migration probe buried mid-array preempts the
  // diagnostic of the older, likelier-stale probes below it.
  {
    migration: '120_streams_project_id.sql',
    check: (sql) => columnExists(sql, 'streams', 'project_id'),
  },

  // 131 re-asserts the GLOBAL ANDON SINGLETON ROW that 065 inserts and a freshly
  // built database never gets: `drizzle-kit push` creates the table and cannot
  // INSERT a row, and the backfill then STAMPS 065 applied without executing its
  // INSERT (065 has no probe, and `check-migration-dml-probed` grandfathers it on
  // the premise that its data effect "landed in production long ago" — true of the
  // database that exists, false of a fresh one).
  //
  // ⛔ WHY IT IS NOT COSMETIC. `consultAndonForRouterDedupe` (routes/webhooks.ts)
  // is the one synchronous call every Planka card move makes and it is FAIL-CLOSED
  // by owner rule: only `engaged:false` + `reason:'released'` proceeds. An absent
  // singleton derives `uninitialised`, which refuses. A rebuilt prod/staging DB
  // therefore halts AA dispatch FLEET-WIDE from the first card move.
  //
  // THE PROBE IS A CONJUNCTION, and each half answers a failure the other cannot:
  //
  //   (a) the migration's own RECEIPT in `_migration_effects`. ⭐ Not just because
  //       push cannot insert a row — because CI's `ci-seed.ts` NOW INSERTS THIS
  //       VERY SINGLETON after push. So a row-presence-only probe would read TRUE
  //       at backfill time on every CI database, 131 would be stamped applied
  //       without running, and CI would never once execute the file. The receipt
  //       is the only witness neither push nor ci-seed can produce.
  //   (b) the singleton ROW being present. This is the half that survives a DATA
  //       WIPE: a TRUNCATE that leaves `_migrations` and `_migration_effects`
  //       standing makes (a) read TRUE forever over an empty `andon_state` — every
  //       ledger claiming the fix shipped while the brake halts the fleet.
  //
  // `tableExists` is checked BEFORE `andon_state` is queried, for the reason
  // `migrationEffectRecorded` documents: probes run inside the runner's
  // transaction, and querying a missing relation would abort it.
  //
  // ⭐ `reapplyIfProbeFails` IS WHAT MAKES (b) A REPAIR RATHER THAN A BOOT
  // FAILURE. Without it, a wiped singleton fails the post-run integrity check on
  // EVERY boot with no way out but hand-written SQL. With it the file is
  // un-stamped and re-run, which re-inserts the row. Re-run safety checked
  // statement by statement, not by analogy: a `DO` block that only RAISEs, a
  // `CREATE TABLE IF NOT EXISTS`, an INSERT behind `WHERE NOT EXISTS`, and an
  // `ON CONFLICT (migration) DO NOTHING`. No unconditional INSERT, no DELETE, no
  // destructive ALTER.
  //
  // ⛔ AND IT NEEDS ITS FIXTURE in tests/unit/db/migration-runner.test.ts ::
  // SYNTHETIC_MIGRATIONS, for the reason the 120 comment above states:
  // `runIntegrityChecks` iterates this WHOLE array after every apply, including
  // the synthetic one, so a probe whose file is absent from that list reds all 13
  // tests in that suite rather than the one it describes.
  {
    migration: '131_andon_singleton_reassert.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await migrationEffectRecorded(sql, '131_andon_singleton_reassert.sql'))) {
        return false;
      }
      if (!(await tableExists(sql, 'andon_state'))) return false;
      const [row] = await sql<{ present: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM andon_state WHERE id = 1) AS present
      `;
      return !!row?.present;
    },
  },

  // 133 makes `repositories.name` NOT NULL and non-blank. Registered for the
  // ONE case the backfill gets wrong: a database restored from an older dump
  // has `projects` and an EMPTY `_migrations`, so the backfill stamps every
  // file applied — including this one — against a schema whose `name` column is
  // still nullable, and the constraint silently never lands. The probe reads the
  // two facts the file asserts, so that database keeps 133 PENDING instead.
  //
  // `reapplyIfProbeFails` is safe here and was checked statement by statement:
  // 133 is DDL only (no INSERT / UPDATE / DELETE / TRUNCATE), and BOTH statements
  // sit inside a DO block guarded by an existence check, so a re-run is a no-op.
  {
    migration: '133_repositories_name_required.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await tableExists(sql, 'repositories'))) return false;
      const [row] = await sql<{ enforced: boolean }[]>`
        SELECT (
          EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'repositories'
               AND column_name = 'name'
               AND is_nullable = 'NO'
          )
          AND EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conname = 'repositories_name_not_blank'
               AND conrelid = 'public.repositories'::regclass
          )
        ) AS enforced
      `;
      return !!row?.enforced;
    },
  },

  // 134 (#1104) adds `approvals.callback_degraded_reads` /
  // `callback_degraded_first_at` and widens `approvals_callback_resolution_check`
  // to admit the SIXTH terminal value, `read_degraded` — a card whose list fr could
  // never establish, over DEGRADED_STRIKES ticks spanning DEGRADED_MIN_SPAN_MS,
  // each charged only on a tick that read OTHER cards successfully (see
  // workers/deblock-callback-redelivery.ts :: applyDegradedStrikes).
  //
  // ⚠️ A CONSTRAINT-AND-COLUMN PROBE, WHICH THE 113 ENTRY ABOVE SPENDS A SCREEN
  // REFUSING, AND THE REFUSAL STILL DOES NOT APPLY — for the reason spelled out on
  // the 119 entry: 113 carries DML a push cannot reproduce, so a probe a push-built
  // DB satisfies would stamp it applied with its backfill never run. 134 carries NO
  // DML AT ALL. Its entire effect is two columns and a constraint definition, each
  // emitted by two independent paths on purpose — `check()`/`integer()` in
  // src/db/schema.ts on a push-built CI database, this file on a migrated one — so
  // a probe reading TRUE on a push DB is not vacuous, it IS the property, satisfied
  // by the other emitter.
  //
  // ⛔ IT READS THE CONSTRAINT DEFINITION, NOT THE NAME, and it tests BOTH COLUMNS
  // as well. `constraintExists` would be TRUE against the stale FIVE-value
  // constraint this file exists to replace — the exact shape that let 113 ship a
  // three-value draft, report success, and then reject every write at runtime.
  // ⛔ AND THE COLUMN HALF IS NOT REDUNDANT WITH IT: a database that reached the
  // six-value constraint through schema.ts but somehow lacks the columns would
  // accept the resolution and then fail every strike write, which is the silent
  // half of the same failure.
  //
  // ⛔ IT RESOLVES THE TABLE THROUGH pg_class, NOT WITH `::regclass`, for the reason
  // the 119 entry records at length: `'approvals'::regclass` RAISES 42P01 when the
  // table is absent, inside the runner's OUTER TRANSACTION, which aborts boot
  // instead of reading as "probe false". `columnExists` is written that way already.
  {
    migration: '134_approval_callback_read_degraded.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await columnExists(sql, 'approvals', 'callback_degraded_reads'))) return false;
      if (!(await columnExists(sql, 'approvals', 'callback_degraded_first_at'))) return false;
      const rows = await sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          JOIN pg_class     t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname  = 'public'
           AND t.relname  = 'approvals'
           AND c.conname  = 'approvals_callback_resolution_check'
      `;
      return rows.length === 1 && rows[0]!.def.includes('read_degraded');
    },
  },
  // 135 — member_knowledge_areas, the per-member knowledge-area record the
  // member directory reads and the tenant-admin allocation routes write. Same
  // shape and same reason as 074's probe above: on a database whose
  // `_migrations` ledger is empty but whose `projects` table already exists
  // (exactly what CI's bootstrap produces), an unprobed migration is STAMPED
  // APPLIED WITHOUT RUNNING. Pure DDL, so `drizzle-kit push` does reproduce the
  // table from schema.ts — but that only holds while schema.ts and this file
  // agree.
  //
  // ⚠️ CORRECTED 2026-09-27 — this comment used to justify the probe by claiming
  // a missing table "makes GET /api/tenant/members 500 for every caller rather
  // than degrade". THAT IS FALSE: routes/tenant/members.ts:230-241 wraps the
  // areas read in try/catch and degrades to an empty map, deliberately, on the
  // same don't-blank-the-picker contract as the identity lookup beside it.
  //
  // ⭐ THE REAL JUSTIFICATION IS THE OPPOSITE ONE, AND IT IS STRONGER: because the
  // read degrades, a database MISSING this table is INDISTINGUISHABLE over the
  // API from the legitimate steady state. That route's own comment says it
  // outright — "a tenant full of members with no areas and a failed areas query
  // are indistinguishable in this response" — and the table is EMPTY on every
  // tenant today (measured 2026-09-27), so the *expected* response and the
  // *broken-schema* response are byte-identical. Nothing in the read path can
  // ever surface the defect.
  //
  // What would surface it is the WRITE path — PUT /api/workspace/members/:userId/
  // knowledge-areas has no such catch, so it raises 42P01 and escapes as a 500 —
  // i.e. the first person to learn the schema is broken is an admin whose save
  // failed, attributed to their action, long after boot. This probe is what turns
  // a silent, expected-looking read and a stray admin-facing 500 into a LOUD
  // refusal to boot at the moment the schema is wrong.
  {
    migration: '135_member_knowledge_areas.sql',
    check: (sql) => tableExists(sql, 'member_knowledge_areas'),
  },

  // 137 renames the asset-assignment scope: type `scope_level` ->
  // `assignment_scope`, column `asset_assignments.scope_level` -> `scope_kind`.
  // Registered for the dump-restore case 133 describes: `projects` present,
  // `_migrations` empty, OLD names in the schema — unprobed, the backfill would
  // stamp 137 applied over the old names and every asset-assignment query would
  // then fail 42703 at runtime rather than at boot.
  //
  // ⭐ THE PROBE REQUIRES THE NEW COLUMN, NOT MERELY THE ABSENCE OF THE OLD
  // NAMES. "Old names absent" reads TRUE on a database whose asset_assignments
  // table does not exist YET — the backfill evaluates every probe BEFORE any
  // earlier pending file has run — so 137 would be stamped, and then an earlier
  // pending file (030 on a real history, 111 in the runner's synthetic one)
  // would create the table under the OLD column name, leaving a stamped 137
  // that never ran. Requiring `scope_kind` keeps 137 pending in that state, so
  // it runs AFTER whatever creates the table. A push-built CI database reads
  // TRUE — schema.ts emits the new names — the property satisfied by the other
  // emitter, as for 134.
  //
  // `reapplyIfProbeFails` is safe: 137 is DDL only, both renames sit inside a DO
  // block guarded on the old name existing and the new one not, so a re-run is
  // a no-op.
  {
    migration: '137_rename_assignment_scope.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await columnExists(sql, 'asset_assignments', 'scope_kind'))) return false;
      if (await columnExists(sql, 'asset_assignments', 'scope_level')) return false;
      const [row] = await sql<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typname = 'scope_level'
        ) AS present
      `;
      return !row?.present;
    },
  },

  // 138 — `wip_slot`, the conveyor's WIP-slot ledger (its route, POST
  // /api/webhooks/n8n/wip-slot, is RETIRED 2026-10-13; the table and its data
  // stay until a follow-up drop migration). Deliberately NOT in schema.ts (the same choice
  // as 100's `card_phase_lease`), so `drizzle-kit push` never creates it: on
  // CI's push-built database, and on any database whose `_migrations` ledger is
  // empty but whose `projects` table exists, an UNPROBED 138 would be stamped
  // applied without running and every claim would 500 with 42P01. The claim
  // degrades CLOSED, so that 500 would stop the conveyor's READY→DOING pull
  // entirely — this probe turns it into a refusal to boot instead.
  //
  // `tableExists` alone is sufficient: 138 is one CREATE TABLE plus three
  // CREATE INDEX IF NOT EXISTS with no other emitter, so the table cannot exist
  // without this file having run. `reapplyIfProbeFails` is safe (pure DDL,
  // every statement IF NOT EXISTS).
  {
    migration: '138_wip_slot.sql',
    reapplyIfProbeFails: true,
    check: (sql) => tableExists(sql, 'wip_slot'),
  },

  // 140 — `card_version_stamps`, the full version stamp behind a card's
  // `Metadata.version_stamp` pointer (POST /api/cards/project writes it, GET
  // /api/cards/:id reads it). NOT in schema.ts, same choice as 138, so an
  // UNPROBED 140 would be stamped applied without running on a push-built or
  // empty-ledger database, and every stamped create would then 42P01 — which
  // rolls the card back, so the conveyor could not mint a stamped card at all.
  // This probe turns that into a refusal to boot.
  //
  // `tableExists` alone is sufficient: 140 is one CREATE TABLE plus one CREATE
  // INDEX IF NOT EXISTS with no other emitter. `reapplyIfProbeFails` is safe
  // (pure DDL, every statement IF NOT EXISTS, COMMENT is idempotent).
  {
    migration: '140_card_version_stamps.sql',
    reapplyIfProbeFails: true,
    check: (sql) => tableExists(sql, 'card_version_stamps'),
  },

  // 141 — `card_asset_binding`, the unique-partial-index arbiter that was behind
  // POST /api/assets/:assetKind/:assetId/improvement-card (route removed with the
  // retired improvement-loop detector; the table stays). NOT in schema.ts, the same
  // choice as 138 and 140, and here the reason is sharper than "keep one
  // emitter": `drizzle-kit push` builds a table from the schema declaration,
  // which cannot express the PARTIAL index this file's guarantee IS. A pushed
  // table would carry the columns and not the constraint, so CI would run the
  // concurrency proof against a table that can exclude nothing and it would PASS
  // while prod diverged. Left out of schema.ts, this probe keeps 141 PENDING on a
  // push-built or empty-ledger database and the runner creates the table from
  // THIS file — one emitter, one index definition.
  //
  // `tableExists` alone is sufficient: 141 is one CREATE TABLE plus one CREATE
  // UNIQUE INDEX IF NOT EXISTS with no other emitter, so the table cannot exist
  // without this file having run. `reapplyIfProbeFails` is safe (pure DDL, every
  // statement IF NOT EXISTS, no DML).
  {
    migration: '141_card_asset_binding.sql',
    reapplyIfProbeFails: true,
    check: (sql) => tableExists(sql, 'card_asset_binding'),
  },

  // 142 — the destructive-statement guard (fr#1283): a BEFORE TRUNCATE and an
  // AFTER DELETE ... REFERENCING OLD TABLE statement trigger, both ENABLE
  // ALWAYS, on every protected table.
  //
  // ⛔ THIS PROBE IS NOT OPTIONAL. 142 emits only FUNCTIONs and TRIGGERs, and
  // `drizzle-kit push` emits NEITHER. Unprobed, the backfill stamps it applied
  // WITHOUT RUNNING IT on CI's push-built database, so the guard would exist in
  // production and NOWHERE ELSE — and the first place a false refusal (a
  // CASCADE fan-out, say) would surface is prod, which is the exact inversion
  // of what a guard is for.
  //
  // Probed on `projects` because it is the one table the backfill heuristic
  // itself assumes exists, and on `tgenabled = 'A'` (ALWAYS) rather than mere
  // presence: a trigger left at the default 'O' is skipped on a replica or
  // during a logical-replication apply, which is precisely where an unattended
  // wipe is least likely to be noticed. `indexExists`-style presence-only
  // checks would be VACUOUS against that regression.
  //
  // `reapplyIfProbeFails` is safe: CREATE OR REPLACE for both functions,
  // CREATE OR REPLACE TRIGGER for every trigger, and the attach loop skips any
  // listed table this database has not got. MEASURED idempotent — applied twice
  // against a throwaway postgres:18, 128 triggers both times, all tgenabled='A'.
  {
    migration: '142_destructive_statement_guard.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ tgname: string }[]>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'projects'
           AND NOT t.tgisinternal
           AND t.tgenabled = 'A'
           AND t.tgname IN ('fr_guard_truncate_projects', 'fr_guard_bulk_delete_projects')
      `;
      return rows.length === 2;
    },
  },

  // 147 — `project_reports` bug_report artifact (U2): the partial UNIQUE
  // (tenant_id, content_hash) insert-once arbiter plus two CHECKs (H_r shape;
  // a bug_report needs tenant_id + content_hash + card_id). `content_hash` IS in
  // schema.ts, so a column probe would be satisfied by `drizzle-kit push` and be
  // VACUOUS; push emits neither this partial index nor these CHECKs (they are
  // deliberately absent from schema.ts, same choice as 141). Probing all three
  // keeps 147 PENDING on a push-built or empty-ledger database so the runner
  // creates them from THIS file. Absent the index, ON CONFLICT (tenant_id,
  // content_hash) WHERE content_hash IS NOT NULL has no arbiter and every
  // bug_report insert fails 42P10 — closed, but this turns it into a refusal to
  // boot. `reapplyIfProbeFails` is safe: pure DDL, ADD COLUMN IF NOT EXISTS,
  // pg_constraint-guarded ADD CONSTRAINT, CREATE UNIQUE INDEX IF NOT EXISTS.
  {
    migration: '147_project_reports_bug_report.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await indexExists(sql, 'project_reports_tenant_content_hash_uniq')) &&
      (await constraintExists(sql, 'project_reports', 'project_reports_content_hash_hex')) &&
      (await constraintExists(sql, 'project_reports', 'project_reports_bug_report_required')),
  },

  // 148 — U11 plan pinning: `card_plan_pins` (insert-once), `card_plan_events`
  // and `card_executed_activities` (append-only), each guarded by a row-level
  // BEFORE UPDATE OR DELETE trigger plus a BEFORE TRUNCATE trigger, all ENABLE
  // ALWAYS. NOT in schema.ts (the 138/140/141 choice), and `drizzle-kit push`
  // emits neither the tables nor the triggers.
  //
  // ⛔ Probed on the TRIGGERS, not the tables. A table-only probe would read
  // TRUE on a database where the tables exist but the immutability guard was
  // never attached (or was left at the default 'O' enable state, skipped on a
  // replica) — the guard is what makes these rows evidence, so its absence must
  // keep the file pending. Six triggers: 2 per table, all tgenabled = 'A'.
  //
  // `reapplyIfProbeFails` is safe: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR
  // REPLACE FUNCTION and CREATE OR REPLACE TRIGGER; no DML.
  {
    migration: '148_card_plan_pinning.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ tgname: string }[]>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname IN ('card_plan_pins', 'card_plan_events', 'card_executed_activities')
           AND NOT t.tgisinternal
           AND t.tgenabled = 'A'
           AND (t.tgname LIKE 'fr_immutable_%' OR t.tgname LIKE 'fr_guard_truncate_%')
      `;
      if (rows.length !== 6) return false;
      // The server-stamped clock conformance governs by, and the AA-TRACE join
      // key; a DB that applied an earlier draft of 148 has the triggers but not
      // these columns.
      return (
        (await columnExists(sql, 'card_plan_events', 'recorded_at')) &&
        (await columnExists(sql, 'card_executed_activities', 'recorded_at')) &&
        (await columnExists(sql, 'card_plan_events', 'trace_id')) &&
        (await columnExists(sql, 'card_executed_activities', 'trace_id'))
      );
    },
  },

  // 149 — `project_reports.trace_id` (AA-TRACE join key on the U2 report row).
  // The column IS in schema.ts, so a column probe would be satisfied by
  // `drizzle-kit push` and be VACUOUS; push emits neither the UUIDv7 CHECK nor
  // the partial index. Probing both keeps 149 PENDING on a push-built database.
  // `reapplyIfProbeFails` is safe: ADD COLUMN IF NOT EXISTS, pg_constraint-
  // guarded ADD CONSTRAINT, CREATE INDEX IF NOT EXISTS.
  {
    migration: '149_project_reports_trace_id.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await indexExists(sql, 'project_reports_trace_id_idx')) &&
      (await constraintExists(sql, 'project_reports', 'project_reports_trace_id_v7')),
  },

  // 153 — U3: the `qa.coverage_signoff` approval_kind label, `approval_decisions.
  // item_decisions` + its shape CHECK, and the redelivery sweep's partial index
  // `approvals_ac_coverage_sweep_idx`, and the partial UNIQUE index
  // `approvals_one_bug_fix_authorization_per_bug_card_idx`. Checks ONLY what 153 itself creates: the two sent
  // U3 kinds are fr#1333's 152 and are probed (if at all) there. Like 086, drizzle-kit
  // push creates an enum label on a FRESH type (it is in schema.ts) but never adds it to an
  // EXISTING one, and it builds the column but neither the CHECK nor the index — so the
  // probe keys on all three, which keeps 153 PENDING on a push-built or pre-153 database.
  // Without the label every coverage mint INSERT 500s.
  // `reapplyIfProbeFails` is safe: ADD VALUE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
  // pg_constraint-guarded ADD CONSTRAINT, CREATE INDEX IF NOT EXISTS; no DML.
  {
    migration: '153_u3_approval_kinds.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum
         WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'approval_kind')
           AND enumlabel = 'qa.coverage_signoff'
      `;
      return (
        rows.length === 1 &&
        (await constraintExists(sql, 'approval_decisions', 'approval_decisions_item_decisions_shape')) &&
        (await indexExists(sql, 'approvals_ac_coverage_sweep_idx')) &&
        // The one-bug-fix-authorization-per-bug-card arbiter. Without it two concurrent
        // marked mints both succeed and the bug card can only ever carry one of them. Keyed
        // on the PREDICATE too: an earlier revision excluded only 'voided', and an expired
        // row holding the index strands the re-raise (409 or a dedupe onto the expired row).
        (await bugFixIndexExcludesExpired(sql))
      );
    },
  },

  // 151 — `project_deliverables.repos` (fr#1332). Declared in schema.ts too, so
  // a push-built database already has it; the probe covers an empty-ledger
  // database whose table predates the column, where an unprobed 151 would be
  // stamped applied and GET /api/projects/:id/deliverables + promote would then
  // 42703. `reapplyIfProbeFails` is safe: one ADD COLUMN IF NOT EXISTS + COMMENT.
  {
    migration: '151_project_deliverables_repos.sql',
    reapplyIfProbeFails: true,
    check: (sql) => columnExists(sql, 'project_deliverables', 'repos'),
  },

  // 154 — `card_scenario_evidence` (fr#1338): the bug-path repro evidence
  // (test_file_content) POST /api/cards/project keeps OUT of Planka. NOT in
  // schema.ts, same choice as 140, so an UNPROBED 154 would be stamped applied
  // on a push-built database and every repro mint would then 42P01 (rolling the
  // card back). Pure DDL, IF NOT EXISTS — `reapplyIfProbeFails` is safe.
  {
    migration: '154_card_scenario_evidence.sql',
    reapplyIfProbeFails: true,
    check: (sql) => tableExists(sql, 'card_scenario_evidence'),
  },

  // 155 — U3 G-12 A6: the `execution.question` approval_kind label. Same shape and the same
  // reason as 156 below: drizzle-kit push never adds a label to an EXISTING type, so the probe
  // keys on pg_enum and a pre-155 database keeps 155 PENDING. Without the label every A6 mint
  // INSERT 500s. `reapplyIfProbeFails` is safe: ADD VALUE IF NOT EXISTS only; no DML.
  {
    migration: '155_execution_question_kind.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum
         WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'approval_kind')
           AND enumlabel = 'execution.question'
      `;
      return rows.length === 1;
    },
  },

  // 156 — U4: the `execution.landing_signoff` approval_kind label (G-12 A5). Like 086/153,
  // drizzle-kit push creates the label on a FRESH type (it is in schema.ts) but never adds it
  // to an EXISTING one, so the probe keys on pg_enum and keeps 156 PENDING on a pre-156
  // database. Without the label every A5 mint INSERT 500s. `reapplyIfProbeFails` is safe:
  // ADD VALUE IF NOT EXISTS only; no DML.
  {
    migration: '156_landing_signoff_kind.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum
         WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'approval_kind')
           AND enumlabel = 'execution.landing_signoff'
      `;
      return rows.length === 1;
    },
  },

  // 157 — the UNIQUE (approval_id, approver_id) index on `approval_decisions`: the
  // exactly-once arbiter for a DECISION (one approver, one decision per approval). It is
  // declared in schema.ts, so drizzle-kit push builds it too; the probe keys on the index
  // so a database missing it keeps 157 PENDING rather than stamped.
  // `reapplyIfProbeFails` is safe: CREATE UNIQUE INDEX IF NOT EXISTS only, no DML. (A
  // database carrying duplicate decisions fails the UNIQUE build on purpose —
  // deduplicating decisions is a human call. Prod measured 0, 2026-10-02.)
  {
    migration: '157_approval_decisions_unique_approver.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => indexExists(sql, 'approval_decisions_approval_approver_unique'),
  },

  // 159 — widens `approvals_callback_resolution_check` with the two signoff refusals
  // (`card_left_blocked_since_approval`, `card_tenant_not_platform`). Same shape and
  // same reasoning as the 134 entry: NO DML, the constraint has two emitters
  // (schema.ts on push, this file on migrate), so the probe reads the DEFINITION —
  // never the name, which a stale six-value constraint would satisfy. pg_class, not
  // `::regclass`, for the 119 reason. `reapplyIfProbeFails` is safe: idempotent DDL.
  {
    migration: '159_approval_callback_signoff_refusals.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
          JOIN pg_class     t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname  = 'public'
           AND t.relname  = 'approvals'
           AND c.conname  = 'approvals_callback_resolution_check'
      `;
      return (
        rows.length === 1 &&
        rows[0]!.def.includes('card_left_blocked_since_approval') &&
        rows[0]!.def.includes('card_tenant_not_platform')
      );
    },
  },

  // 162 — `card_computed_checks` + `card_done_overrides` (liveness-DONE design, ncn#2087):
  // the computed-pass store the DONE-move guard reads and the break-glass audit. NOT in
  // schema.ts (same choice as 154), so the probe keeps 162 PENDING on a push-built database;
  // it keys on BOTH append-only triggers, the part a hand-built table would miss. Pure DDL,
  // IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS — `reapplyIfProbeFails` is safe.
  {
    migration: '162_card_computed_checks.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_trigger
         WHERE NOT tgisinternal
           AND tgname IN ('card_computed_checks_append_only', 'card_done_overrides_append_only')
      `;
      return rows[0]?.n === 2;
    },
  },

  // 163 — `projects_one_live_bug_hunt_per_repo_idx`: one live bug_hunt `it` project per
  // (tenant, repo), the race backstop for routes/projects.ts assertNoLiveBugHuntProject.
  // Also declared in schema.ts (push lands it); the probe keeps 163 PENDING on any
  // database that lacks it. Pure DDL, CREATE UNIQUE INDEX IF NOT EXISTS, no DML —
  // `reapplyIfProbeFails` is safe.
  {
    migration: '163_bug_hunt_one_live_per_repo.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => indexExists(sql, 'projects_one_live_bug_hunt_per_repo_idx'),
  },

  // 164 — the same index, recreated with the pre-approval statuses excluded.
  // Probes the PREDICATE, not the name (163 already guarantees the name): a
  // database still carrying 163's `status <> 'archived'` predicate reads FALSE
  // and 164 re-applies. DROP + CREATE, pure DDL — `reapplyIfProbeFails` is safe.
  {
    migration: '164_bug_hunt_index_excludes_pre_approval.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const [row] = await sql<{ def: string | null }[]>`
        SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'projects_one_live_bug_hunt_per_repo_idx'
      `;
      return !!row?.def && row.def.includes("'pending'") && row.def.includes("'cancelled'");
    },
  },

  // 165 + 166 (the project_phase / project_type vocabulary CHECKs) are
  // deliberately NOT probed any more: migration 185 DROPS both (design: fr
  // consumes RM vocabulary — the vocabularies are per tenant, in RM). A presence
  // probe would read FALSE on every boot after 185 and, with
  // reapplyIfProbeFails, re-create the very constraints 185 dropped. 185's own
  // probe (below) asserts their ABSENCE.
  //
  // 167-171 — the rest of the project-start DDL (U-PS-*). ALL ARE ALSO IN
  // schema.ts, so a push-built database already satisfies every probe below and the
  // backfill stamps them applied, exactly as before. What the probes add is the
  // other direction: a database whose tables predate them (an empty-ledger
  // restore, a stale re-used CI DB) keeps the file PENDING instead of being stamped
  // over a missing CHECK/column — and a missing column here is a 42703 on every
  // promote / deliverables read / request read, not a cosmetic gap. Every file is
  // pure DDL: ADD COLUMN IF NOT EXISTS, pg_constraint-guarded ADD CONSTRAINT,
  // COMMENT ON — no DML — so `reapplyIfProbeFails` is safe on all of them.
  // Exercised end-to-end (FALSE after the state is dropped, TRUE after the file runs)
  // by tests/integration/migrations/165-170-project-start-ddl.integration.test.ts.
  {
    migration: '167_project_outline_phase_plan.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'project_outlines', 'phase_plan')) &&
      (await columnExists(sql, 'project_outlines', 'phase_plan_hash')) &&
      (await constraintExists(sql, 'project_outlines', 'project_outlines_phase_plan_pair_check')) &&
      (await constraintExists(sql, 'project_outlines', 'project_outlines_phase_plan_hash_hex')),
  },
  {
    migration: '168_project_template.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'projects', 'template_id')) &&
      (await columnExists(sql, 'projects', 'template_hash')) &&
      (await constraintExists(sql, 'projects', 'projects_template_pair_check')),
  },
  {
    migration: '169_project_deliverables_minting.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'project_deliverables', 'deferred')) &&
      (await columnExists(sql, 'project_deliverables', 'minter')) &&
      (await columnExists(sql, 'project_deliverables', 'minted_at')) &&
      (await columnExists(sql, 'project_deliverables', 'minted_count')) &&
      (await constraintExists(sql, 'project_deliverables', 'project_deliverables_minting_check')),
  },
  {
    migration: '170_project_request_bits.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'project_requests', 'request_bits')) &&
      (await constraintExists(sql, 'project_requests', 'project_requests_request_bits_object_check')),
  },
  {
    migration: '171_project_deliverables_plan_id.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'project_deliverables', 'plan_deliverable_id')) &&
      (await constraintExists(sql, 'project_deliverables', 'project_deliverables_plan_deliverable_id_check')) &&
      (await constraintExists(sql, 'project_deliverables', 'project_deliverables_project_plan_deliverable_unique')),
  },

  // 172 — `card_phase_lease_waiter`, the FIFO waiter queue behind a lease key
  // (ncn#2156). Raw-SQL only like 100's `card_phase_lease` and 138's `wip_slot`,
  // so `drizzle-kit push` never creates it: unprobed, the backfill would stamp
  // 172 applied on a push-built database and every claim carrying `waiter` (and
  // every release, which peeks the queue) would 500 with 42P01. Probes the
  // table AND its `board_id` column (the last column the file adds, via ADD
  // COLUMN IF NOT EXISTS too); no other emitter. `reapplyIfProbeFails` is safe (pure idempotent DDL).
  {
    migration: '172_card_phase_lease_waiter.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await tableExists(sql, 'card_phase_lease_waiter')) &&
      (await columnExists(sql, 'card_phase_lease_waiter', 'board_id')),
  },

  // 173 — `projects.status = 'delivered'` (hunt project DELIVERED). Both columns, the
  // pair CHECK, AND the bug-hunt index PREDICATE (the 164 shape: probe the definition,
  // not the name — a database still carrying 164's predicate reads FALSE, re-applies,
  // and a delivered hunt stops occupying its repo's slot). All four are also in
  // schema.ts, so a push-built database satisfies the probe. Pure idempotent DDL
  // (ADD COLUMN IF NOT EXISTS, pg_constraint-guarded ADD, DROP IF EXISTS + CREATE) —
  // `reapplyIfProbeFails` is safe. 164's own probe ('pending' + 'cancelled') still
  // reads TRUE on 173's definition, so the two never fight.
  {
    migration: '173_project_delivered.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await columnExists(sql, 'projects', 'delivered_at'))) return false;
      if (!(await columnExists(sql, 'projects', 'delivery_evidence'))) return false;
      if (!(await constraintExists(sql, 'projects', 'projects_delivery_pair_check'))) return false;
      const [row] = await sql<{ def: string | null }[]>`
        SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'projects_one_live_bug_hunt_per_repo_idx'
      `;
      return !!row?.def && row.def.includes("'delivered'");
    },
  },

  // 174 (`planka_user_api_keys`) is deliberately NOT probed: 175 drops that table
  // (George 2026-10-10 — fr acts in Planka as ONE configured account, per tenant,
  // not per user), so a "table exists" probe would fail the post-run integrity
  // check on every boot after 175 — or, with reapplyIfProbeFails, re-create the
  // table 175 just dropped.
  //
  // 175 — drop `planka_user_api_keys`. The probe asserts ABSENCE, so a fresh /
  // push-built database (which never had the raw-SQL table) passes and is
  // stamped, and any database still carrying it re-runs the file. Pure
  // idempotent DDL (DROP TABLE IF EXISTS) — `reapplyIfProbeFails` is safe.
  {
    migration: '175_drop_planka_user_api_keys.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => !(await tableExists(sql, 'planka_user_api_keys')),
  },

  // 185 — drop the project_phase / project_type vocabulary CHECKs (165, 166).
  // The probe asserts ABSENCE of both, so a push-built database (schema.ts no
  // longer declares them) passes and is stamped, and any database still
  // carrying either re-runs the file. Pure idempotent DDL (DROP CONSTRAINT IF
  // EXISTS) — `reapplyIfProbeFails` is safe.
  {
    migration: '185_drop_project_vocabulary_checks.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      !(await constraintExists(sql, 'projects', 'projects_project_phase_check')) &&
      !(await constraintExists(sql, 'projects', 'projects_project_type_check')),
  },

  // 186 — approval re-delivery attempt counter + backoff. Both columns are in
  // schema.ts, so a push-built database satisfies the probe. Pure idempotent DDL
  // (ADD COLUMN IF NOT EXISTS) — `reapplyIfProbeFails` is safe.
  {
    migration: '186_approval_redelivery_backoff.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'approvals', 'redelivery_attempts')) &&
      (await columnExists(sql, 'approvals', 'next_redelivery_at')),
  },

  // 187 — drop the member_knowledge_areas area CHECK (135): knowledge areas are
  // the tenant's RM capabilities now (design Q1 = a). Probe asserts ABSENCE, so a
  // push-built database (schema.ts no longer declares it) is stamped and any
  // database still carrying it re-runs the file. Idempotent DDL.
  {
    migration: '187_drop_member_knowledge_area_check.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      !(await constraintExists(sql, 'member_knowledge_areas', 'member_knowledge_areas_area_check')),
  },

  // 188 — priority_change_events gains the RM priority-level id columns and
  // loses 160's to_priority vocabulary CHECK (design Q3 = b). Both columns are
  // in schema.ts and the CHECK is not, so a push-built database passes. Pure
  // idempotent DDL — `reapplyIfProbeFails` is safe.
  {
    migration: '188_priority_level_ids.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'priority_change_events', 'from_priority_level_id')) &&
      (await columnExists(sql, 'priority_change_events', 'to_priority_level_id')) &&
      !(await constraintExists(sql, 'priority_change_events', 'priority_change_events_to_check')),
  },

  // 189 — the bug-hunt index widened to RM's `bug_hunt_fix` (+ legacy `it`). Probes
  // the PREDICATE (the 164/173 shape): a database still carrying 173's
  // `project_type = 'it'` definition reads FALSE and 189 re-applies. 164's probe
  // ('pending' + 'cancelled') and 173's ('delivered') still read TRUE on 189's
  // definition, so none of them fight. Also in schema.ts. DROP IF EXISTS + CREATE,
  // pure DDL — `reapplyIfProbeFails` is safe.
  {
    migration: '189_bug_hunt_index_covers_bug_hunt_fix.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const [row] = await sql<{ def: string | null }[]>`
        SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'projects_one_live_bug_hunt_per_repo_idx'
      `;
      return (
        !!row?.def &&
        row.def.includes("'bug_hunt_fix'") &&
        row.def.includes("'it'") &&
        row.def.includes("'delivered'")
      );
    },
  },

  // 190 — projects.repository_url becomes optional (George 2026-10-13) and the
  // bug-hunt index gains `repository_url IS NOT NULL`. Probes BOTH facts the file
  // asserts: the column is nullable AND the index predicate names the IS NOT NULL
  // clause (189's definition lacks it ⇒ FALSE ⇒ 190 re-applies). 189's probe
  // ('bug_hunt_fix' + 'it' + 'delivered') still reads TRUE on 190's definition, so
  // they do not fight. Also in schema.ts. Pure idempotent DDL (DROP NOT NULL is a
  // no-op on a nullable column; DROP IF EXISTS + CREATE) — `reapplyIfProbeFails`
  // is safe.
  {
    migration: '190_project_repository_url_optional.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const [col] = await sql<{ nullable: string | null }[]>`
        SELECT is_nullable AS nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'repository_url'
      `;
      if (col?.nullable !== 'YES') return false;
      const [row] = await sql<{ def: string | null }[]>`
        SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'projects_one_live_bug_hunt_per_repo_idx'
      `;
      return !!row?.def && /repository_url IS NOT NULL/i.test(row.def) && row.def.includes("'bug_hunt_fix'");
    },
  },

  // 191 — D17: `approval_callback_urls`, the n8n Wait node's resume URL a licence
  // mint may carry (lib/approval-callback-url.ts) — a side table so the secret
  // never rides a full `approvals` row. 1:N (a dedupe ATTACHES its URL to the
  // surviving gate) with per-row delivery state — so the probe asserts the 1:N
  // shape, not just the table: the per-row `delivered_at` column AND the
  // (approval_id, md5(url)) unique index. A database that applied the file's first
  // 1:1 draft fails it and is reshaped by the re-apply (the file's guarded
  // ALTER/DO block). In schema.ts, so a push-built database satisfies the probe.
  // Pure idempotent DDL — `reapplyIfProbeFails` is safe.
  {
    migration: '191_approval_callback_url.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'approval_callback_urls', 'delivered_at')) &&
      (await indexExists(sql, 'approval_callback_urls_approval_url_key')),
  },

  // 192 — D13: `approvals.artifact_ref` (jsonb, nullable), the ONE artifact an
  // approval is about (lib/approval-artifact-ref.ts). In schema.ts, so a
  // push-built database satisfies the probe. Pure idempotent DDL (ADD COLUMN IF
  // NOT EXISTS) — `reapplyIfProbeFails` is safe.
  {
    migration: '192_approval_artifact_ref.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => await columnExists(sql, 'approvals', 'artifact_ref'),
  },

  // 193 — the v4 conveyor tenant's `workspaces` row (George 10-14): the
  // super_admin switcher offers a platform tenant only when its row exists. Pure
  // DML, so `drizzle-kit push` cannot create it — the probe asserts the ROW. The
  // file is a single INSERT ... ON CONFLICT (id) DO NOTHING — re-apply is safe.
  {
    migration: '193_v4_conveyor_workspace.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (
        await sql`SELECT 1 FROM workspaces WHERE id = '5f868d42-03f8-51f0-a93c-3e83070dc196'::uuid`
      ).length > 0,
  },

  // 194 — fr-agui SPEC §10.5 (P1c): `capability_audit`, the append-only trail of
  // agent proposals and the human confirmations that ran them
  // (services/capability-audit.ts). The probe asserts the project column AND the
  // proposal lookup index the confirmation path queries. In schema.ts, so a
  // push-built database satisfies it. Pure idempotent DDL — re-apply is safe.
  {
    migration: '194_capability_audit.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'capability_audit', 'project_id')) &&
      (await indexExists(sql, 'capability_audit_proposal_idx')),
  },

  // 195 — `agent_skill_pins` (skill_builder pins), DROPPED by 235 (skill_builder retired
  // 2026-11-04). Its table and triggers are gone for good, so an absent table satisfies the
  // probe: re-applying 195 after 235 would only resurrect the dropped table. A present
  // table must still carry 195's shape.
  {
    migration: '195_agent_skill_pins.sql',
    check: async (sql) =>
      !(await tableExists(sql, 'agent_skill_pins')) ||
      ((await columnExists(sql, 'agent_skill_pins', 'file_hashes')) &&
        (await indexExists(sql, 'agent_skill_pins_tenant_skill_key'))),
  },

  // 196 — fr-agui P2 / OQ-16: `project_asset_copy_intents`, the per-(project,
  // kind, original) claim + journal that makes `project_assets.edit`'s
  // copy-on-write idempotent and serialised (services/project-asset-copy-intents.ts).
  // In schema.ts, so a push-built database satisfies it. Pure idempotent DDL.
  {
    migration: '196_project_asset_copy_intents.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => await columnExists(sql, 'project_asset_copy_intents', 'claim_token'),
  },

  // 199 — R311 PR 5 (kanban-coach-errors.md §2.5 / §4.1): the conveyor start
  // attempts fr made per project and the n8n `project.start_failed` /
  // `project.coach_failed` notices (services/conveyor-failures.ts). The probe
  // asserts both tables' discriminating columns AND the two idempotency keys the
  // callbacks' upserts target. In schema.ts, so a push-built database satisfies
  // it. Pure idempotent DDL — re-apply is safe.
  {
    migration: '199_project_conveyor_failures.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'project_conveyor_start_attempts', 'idempotency_key')) &&
      (await columnExists(sql, 'project_conveyor_failures', 'execution_id')) &&
      (await indexExists(sql, 'project_conveyor_failures_start_key')) &&
      (await indexExists(sql, 'project_conveyor_failures_coach_key')),
  },

  // 200 — G8 / R313: the `asset.promotion` approval_kind label. Same shape as 155/156: push
  // never adds a label to an EXISTING type, so the probe keys on pg_enum and a pre-200
  // database keeps 200 PENDING. `reapplyIfProbeFails` is safe: ADD VALUE IF NOT EXISTS only.
  {
    migration: '200_asset_promotion_kind.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum
         WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'approval_kind')
           AND enumlabel = 'asset.promotion'
      `;
      return rows.length === 1;
    },
  },

  // 201 — G8 / R313: at most one PENDING `asset.promotion` per (tenant, copy), the race
  // backstop behind requestAssetPromotion's dedupe. Not declared in schema.ts (same as 153's
  // bug-fix index), so a push-built DB lacks it and the probe keeps 201 PENDING until applied.
  {
    migration: '201_asset_promotion_one_pending_per_copy.sql',
    check: async (sql) => indexExists(sql, 'approvals_one_pending_asset_promotion_per_copy_idx'),
  },

  // 202 — early-access signup v2 (services/signup/*): the signup queue with its approve claim,
  // slug reservation, step record + lease and reject repair. The probe asserts the discriminating
  // columns and the two partial unique indexes the intake and the slug reservation rely on. In
  // schema.ts, so a push-built database satisfies it. Pure idempotent DDL — re-apply is safe.
  {
    migration: '202_signup_approvals.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'signup_approvals', 'approving_claim')) &&
      (await columnExists(sql, 'signup_approvals', 'steps_lease_token')) &&
      (await columnExists(sql, 'signup_approvals', 'reject_repair')) &&
      (await columnExists(sql, 'signup_approvals', 'tenant_attempts')) &&
      (await indexExists(sql, 'signup_approvals_pending_email')) &&
      (await indexExists(sql, 'signup_approvals_tenant_slug_key')),
  },

  // 203 — U1: 'refused' joins the conveyor start attempt outcome CHECK (199:48).
  // Keyed on the constraint DEFINITION (the 113 / 119 rule): a database carrying
  // 199's five-value CHECK under the same name reads FALSE and 203 stays pending.
  // In schema.ts, so a push-built database satisfies it. `reapplyIfProbeFails` is
  // safe: the file is one definition-comparing DO block, no DML.
  {
    migration: '203_conveyor_start_refused_outcome.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      ((await constraintDef(sql, 'project_conveyor_start_attempts', 'project_conveyor_start_attempts_outcome_check')) ?? '').includes(
        "'refused'",
      ),
  },

  // 204 — R318: the `board.move_confirmation` approval_kind label. Same shape as 155/156/200:
  // push never adds a label to an EXISTING type, so the probe keys on pg_enum and a pre-204
  // database keeps 204 PENDING. `reapplyIfProbeFails` is safe: ADD VALUE IF NOT EXISTS only.
  {
    migration: '204_board_move_confirmation_kind.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum
         WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'approval_kind')
           AND enumlabel = 'board.move_confirmation'
      `;
      return rows.length === 1;
    },
  },

  // 205 — R318's one-pending board-move index: no probe since R349 — 232 drops the index, so a
  // presence probe would hold 205 pending forever. Ledger-only.

  // 206 — R318: projects.andon_reason / andon_request_id / andon_approval_id + the reason
  // CHECK. All three columns and the CHECK are in schema.ts, so a push-built DB satisfies it.
  {
    migration: '206_project_andon_reason.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'projects', 'andon_reason')) &&
      (await columnExists(sql, 'projects', 'andon_request_id')) &&
      (await columnExists(sql, 'projects', 'andon_approval_id')) &&
      ((await constraintDef(sql, 'projects', 'projects_andon_reason_check')) ?? '').includes("'move_request'"),
  },

  // 207 — R318: the three conveyor notices join 199's kind CHECK, plus their idempotency
  // index. Keyed on the constraint DEFINITION (the 113 / 119 / 203 rule) and the index name.
  {
    migration: '207_project_conveyor_notice_kinds.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      ((await constraintDef(sql, 'project_conveyor_failures', 'project_conveyor_failures_kind_check')) ?? '').includes(
        "'andon_unreadable'",
      ) && (await indexExists(sql, 'project_conveyor_failures_notice_key')),
  },

  // 208 — R318 F2: project_conveyor_failures.resumed_at / resumed_by (a member resumed an
  // andon_unreadable notice). Both columns are in schema.ts, so a push-built DB satisfies it.
  {
    migration: '208_project_conveyor_notice_resumed.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'project_conveyor_failures', 'resumed_at')) &&
      (await columnExists(sql, 'project_conveyor_failures', 'resumed_by')),
  },

  // 209 — fr#1634: provisioning_audit's action CHECK gains 'resend_set_password_email' (the
  // super_admin resend recovery action). Keyed on the constraint DEFINITION (the 207 rule).
  {
    migration: '209_provisioning_audit_resend_action.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      ((await constraintDef(sql, 'provisioning_audit', 'provisioning_audit_action_check')) ?? '').includes(
        "'resend_set_password_email'",
      ),
  },

  // 210 — early-access offboarding (services/signup/removal.ts): signup_approvals.removal + the
  // 'removed' status, and provisioning_audit's 'remove_signup' / 'remove_signup_step' actions. Keyed
  // on the column AND both constraint DEFINITIONS (the 209 rule). All in schema.ts, so a push-built
  // DB satisfies it. Pure idempotent DDL — re-apply is safe.
  {
    migration: '210_signup_removal.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await columnExists(sql, 'signup_approvals', 'removal')) &&
      (await indexExists(sql, 'signup_approvals_removal_state_idx')) &&
      ((await constraintDef(sql, 'signup_approvals', 'signup_approvals_status_check')) ?? '').includes("'removed'") &&
      ((await constraintDef(sql, 'provisioning_audit', 'provisioning_audit_action_check')) ?? '').includes(
        "'remove_signup_step'",
      ),
  },

  // 211 — cockpit A5 / R-CK1: approval_decisions.decided_by_kind + the triage-agent BACKFILL. DML,
  // so the probe is the file's own `_migration_effects` receipt (the 113 rule: push creates the
  // column and the CHECK, never a row) AND the column. Not `reapplyIfProbeFails`: the receipt is
  // written once, by the backfill's own statement.
  {
    migration: '211_approval_decided_by_kind.sql',
    check: async (sql) =>
      (await migrationEffectRecorded(sql, '211_approval_decided_by_kind.sql')) &&
      (await columnExists(sql, 'approval_decisions', 'decided_by_kind')),
  },

  // 212 — cockpit A5: the dead approvals.triage_* columns (101) and their CHECK are dropped. The
  // receipt keeps it PENDING on a push-built DB (where 101 still runs and re-adds the columns, so
  // 212 must run after it); the absence half catches anything that re-adds them later.
  {
    migration: '212_drop_approval_triage_columns.sql',
    check: async (sql) =>
      (await migrationEffectRecorded(sql, '212_drop_approval_triage_columns.sql')) &&
      !(await columnExists(sql, 'approvals', 'triage_verdict')) &&
      !(await columnExists(sql, 'approvals', 'triage_at')),
  },

  // 213 — cockpit A5 / R-CK5: conveyor_flow_runs (the n8n execution-hook ingest). Table + both
  // indexes are in schema.ts; the 142 guard TRIGGERS are not, so a push-built DB keeps 213 pending
  // until it runs. Pure idempotent DDL — re-apply is safe.
  {
    migration: '213_conveyor_flow_runs.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await columnExists(sql, 'conveyor_flow_runs', 'parent_execution_id'))) return false;
      if (!(await indexExists(sql, 'conveyor_flow_runs_project_started_idx'))) return false;
      if (!(await indexExists(sql, 'conveyor_flow_runs_card_started_idx'))) return false;
      const rows = await sql<{ tgname: string }[]>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'conveyor_flow_runs'
           AND NOT t.tgisinternal
           AND t.tgenabled = 'A'
           AND t.tgname IN ('fr_guard_truncate_conveyor_flow_runs', 'fr_guard_bulk_delete_conveyor_flow_runs')
      `;
      return rows.length === 2;
    },
  },

  // 214 — n8n-custom #17: conveyor_flow_runs.n8n_status (n8n's own final status next to the
  // conveyor's). Pure idempotent DDL; push creates the column too, so the column IS the witness.
  {
    migration: '214_conveyor_flow_run_n8n_status.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => columnExists(sql, 'conveyor_flow_runs', 'n8n_status'),
  },

  // 215 — George 2026-10-27: super_admin_tenant_actions, the durable audit of every write a
  // super_admin sends while switched into a tenant other than their own. Table + both indexes are
  // in schema.ts; the append-only trigger and the 142 guard TRIGGERS are not, so a push-built DB
  // keeps 215 pending until it runs.
  // Pure idempotent DDL — re-apply is safe.
  {
    migration: '215_super_admin_tenant_actions.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await columnExists(sql, 'super_admin_tenant_actions', 'correlation_id'))) return false;
      if (!(await columnExists(sql, 'super_admin_tenant_actions', 'action_name'))) return false;
      if (!(await indexExists(sql, 'super_admin_tenant_actions_tenant_ts_idx'))) return false;
      if (!(await indexExists(sql, 'super_admin_tenant_actions_actor_ts_idx'))) return false;
      const rows = await sql<{ tgname: string }[]>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'super_admin_tenant_actions'
           AND NOT t.tgisinternal
           AND t.tgenabled = 'A'
           AND t.tgname IN (
             'fr_guard_truncate_super_admin_tenant_actions',
             'fr_guard_bulk_delete_super_admin_tenant_actions',
             'fr_append_only_super_admin_tenant_actions'
           )
      `;
      return rows.length === 3;
    },
  },

  // 218 — fr #1683: agent_members (an agent product's own tenant member). The table is in
  // schema.ts; the 142 guard TRIGGERS are not, so a push-built DB keeps 218 pending until it
  // runs. Pure idempotent DDL — re-apply is safe.
  {
    migration: '218_agent_members.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await columnExists(sql, 'agent_members', 'address'))) return false;
      const rows = await sql<{ tgname: string }[]>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'agent_members'
           AND NOT t.tgisinternal
           AND t.tgenabled = 'A'
           AND t.tgname IN ('fr_guard_truncate_agent_members', 'fr_guard_bulk_delete_agent_members')
      `;
      return rows.length === 2;
    },
  },

  // 219 — fr #1683 option A: approval_decisions.via. Pure idempotent DDL; push creates the column
  // too, so the column IS the witness.
  {
    migration: '219_approval_decisions_via.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => columnExists(sql, 'approval_decisions', 'via'),
  },

  // 220 — fr #1683 (agent decisions): decided_by_kind 'agent' (+ the deny-list column 221 drops).
  // Pure idempotent DDL; the widened CHECK is the witness (never the column: 221 removes it, and
  // a probe on it would re-apply 220 and bring the column back).
  {
    migration: '220_agent_decisions.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const rows = await sql<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'approval_decisions_decided_by_kind_check'
      `;
      return rows.length === 1 && rows[0]!.def.includes("'agent'");
    },
  },

  // 221 — owner ruling 2026-10-31: the agent deny-list is removed. The column's ABSENCE is the
  // witness (push no longer builds it).
  {
    migration: '221_drop_agent_denied_approval_kinds.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => !(await columnExists(sql, 'workspaces', 'agent_denied_approval_kinds')),
  },
  // 225 — andon_state.kata_holders (the katas holding the conveyor n8n instance). Its 'kata'
  // project reason was removed again by 227, so the column alone is the witness.
  {
    migration: '225_kata_andon.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => columnExists(sql, 'andon_state', 'kata_holders'),
  },
  // 227 — George 2026-11-03: a kata holds the whole instance, not a project; the reason CHECK is
  // back to ('operator', 'move_request'). The narrowed CHECK is the witness.
  {
    migration: '227_kata_holds_instance_cord.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      const def = await constraintDef(sql, 'projects', 'projects_andon_reason_check');
      return def !== null && def !== undefined && def.includes("'move_request'") && !def.includes("'kata'");
    },
  },
  // 228 — the kata tenant's `workspaces` row (KATA_TENANT_ID). An INSERT `push` cannot build, so
  // the row itself is the witness (as 193).
  {
    migration: '228_kata_tenant.sql',
    reapplyIfProbeFails: true,
    check: async (sql) =>
      (await sql`SELECT 1 FROM workspaces WHERE id = '0195f48b-d000-7000-8000-000000000006'::uuid`).length > 0,
  },
  // 229 — the `katas` table. push builds the table and the partial index (both in schema.ts) but
  // never the guard triggers, so the two triggers are the witness (as 218).
  {
    migration: '229_katas.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (!(await tableExists(sql, 'katas'))) return false;
      const rows = await sql<{ tgname: string }[]>`
        SELECT t.tgname
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'katas'
           AND NOT t.tgisinternal
           AND t.tgenabled = 'A'
           AND t.tgname IN ('fr_guard_truncate_katas', 'fr_guard_bulk_delete_katas')
      `;
      return rows.length === 2;
    },
  },
  // 230 — kata-super-admin §7: the three v3 improvement tenants' data is deleted and three v3
  // tables dropped. ⛔ THE PROBE READS SCHEMA FACTS ONLY — the three tables are gone and the
  // streams CHECK no longer admits kind 'workflow' — NEVER row absence. fr lazily recreates a
  // `workspaces` row for …0002 (routes/assets/_lib/effective-query.ts ensureWorkspace, for any
  // `platform-core` licence caller, which carries that tenant id), so a "no workspaces row"
  // witness went false again after boot and, with reapplyIfProbeFails, re-ran the 43-table
  // DELETE on every later boot. The DATA half is one-shot by the ledger; 230's header says why
  // it is not probed.
  {
    migration: '230_delete_improvement_tenants.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      for (const t of ['kaizen_candidates', 'kaizen_log', 'canary_rollback_events']) {
        if (await tableExists(sql, t)) return false;
      }
      const def = await constraintDef(sql, 'streams', 'streams_kind_tenant_check');
      return def !== null && def !== undefined && !def.includes("'workflow'");
    },
  },
  // 231 — George 2026-11-04: a failed kata keeps the cord until a super-admin releases it
  // (cord_released_at / cord_released_by), and the signature is NOT NULL. push builds both, so
  // the witness is the columns + the constraint together; the file is idempotent.
  {
    migration: '231_kata_failed_keeps_cord.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      for (const c of ['cord_released_at', 'cord_released_by', 'rollback_refused_at', 'rollback_refused_reason']) {
        if (!(await columnExists(sql, 'katas', c))) return false;
      }
      const rows = await sql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'katas' AND column_name = 'signature'
      `;
      return rows[0]?.is_nullable === 'NO';
    },
  },
  // 232 — R349: migration 205's board-move index dropped (fr no longer creates that kind).
  {
    migration: '232_drop_board_move_one_pending_index.sql',
    check: async (sql) => !(await indexExists(sql, 'approvals_one_pending_board_move_per_project_idx')),
  },
  // 233 — George 2026-11-04: procedure_management retired, the procedures asset type removed.
  // Schema facts only: scheduled_reports is gone, card_contracts.procedure_pins is gone, and no
  // public enum carries a 'procedure' label. The DELETE of 'procedure' rows is what the type
  // rewrite needs, so the label's absence witnesses it.
  {
    migration: '233_drop_procedures.sql',
    reapplyIfProbeFails: true,
    check: async (sql) => {
      if (await tableExists(sql, 'scheduled_reports')) return false;
      if (await columnExists(sql, 'card_contracts', 'procedure_pins')) return false;
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public'
           AND t.typname IN ('asset_type', 'asset_kind', 'stream_kind')
           AND e.enumlabel = 'procedure'
      `;
      return rows[0]?.n === 0;
    },
  },
  // 234 — R345/R351: an unresolvable coach_failed notice is stored unattached (project_id nullable).
  {
    migration: '234_conveyor_failures_unattached.sql',
    check: async (sql) => {
      const rows = await sql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'project_conveyor_failures' AND column_name = 'project_id'
      `;
      return rows[0]?.is_nullable === 'YES';
    },
  },
  // 235 — George 2026-11-04: skill_builder retired; the agent-skills pin table is dropped.
  {
    migration: '235_drop_agent_skill_pins.sql',
    check: async (sql) => !(await tableExists(sql, 'agent_skill_pins')),
  },
];

/**
 * The probe REGISTERED for a migration, or undefined.
 *
 * ⭐ EXPORTED SO A TEST CAN EXERCISE THE PROBE THE RUNNER ACTUALLY USES rather
 * than a copy of its query: a test asserting that 113's registered probe reads FALSE on
 * a push-shaped database must go RED if anybody re-points
 * that entry at a constraint, a column or a table, all of which `drizzle-kit
 * push` can create. A test that called `migrationEffectRecorded` directly would
 * stay green through exactly that regression.
 */
export function probeForMigration(
  migration: string,
): ((sql: postgres.ISql) => Promise<boolean>) | undefined {
  return COLUMN_PROBES.find((p) => p.migration === migration)?.check;
}

/**
 * Open a short-lived postgres.js connection and run pending migrations.
 * The connection is closed on both success and failure paths.
 */
export async function applyMigrations(
  databaseUrl: string,
  opts: ApplyMigrationsOptions = {},
): Promise<void> {
  // max: 1 → only one concurrent query; migrations are serial anyway and we
  // don't want to hold more than one connection during startup.
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await runMigrations(sql, opts);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Apply pending migrations against an existing postgres.js client.
 *
 * Exported for tests — they create their own client against an ephemeral DB
 * and reuse it across multiple runner invocations.
 */
export async function runMigrations(
  sql: postgres.Sql,
  opts: ApplyMigrationsOptions = {},
): Promise<void> {
  const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const logger = console;

  const files = await discoverMigrationFiles(migrationsDir);
  if (files.length === 0) {
    logger.log('[migrations] no migration files found, nothing to do');
    return;
  }

  // ⭐ THE PROBES THAT THIS RUN CAN SAY ANYTHING ABOUT, AND WHY THE SCOPING IS
  // LOAD-BEARING. ⛔ DO NOT "SIMPLIFY" THIS BACK TO ITERATING `COLUMN_PROBES`.
  //
  // `COLUMN_PROBES` is the registry for ONE migration set: the files in
  // `migrationsDir`. A probe whose migration file is NOT in the set this run
  // discovered is not evidence of anything — the apply loop was never given
  // that file, so its target being absent says nothing about whether the
  // database is consistent with what DID run. Failing on it does not detect a
  // regression; it only reports that the registry and the directory describe
  // different sets. The integrity check below therefore iterates
  // `probesInScope`, and the reason it must is that the check's whole value is
  // its strictness: every miss it reports has to be a real one, or the next
  // person to hit a spurious miss weakens the check itself to get past it.
  //
  // In production this changes NOTHING: `migrationsDir` is
  // `<backend>/migrations`, which ships every probed file, so
  // `probesInScope.length === COLUMN_PROBES.length` and every probe is
  // evaluated exactly as before. It matters for callers that pass a narrower
  // `migrationsDir` — the migration-runner unit suite replays a SYNTHETIC set
  // to exercise ordering, backfill and self-heal, and before this scoping every
  // probe added for a real migration turned that whole suite red until somebody
  // hand-wrote a matching synthetic fixture. That tax was paid in the wrong
  // currency: it made an unrelated schema change look like a runner regression.
  //
  // ⚠️ WHAT THE SCOPING GIVES UP, AND WHERE IT IS PAID BACK. It stops the
  // runner from noticing a probe that names a file which does not exist (a
  // typo, a renumber, a deleted migration). That is a REGISTRY defect, not a
  // schema defect, and a boot-time throw was never the right place to find it:
  // the `probesOffDisk` warning below names it, and
  // `tests/unit/db/migration-runner.test.ts` fails in CI if any COLUMN_PROBES
  // entry is missing from `backend/migrations/`. Keep that test.
  const discovered = new Set(files.map((f) => f.name));
  const probesInScope = COLUMN_PROBES.filter((p) => discovered.has(p.migration));
  const probesOffDisk = COLUMN_PROBES.filter((p) => !discovered.has(p.migration));
  if (probesOffDisk.length > 0) {
    logger.warn(
      `[migrations] ${probesOffDisk.length} registered probe(s) name a migration ` +
        `that is not in ${migrationsDir} and are NOT being evaluated: ` +
        `${probesOffDisk.map((p) => p.migration).join(', ')}. ` +
        `Expected when a caller passes a narrower migrationsDir (the runner's own ` +
        `unit suite replays a synthetic set); if this is the real migrations ` +
        `directory, the COLUMN_PROBES registry in src/db/migration-runner.ts is ` +
        `stale — a probed file was renamed, renumbered or deleted and its probe ` +
        `now checks nothing.`,
    );
  }

  // Wrap the whole run in a single transaction so the advisory lock is held
  // for its full duration (pg_advisory_xact_lock releases at COMMIT/ROLLBACK).
  // Migrations themselves use sub-transactions via SAVEPOINT (sql.savepoint),
  // which gives us per-file rollback without releasing the outer lock.
  await sql.begin(async (tx) => {
    // Serialize across pods. pg_advisory_xact_lock blocks until available, so
    // a second pod waits for the first to commit and then finds no pending
    // work — exactly what we want.
    await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;

    await ensureMigrationsTable(tx);

    // One-shot _migrations tracker rename. Live DBs that ran the
    // pre-renumbering migration set carry the OLD filenames in
    // _migrations; the disk has the new names. Without this rename
    // the apply loop would treat every renamed file as pending and
    // re-run its CREATE TABLE / ALTER, which would fail.
    //
    // Guard: only fires when at least one old name is present.
    // Idempotent: a second startup finds no old names and no-ops.
    // Delete-safe after every reachable DB has been observed at
    // green; tracking issue follow-up.
    await applyMigrationsTrackerRename(tx, logger);

    const applied = await loadApplied(tx);
    const projectsExists = await tableExists(tx, 'projects');

    // Re-evaluate every probe and throw a hard error on the first miss. Used
    // both on the no-pending early-return path and after a fresh apply, so a
    // single change to the throw signature / probe-iteration order edits one
    // place. Keep the error-message text stable — tests assert on it.
    //
    // ⛔ ITERATES `probesInScope`, NOT `COLUMN_PROBES` — a probe whose migration
    // file is absent from this run's set cannot witness anything, so a miss on
    // it would be a false alarm and false alarms are what get a strict check
    // weakened. Full reasoning at the `probesInScope` definition above; the
    // registry-vs-disk mismatch it stops reporting is covered by the
    // `probesOffDisk` warning and by a CI test over `backend/migrations/`.
    // `filter` preserves registration order, which the suite relies on (the
    // first miss is the one reported).
    const runIntegrityChecks = async (): Promise<void> => {
      for (const probe of probesInScope) {
        if (!(await probe.check(tx))) {
          // ⚠️ THE MESSAGE NAMES THE LIKELIEST CAUSE AND THE EXACT REMEDY.
          // It used to say only "An operator must reconcile the schema manually",
          // which describes the situation and not one thing to do about it. The
          // overwhelmingly common cause is the wedge described on
          // `Probe.reapplyIfProbeFails`: the file is stamped in `_migrations`, so
          // the apply loop skips it, so whatever inside it would have satisfied
          // this probe is unreachable — and the runner throws here on every boot
          // with no path forward. An operator hitting this at 3am should not have
          // to derive that from the source.
          const stamped = await migrationIsStamped(tx, probe.migration);
          throw new Error(
            `[migrations] post-run integrity check failed: probe for ` +
              `'${probe.migration}' did not pass. ` +
              (stamped && probe.reapplyIfProbeFails
                ? // ⚠️ An opted-in probe that fails here was NOT skipped: either the
                  // self-heal above un-stamped it and the apply loop re-ran it, or it
                  // was pending and ran fresh (or it passed at boot start and a later
                  // file undid it). Saying "SKIPPED" would send the operator to delete
                  // a tracker row whose deletion changes nothing. Message-only branch:
                  // no control flow here differs from the stamped case below.
                  `⛔ '${probe.migration}' IS RECORDED IN _migrations, but it was NOT ` +
                  `skipped: it opts into reapplyIfProbeFails, so a failing probe re-runs ` +
                  `it in this boot — and its probe STILL fails after the run. The ` +
                  `file does not produce what its probe checks (e.g. a name-guarded ADD CONSTRAINT leaving a ` +
                  `stale same-name definition in place) — or, if its probe passed at ` +
                  `boot start, a LATER file in this run undid it. Fix the FILE; ` +
                  `deleting its _migrations row will not help.`
                : stamped
                ? `⛔ '${probe.migration}' IS RECORDED IN _migrations, so the apply loop ` +
                  `SKIPPED it and will skip it on every future boot — this database ` +
                  `most likely applied an EARLIER DRAFT of that file (same name, ` +
                  `different contents; an in-flight branch or a re-used CI database ` +
                  `does this). Nothing the runner does on its own can fix that. ` +
                  `IF AND ONLY IF you have read '${probe.migration}' and confirmed ` +
                  `every statement in it is idempotent, re-run it with: ` +
                  `DELETE FROM _migrations WHERE filename = '${probe.migration}'; ` +
                  `then restart — or set reapplyIfProbeFails on its probe in ` +
                  `src/db/migration-runner.ts so the runner does that itself.`
                : `'${probe.migration}' is NOT recorded in _migrations, so the apply ` +
                  `loop should have run it and it either failed or did not produce ` +
                  `the probed effect. Check the apply log above for its error.`) +
              ` An operator must reconcile the schema manually before restart.`,
          );
        }
      }
    };

    // ⭐ FORWARD-COMPAT SELF-HEAL, and it must run BEFORE `pending` is computed.
    // See `Probe.reapplyIfProbeFails` for the wedge this closes: a database that
    // applied an earlier DRAFT of a migration is stamped applied, so the apply
    // loop skips the corrected file forever and the probe hard-fails every boot.
    // Un-stamping here hands the file back to the normal apply loop below, in
    // this same transaction, so it runs and re-stamps itself — or rolls the
    // whole run back if it cannot.
    //
    // ⚠️ Scoped to probes that OPT IN. A blanket "re-run anything whose probe
    // fails" would re-execute non-idempotent files, which is a data-loss event
    // dressed as a repair.
    for (const probe of COLUMN_PROBES) {
      if (!probe.reapplyIfProbeFails) continue;
      if (!applied.has(probe.migration)) continue;
      if (!files.some((f) => f.name === probe.migration)) continue;
      if (await probe.check(tx)) continue;
      logger.warn(
        `[migrations] self-heal: '${probe.migration}' is stamped applied but its ` +
          `probe fails — this database most likely ran an earlier draft of the file. ` +
          `Un-stamping so the apply loop re-runs it (the file is marked idempotent).`,
      );
      await tx`DELETE FROM _migrations WHERE filename = ${probe.migration}`;
      applied.delete(probe.migration);
    }

    // Backfill path: a `projects` table predates this runner (prod was hand-
    // managed before, and CI re-uses fr_ci across runs). Mark each migration
    // as already-applied — EXCEPT any migration whose target column / table
    // is missing; those stay in `pending` so the normal apply loop runs them
    // and self-heals the schema.
    if (applied.size === 0 && projectsExists) {
      logger.warn(
        `[migrations] backfill: _migrations was empty but 'projects' table exists; ` +
          `marking applied migrations (probe-aware skip for ${probesInScope.length} target(s))`,
      );
      for (const file of files) {
        const probe = COLUMN_PROBES.find((p) => p.migration === file.name);
        if (probe) {
          const present = await probe.check(tx);
          if (!present) {
            logger.warn(
              `[migrations] backfill: target of '${file.name}' is missing; ` +
                `leaving in pending so the apply loop self-heals it`,
            );
            continue;
          }
        }
        await tx`INSERT INTO _migrations (filename) VALUES (${file.name})`;
        applied.add(file.name);
      }
    }

    const pending = files.filter((f) => !applied.has(f.name));
    if (pending.length === 0) {
      logger.log('[migrations] schema up to date');
      // Final integrity check — every registered probe must pass on exit.
      // Catches drift the backfill heuristic didn't anticipate.
      if (projectsExists) {
        await runIntegrityChecks();
      }
      return;
    }

    logger.log(`[migrations] applying ${pending.length} migration(s)`);
    for (const file of pending) {
      const rawSql = await readFile(file.path, 'utf8');
      // Each migration runs inside an outer transaction + savepoint that the
      // runner already provides. Some migration files were authored as
      // standalone scripts and carry their own `BEGIN; ... COMMIT;` wrapper —
      // when sent through the savepoint, the embedded COMMIT closes the OUTER
      // transaction, after which the next iteration's SAVEPOINT statement
      // errors with "SAVEPOINT can only be used in transaction blocks". Strip
      // the leading BEGIN/COMMIT so file ordering remains the runner's
      // responsibility.
      const sqlText = rawSql
        .replace(/^[\s]*BEGIN\s*;[\s]*$/im, '')
        .replace(/[\s]*COMMIT\s*;[\s]*$/im, '');
      try {
        await tx.savepoint(async (sp) => {
          await sp.unsafe(sqlText);
          await sp`INSERT INTO _migrations (filename) VALUES (${file.name})`;
        });
        logger.log(`[migrations] applied ${file.name}`);
      } catch (err) {
        // Savepoint already rolled back. Re-throw to abort the outer tx.
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`[migrations] failed to apply ${file.name}: ${reason}`);
      }
    }

    // Post-apply integrity check — every probe must pass after a fresh
    // apply too (covers a fresh DB run, not just the no-op-after-backfill
    // path above). If any probe fails here, the migration file claims to
    // create the target but the apply was a no-op — operator must fix.
    if (projectsExists || (await tableExists(tx, 'projects'))) {
      await runIntegrityChecks();
    }
  });
}

interface MigrationFile {
  name: string;
  path: string;
  order: number;
}

async function discoverMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const files: MigrationFile[] = [];
  for (const name of entries) {
    const match = MIGRATION_FILE_RE.exec(name);
    if (!match) continue;
    files.push({
      name,
      path: path.join(dir, name),
      order: Number.parseInt(match[1]!, 10),
    });
  }
  files.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
  return files;
}

async function ensureMigrationsTable(sql: postgres.ISql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

/**
 * Is this filename recorded in `_migrations`?
 *
 * Used only to make the integrity-check failure explain itself: "stamped but
 * probe failing" and "not stamped and probe failing" are completely different
 * situations with completely different remedies, and the old message covered
 * both with "reconcile the schema manually".
 */
async function migrationIsStamped(sql: postgres.ISql, filename: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM _migrations WHERE filename = ${filename}) AS exists
  `;
  return !!row?.exists;
}

async function loadApplied(sql: postgres.ISql): Promise<Set<string>> {
  const rows = await sql<{ filename: string }[]>`SELECT filename FROM _migrations`;
  return new Set(rows.map((r) => r.filename));
}

async function tableExists(sql: postgres.ISql, table: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${'public.' + table}) IS NOT NULL AS exists
  `;
  return !!row?.exists;
}

/** Migration 153's bug-fix index exists AND its predicate excludes 'expired' (not only 'voided'). */
async function bugFixIndexExcludesExpired(sql: postgres.ISql): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'approvals_one_bug_fix_authorization_per_bug_card_idx'
        AND indexdef LIKE '%''voided''%'
        AND indexdef LIKE '%''expired''%'
    ) AS ok
  `;
  return !!row?.ok;
}

async function indexExists(
  sql: postgres.ISql,
  indexName: string,
): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ${indexName}
    ) AS exists
  `;
  return !!row?.exists;
}

/** `pg_get_constraintdef` of a named constraint on a public table, or null. pg_class, not `::regclass` (the 119 reason). */
async function constraintDef(
  sql: postgres.ISql,
  table: string,
  constraintName: string,
): Promise<string | null> {
  const [row] = await sql<{ def: string }[]>`
    SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class     t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = ${table}
       AND c.conname = ${constraintName}
  `;
  return row?.def ?? null;
}

async function constraintExists(
  sql: postgres.ISql,
  table: string,
  constraintName: string,
): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = ${table}
        AND c.conname = ${constraintName}
    ) AS exists
  `;
  return !!row?.exists;
}

/**
 * Did the named migration record that its DATA effect executed?
 *
 * `_migration_effects` is runner-owned infrastructure, like `_migrations`, and
 * is deliberately absent from schema.ts. It holds one row per migration whose
 * backfill has actually run, written by that migration's own data-modifying CTE
 * so the receipt cannot exist without the write.
 *
 * ⭐ THIS IS THE ONLY PROBE SHAPE `drizzle-kit push` CANNOT SATISFY BY ACCIDENT.
 * push creates tables, columns, indexes and CHECK constraints — every one of
 * which a probe has at some point been written against, and every one of which
 * becomes vacuous the moment somebody declares it in schema.ts (which this repo
 * tells them to do). push cannot INSERT A ROW. Nothing anybody adds to schema.ts
 * can make this return true.
 *
 * The table-existence test comes first on purpose: probes run inside the
 * runner's transaction, and querying a missing relation would abort it.
 */
export async function migrationEffectRecorded(
  sql: postgres.ISql,
  migration: string,
): Promise<boolean> {
  if (!(await tableExists(sql, '_migration_effects'))) return false;
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM _migration_effects WHERE migration = ${migration}
    ) AS exists
  `;
  return !!row?.exists;
}

async function columnExists(
  sql: postgres.ISql,
  table: string,
  column: string,
): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = ${column}
    ) AS exists
  `;
  return !!row?.exists;
}

/**
 * One-shot tracker rename. Maps the OLD migration filenames in `_migrations`
 * onto the NEW filenames produced by `backend/scripts/renumber-migrations.sh`.
 *
 * The guard only fires when an OLD name is still present in the tracker;
 * once renamed, subsequent startups see zero matches and the function is a
 * no-op (cheap single SELECT cost).
 *
 * Runs inside the outer migration transaction held by `runMigrations`, so
 * the rename + the regular apply loop commit atomically.
 *
 * Safe to delete after every reachable DB has booted past this code path
 * (every old name converted to new name). Track the removal in a follow-up
 * PR once the deployment fleet has been verified post-merge.
 */
async function applyMigrationsTrackerRename(
  sql: postgres.ISql,
  logger: Pick<Console, 'log' | 'warn' | 'error'>,
): Promise<void> {
  // Probe for any old name. The shortest distinctive sentinel works fine:
  // '026_streams.sql' was the file that moved to the 017 gap, so it's the
  // canonical signal that the tracker hasn't been migrated yet.
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM _migrations WHERE filename = '026_streams.sql'
    ) AS exists
  `;
  if (!row?.exists) return;

  logger.warn(
    "[migrations] tracker-rename: detected pre-renumbering '_migrations' rows; " +
      'remapping old filenames to new monotonic numbering',
  );

  // Pairs derived from `backend/scripts/renumber-migrations.sql`. Keep this
  // table the single source of truth — the .sql file is for operators who
  // want to run the rename out-of-band; the in-code version is authoritative
  // for the bootstrap path.
  const renames: ReadonlyArray<readonly [string, string]> = [
    ['026_streams.sql', '017_streams.sql'],
    ['027_streams_canary_enabled.sql', '028_streams_canary_enabled.sql'],
    ['028_agent_runtime_sessions_messages.sql', '029_agent_runtime_sessions_messages.sql'],
    ['028_asset_assignments.sql', '030_asset_assignments.sql'],
    ['028_canary_rollback_events.sql', '031_canary_rollback_events.sql'],
    ['029_backfill_workspaces_default_dept.sql', '032_backfill_workspaces_default_dept.sql'],
    ['029_kaizen_candidates.sql', '033_kaizen_candidates.sql'],
    ['030_channels_registry.sql', '034_channels_registry.sql'],
    ['031_relax_asset_assignments_asset_id_to_text.sql', '035_relax_asset_assignments_asset_id_to_text.sql'],
    ['032_backfill_projects_dept_id.sql', '036_backfill_projects_dept_id.sql'],
    ['033_relax_projects_dept_id_fk.sql', '037_relax_projects_dept_id_fk.sql'],
    ['034_internal_improvement_workspaces.sql', '038_internal_improvement_workspaces.sql'],
    ['035_drop_improvements_table.sql', '039_drop_improvements_table.sql'],
    ['036_seed_internal_tenant_operator_roles.sql', '040_seed_internal_tenant_operator_roles.sql'],
    ['037_seed_tenant_improvement_projects.sql', '041_seed_tenant_improvement_projects.sql'],
    ['038_approvals_kind.sql', '042_approvals_kind.sql'],
    ['039_kaizen_log.sql', '043_kaizen_log.sql'],
    ['040_streams_notification_channels.sql', '044_streams_notification_channels.sql'],
    ['041_spec_2_continuous_flow.sql', '045_spec_2_continuous_flow.sql'],
    ['042_extend_trigger_run_status.sql', '046_extend_trigger_run_status.sql'],
    ['043_approvals_tenant_id.sql', '047_approvals_tenant_id.sql'],
    ['044_credentials_encryption_marker.sql', '048_credentials_encryption_marker.sql'],
    ['045_suggested_schedules.sql', '049_suggested_schedules.sql'],
    ['046_scheduled_reports_partial_failure_status.sql', '050_scheduled_reports_partial_failure_status.sql'],
    ['047_scheduled_triggers_from_suggestion.sql', '051_scheduled_triggers_from_suggestion.sql'],
    ['048_suggested_schedules_heuristic_dedupe.sql', '052_suggested_schedules_heuristic_dedupe.sql'],
    ['049_backfill_channel_owns_assignments.sql', '053_backfill_channel_owns_assignments.sql'],
    ['050_streams_slug.sql', '054_streams_slug.sql'],
    ['051_agent_runtime_sessions_project_id.sql', '055_agent_runtime_sessions_project_id.sql'],
    ['052_provisioning_audit.sql', '056_provisioning_audit.sql'],
    ['053_andon_engaged.sql', '057_andon_engaged.sql'],
    ['054_andon_function_owner.sql', '058_andon_function_owner.sql'],
    ['055_streams_kind_tenant_aware.sql', '059_streams_kind_tenant_aware.sql'],
    ['056_streams_kind_tenant_check_rewrite.sql', '060_streams_kind_tenant_check_rewrite.sql'],
  ];

  let renamed = 0;
  for (const [oldName, newName] of renames) {
    const result = await sql`
      UPDATE _migrations SET filename = ${newName} WHERE filename = ${oldName}
    `;
    // postgres.js returns a result with `.count` for non-row-returning UPDATEs.
    const count = (result as unknown as { count?: number }).count ?? 0;
    if (count > 0) renamed += count;
  }

  logger.log(`[migrations] tracker-rename: remapped ${renamed} row(s)`);
}
