// tests/unit/db/migration-runner.test.ts
//
// Exercises the sequential migration runner against an ephemeral postgres:18
// container. Each test gets its own fresh schema via `CREATE DATABASE`.
//
// Skipped automatically if Docker is unavailable — keeps CI happy on machines
// that can't pull images (reports via console.warn).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { containerRemoveArgs, postgresRunArgs } from '../../helpers/test-postgres-container';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';

import {
  applyMigrations,
  probeForMigration,
  runMigrations,
} from '../../../src/db/migration-runner';
// The sanctioned reader of the COLUMN_PROBES registry — it parses
// migration-runner.ts rather than restating its contents, so a probe removed
// there surfaces here as a change, never as agreement with a stale copy.
import { parseProbedMigrations } from '../../../scripts/check-migration-dml-probed';

// ---- docker harness -------------------------------------------------------

const CONTAINER_NAME = `fr-migration-runner-test-${process.pid}`;
const CONTAINER_NAME_PREFIX = 'fr-migration-runner-test-';
const TEST_PASSWORD = 'test';
// Filled in by startContainer() — we let Docker pick an ephemeral host port
// (via `-p 0:5432`) instead of hardcoding 55433, so parallel test processes
// and stale containers from crashed prior runs can never collide on the port.
let TEST_PORT = 0;

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

/**
 * Is the pid encoded in a `fr-migration-runner-test-<pid>` container name still
 * a LIVE process? `kill(pid, 0)` sends no signal: it returns for a live process,
 * throws ESRCH when the pid is gone, and throws EPERM when the process exists
 * but belongs to another user. EPERM is still "alive", so only ESRCH counts as
 * dead — anything we cannot prove dead is treated as alive and left alone.
 */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unparseable → assume alive
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Reap ORPHANED `fr-migration-runner-test-<pid>` containers — those whose owning
 * test process is gone. Prior runs that were SIGKILLed (OOM, CI runner cancel,
 * bun test timeout) leave containers running under their old pid; those hold a
 * host port and leak disk, so they must still be cleaned up.
 *
 * ⛔ IT MUST NOT REAP A LIVE PROCESS'S CONTAINER. This function used to remove
 * EVERY container matching the prefix, which made two concurrent `bun test`
 * invocations that both collect this file mutually destructive: whichever one
 * called `startContainer()` (or `stopContainer()`) second ripped the Postgres
 * out from under the other, which then failed with `connect ECONNREFUSED` on
 * whatever test happened to be running at that instant. That is a pure race, so
 * the damage was arbitrary — anywhere from one failed test to all twelve —
 * and it is invisible when the file is run on its own. Running one file per
 * process is normal (a `bun test <file>` next to a full-suite run, or two
 * agents on one box), so the prefix sweep had to become pid-aware rather than
 * unconditional.
 *
 * A recycled pid can make us skip a genuine orphan; that fails safe, because
 * our own container is `docker rm -f`'d by EXACT name before this runs and the
 * host port is ephemeral (`-p 127.0.0.1::5432`), so a surviving stranger
 * cannot collide with us.
 *
 * Swallow all errors — `docker rm -f` on an already-gone container is fine.
 */
function reapOrphanedTestContainers(): void {
  const ls = spawnSync(
    'docker',
    ['ps', '-a', '--filter', `name=${CONTAINER_NAME_PREFIX}`, '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  if (ls.status !== 0) return;
  const orphans = (ls.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((n) => n.startsWith(CONTAINER_NAME_PREFIX))
    .filter((n) => n !== CONTAINER_NAME)
    .filter((n) => !pidIsAlive(Number.parseInt(n.slice(CONTAINER_NAME_PREFIX.length), 10)));
  if (orphans.length === 0) return;
  spawnSync('docker', containerRemoveArgs(orphans), { encoding: 'utf8' });
}

function startContainer(): { ok: boolean; reason?: string } {
  // Clear our own name (a recycled pid could still own one), then reap only
  // containers whose owning process is DEAD. Never a live sibling's — see
  // reapOrphanedTestContainers(). Errors ignored.
  spawnSync('docker', containerRemoveArgs([CONTAINER_NAME]), { encoding: 'utf8' });
  reapOrphanedTestContainers();

  const r = spawnSync(
    'docker',
    postgresRunArgs({ name: CONTAINER_NAME, password: TEST_PASSWORD }),
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return { ok: false, reason: r.stderr || r.stdout };

  // Resolve the chosen host port. Retry briefly — Docker sometimes needs a
  // beat after `run -d` before `docker port` reports the mapping.
  for (let i = 0; i < 20; i++) {
    const p = spawnSync('docker', ['port', CONTAINER_NAME, '5432/tcp'], {
      encoding: 'utf8',
    });
    if (p.status === 0 && p.stdout) {
      // Output lines like "127.0.0.1:55437" — take first, parse trailing port.
      const line = p.stdout.split('\n').find((l) => l.trim().length > 0);
      const m = line?.match(/:(\d+)\s*$/);
      if (m) {
        TEST_PORT = Number.parseInt(m[1]!, 10);
        return { ok: true };
      }
    }
    // brief sync sleep
    spawnSync('sleep', ['0.1']);
  }
  return { ok: false, reason: 'could not resolve host port via `docker port`' };
}

function stopContainer(): void {
  // Our own container, by EXACT name. Deliberately NOT a prefix sweep: teardown
  // has no business touching a container it did not create, and doing so used
  // to kill a concurrently-running sibling process mid-test.
  spawnSync('docker', containerRemoveArgs([CONTAINER_NAME]), { encoding: 'utf8' });
  // Orphans only (dead owners) — cheap, and keeps a SIGKILLed prior run from
  // leaking a container forever if it never reaches its own teardown.
  reapOrphanedTestContainers();
}

function adminUrl(db = 'postgres'): string {
  return `postgresql://postgres:${TEST_PASSWORD}@127.0.0.1:${TEST_PORT}/${db}`;
}

async function waitForPg(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sql = postgres(adminUrl(), { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await sql`SELECT 1`;
      await sql.end({ timeout: 1 });
      return;
    } catch {
      try { await sql.end({ timeout: 1 }); } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Timed out waiting for postgres on port ${TEST_PORT}`);
}

// ---- fresh-DB-per-test helper ---------------------------------------------

let dbCounter = 0;

async function createFreshDb(): Promise<{ url: string; name: string }> {
  dbCounter += 1;
  const name = `mig_test_${process.pid}_${dbCounter}`;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return { url: adminUrl(name), name };
}

// ---- migration-files fixture ----------------------------------------------

/** The repo's REAL migrations directory (backend/migrations). */
const REAL_MIGRATIONS_DIR = path.resolve(import.meta.dir, '..', '..', '..', 'migrations');

/** The tenant-scoped-uniqueness migration, read off disk rather than copied. */
const MIGRATION_111 = '111_asset_assignments_tenant_scoped_uniqueness.sql';

/**
 * The migration carrying `reapplyIfProbeFails` that the two self-heal tests at
 * the bottom of this file drive. (114 also opts in; 113 stays the subject here
 * because these tests were written against it and grade the FLAG, not the file.)
 *
 * 111 is the deliberate CONTROL for it: same registry, same integrity check, a
 * probe that can equally be broken by hand — and NO opt-in flag. The pair is
 * what makes the flag itself the variable rather than "the runner repairs
 * things sometimes".
 */
const MIGRATION_113 = '113_approval_callback_effect_marker.sql';

/**
 * Copy the repo's real 001-006 migrations into a scratch dir so tests can add
 * a deliberately-broken file for the "corrupt SQL" case without polluting the
 * working tree.
 */
async function materializeMigrations(
  files: Array<{ name: string; body: string }>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fr-migrations-'));
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    await writeFile(path.join(dir, f.name), f.body, 'utf8');
  }
  return dir;
}

/**
 * Minimal, self-contained migration set used by the fresh-DB test.
 * We don't reuse the real 001-006 here because 001 drops a column that
 * 002 creates — order-agnostic re-runs would break. For the runner we only
 * need: (a) multiple files, (b) real DDL, (c) 006 creating planka_project_id.
 *
 * ⚠️ CORRECTED 2026-09-30 — SEVERAL PER-ENTRY COMMENTS BELOW SAY A FIXTURE IS
 * "MANDATORY" / "NOT OPTIONAL DECORATION" BECAUSE `runIntegrityChecks` ITERATES
 * THE WHOLE `COLUMN_PROBES` REGISTRY. THAT IS NO LONGER TRUE, AND THE DIRECTION
 * MATTERS: the requirement is GONE, not relaxed. The runner now scopes the
 * post-run integrity check to the probes whose migration file is actually in the
 * set it was handed (`probesInScope` in src/db/migration-runner.ts, where the
 * reasoning lives). A probe with no fixture here is SKIPPED for that run, not
 * failed, because a file the apply loop was never given cannot witness anything.
 *
 * Why it had to change: adding a COLUMN_PROBES entry for a real migration turned
 * all 15 tests in this file red — 141_card_asset_binding.sql and
 * 142_destructive_statement_guard.sql did exactly that — so an unrelated schema
 * change presented as a runner regression, and the only cure was to hand-write a
 * synthetic body for a file this suite does not otherwise care about.
 *
 * ⭐ ADDING A FIXTURE HERE IS STILL WORTH DOING when you want the probe exercised
 * end-to-end (backfill skip → apply → probe passes) by the synthetic suite —
 * that is what every entry below buys, and none of them is dead weight. It is
 * simply no longer compulsory. The registry-vs-disk check that the scoping does
 * give up is restored by `COLUMN_PROBES registry` at the bottom of this file.
 */
const SYNTHETIC_MIGRATIONS: Array<{ name: string; body: string }> = [
  {
    name: '001_init.sql',
    body: `CREATE TABLE projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
  },
  {
    name: '002_description.sql',
    body: `ALTER TABLE projects ADD COLUMN description TEXT;`,
  },
  {
    name: '003_status.sql',
    body: `ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted';`,
  },
  {
    name: '004_notes.sql',
    body: `CREATE TABLE notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      body TEXT NOT NULL
    );
    CREATE INDEX idx_notes_project_id ON notes(project_id);`,
  },
  {
    name: '005_reports.sql',
    body: `CREATE TABLE reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL
    );`,
  },
  {
    name: '006_projects_planka_project_id.sql',
    body: `ALTER TABLE projects ADD COLUMN planka_project_id TEXT;`,
  },
  // Phase 2.G — index-only migrations whose probes detect that
  // drizzle-kit push didn't model them. Placed in numeric order so the
  // sorted-by-filename assertion in the "partial" + "fresh DB" tests
  // matches SYNTHETIC_MIGRATIONS insertion order.
  {
    name: '020_bridge_idempotency_unique_idx.sql',
    body: `CREATE TABLE card_drafts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL,
      producer TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE UNIQUE INDEX card_drafts_idempotency_unique_idx
      ON card_drafts (project_id, producer, (metadata->>'idempotency_key'))
      WHERE metadata ? 'idempotency_key';`,
  },
  {
    name: '025_agent_runtime_sessions.sql',
    body: `CREATE TABLE agent_runtime_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      channel TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX idx_agent_runtime_sessions_user_channel_thread
      ON agent_runtime_sessions (user_id, channel, thread_id);`,
  },
  // The next four file names match COLUMN_PROBES entries so the
  // probe-aware backfill / post-run integrity check is exercised end-to-end
  // by the synthetic suite. Bodies are minimal (only what the probe asserts).
  {
    name: '026_workspaces_and_departments.sql',
    body: `ALTER TABLE projects ADD COLUMN dept_id UUID;`,
  },
  {
    name: '027_dept_member_roles.sql',
    body: `CREATE TABLE department_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dept_id UUID NOT NULL,
      user_id UUID NOT NULL
    );`,
  },
  {
    name: '034_channels_registry.sql',
    body: `CREATE TABLE channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind TEXT NOT NULL
    );`,
  },
  {
    name: '044_streams_notification_channels.sql',
    body: `CREATE TABLE streams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      notification_channels JSONB NOT NULL DEFAULT '[]'::jsonb
    );`,
  },
  {
    name: '045_spec_2_continuous_flow.sql',
    body: `CREATE TABLE scheduled_triggers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL
    );`,
  },
  {
    name: '049_suggested_schedules.sql',
    body: `CREATE TABLE suggested_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      project_id UUID NOT NULL,
      status TEXT NOT NULL DEFAULT 'new'
    );`,
  },
  {
    name: '051_scheduled_triggers_from_suggestion.sql',
    body: `ALTER TABLE scheduled_triggers ADD COLUMN from_suggestion_id UUID;`,
  },
  // Spec 2 Task 1 — super-admin provisioning audit. Probe: tableExists.
  {
    name: '056_provisioning_audit.sql',
    body: `CREATE TABLE provisioning_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );`,
  },
  // Plan 7 Stage 0a — stream_kind enum extension. Probe inspects pg_enum
  // for the 'principle' label. The synthetic body creates the enum with
  // all 5 labels in one statement so the probe passes; we don't need to
  // emulate the CHECK rewrite or the streams.kind column here because the
  // probe only inspects the enum.
  {
    name: '059_streams_kind_tenant_aware.sql',
    body: `CREATE TYPE stream_kind AS ENUM (
      'workflow', 'prompt', 'principle', 'requirement', 'decision'
    );`,
  },
  // Task #25 scope B PR 2 — project ↔ repository N:M join. Probe:
  // tableExists('project_repositories'). Synthetic body matches the
  // minimum the probe asserts on — full DDL is in migration 072.
  {
    name: '072_project_repositories.sql',
    body: `CREATE TABLE project_repositories (
      project_id UUID NOT NULL,
      repo_id    UUID NOT NULL,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, repo_id)
    );`,
  },
  // AA ready-prefetch gate — approval_kind enum extension. Probe inspects
  // pg_enum for the 'execution.ready_signoff' label. Like 059 above, the
  // synthetic body creates the enum with all labels in one statement so the
  // probe passes; the real migration 073 ADD VALUEs onto a pre-existing enum.
  {
    name: '073_approval_kind_execution_ready_signoff.sql',
    body: `CREATE TYPE approval_kind AS ENUM (
      'generic', 'improvement.design', 'improvement.release', 'execution.ready_signoff'
    );`,
  },
  // Execution sign-off roster. Probe: tableExists('project_stakeholders').
  // Synthetic body matches the minimum the probe asserts; full DDL is in
  // migration 074.
  {
    name: '074_project_stakeholders.sql',
    body: `CREATE TABLE project_stakeholders (
      project_id UUID NOT NULL,
      user_id    UUID NOT NULL,
      role       TEXT NOT NULL DEFAULT 'execution_signoff',
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, user_id, role)
    );`,
  },
  // Bulk fan-out governance kill-switch (migration 076). Its probe was REMOVED with
  // migration 197, which drops the table; this synthetic file stays as an ordinary
  // unprobed migration in the numeric sequence.
  {
    name: '076_campaign_governance.sql',
    body: `CREATE TABLE campaign_governance_controls (
      id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      bulk_disabled BOOLEAN NOT NULL DEFAULT false,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
  },
  // WS1 Phase 1A — project-execution notification hub. Probe:
  // tableExists('notifications'). Synthetic body matches the minimum the probe
  // asserts on — full DDL (notification_prefs + indexes) is in migration 077.
  {
    name: '077_project_execution_notifications.sql',
    body: `CREATE TABLE notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
  },
  // Macro lifecycle phase backing the redesign's phase rail. Probe:
  // columnExists('projects', 'project_phase'). Synthetic body matches the
  // minimum the probe asserts on — the `continuous` backfill is in migration 081.
  {
    name: '081_project_phase.sql',
    body: `ALTER TABLE projects ADD COLUMN project_phase TEXT NOT NULL DEFAULT 'request';`,
  },
  // WS-3 — workflow-canary cockpit action approval_kind enum label. Probe
  // inspects pg_enum for the 'improvement.canary_action' label on approval_kind
  // (created by the synthetic 073 above). Like the real migration 086, the body
  // The AA router's durable atomic dedupe. Probe: tableExists('router_dedupe').
  // ⚠️ 082 shipped WITHOUT a probe, which is why it is only appearing here now:
  // the table is raw-SQL only (absent from the drizzle schema), so on a
  // drizzle-kit-push-bootstrapped CI DB the backfill stamped it applied against a
  // database that never had the table — and the four handleN8nRouterDedupe tests
  // in the webhooks unit suite (since deleted, 2026-10-29), including the
  // 8-concurrent-claim atomicity proof, skipped on every CI run. The probe (added alongside migration
  // 100) is what makes them actually run. Synthetic body matches the minimum the
  // probe asserts on; the real migration also carries the created_at index.
  {
    name: '082_router_dedupe.sql',
    body: `CREATE TABLE router_dedupe (
      tenant_id      TEXT        NOT NULL,
      card_id        TEXT        NOT NULL,
      list_id        TEXT        NOT NULL,
      updated_at_sec BIGINT      NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, card_id, list_id, updated_at_sec)
    );`,
  },
  // ADD VALUEs onto the pre-existing enum so the probe passes end-to-end.
  {
    name: '086_approvals_kind_canary.sql',
    body: `ALTER TYPE approval_kind ADD VALUE IF NOT EXISTS 'improvement.canary_action';`,
  },
  // Stable, content-derived document identity the purge keys on. Probe:
  // columnExists('documents', 'kag_document_id'). Synthetic body matches the minimum
  // the probe asserts on — the real migration 087 also adds the index and lands the
  // column on the full documents table.
  {
    name: '087_documents_kag_document_id.sql',
    body: `CREATE TABLE documents (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kag_ingestion_id  TEXT,
      kag_document_id   TEXT
    );`,
  },
  // Budget-alert idempotency receipts. Probe:
  // tableExists('budget_alert_receipts'). Synthetic body matches the minimum
  // the probe asserts on — the real migration 093 also carries the dedupe UNIQUE.
  {
    name: '093_budget_alert_receipts.sql',
    body: `CREATE TABLE budget_alert_receipts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     TEXT NOT NULL,
      budget_id     TEXT NOT NULL,
      threshold_pct INTEGER NOT NULL,
      period_start  TIMESTAMPTZ NOT NULL
    );`,
  },
  // Consecutive permanent-dispatch-failure ledger behind the scheduled-trigger
  // auto-disable. Probe: columnExists('scheduled_triggers',
  // 'permanent_failure_count'). ALTER rather than CREATE — the synthetic
  // `scheduled_triggers` is created by 045 above. Synthetic body matches the
  // minimum the probe asserts on; the real migration 094 adds `disabled_reason`
  // in the same file (which is why probing one column covers both).
  {
    name: '094_scheduled_triggers_permanent_failure_ledger.sql',
    body: `ALTER TABLE scheduled_triggers
      ADD COLUMN permanent_failure_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE scheduled_triggers ADD COLUMN disabled_reason TEXT;`,
  },
  // KAG ingestion honesty flags — the columns that stop fr rendering a green
  // `completed` over a graph that silently lost most of its chunks. Probe:
  // columnExists('documents', 'kag_degraded'). ALTER rather than CREATE — the
  // synthetic `documents` table is created by 087 above. Synthetic body matches
  // the minimum the probe asserts on plus the five siblings that ship in the
  // same real migration (which is why probing one column covers all six).
  //
  // ⚠️ SUPERSEDED 2026-09-30 (kept because it records why this fixture exists).
  // It read: "This entry is NOT optional decoration: every COLUMN_PROBES row must
  // have a matching synthetic file here, because `runIntegrityChecks` iterates the
  // WHOLE registry after the synthetic apply. Adding a probe without adding its
  // file fails all ten migration-runner tests." The runner no longer iterates the
  // whole registry — it iterates the probes whose file is in the set under
  // consideration — so a missing fixture is now a SKIP, not a failure. See the
  // header of SYNTHETIC_MIGRATIONS. This entry still earns its place: it gets
  // 099's probe exercised end-to-end by the synthetic suite.
  {
    name: '099_documents_kag_degraded.sql',
    body: `ALTER TABLE documents ADD COLUMN kag_degraded        BOOLEAN;
    ALTER TABLE documents ADD COLUMN kag_degraded_reason TEXT;
    ALTER TABLE documents ADD COLUMN kag_degraded_stage  TEXT;
    ALTER TABLE documents ADD COLUMN chunks_indexed      INTEGER;
    ALTER TABLE documents ADD COLUMN chunks_failed       INTEGER;
    ALTER TABLE documents ADD COLUMN chunks_total        INTEGER;`,
  },
  // The atomic card claim (PRODUCTION_READINESS.md Part 3). Probe:
  // tableExists('card_phase_lease'). Same raw-SQL-only reason as 082 above: without
  // the probe a push-bootstrapped CI DB would stamp 100 applied with no table and
  // the entire lease suite would skip while CI reported green.
  {
    name: '100_card_phase_lease.sql',
    body: `CREATE TABLE card_phase_lease (
      tenant_id   TEXT        NOT NULL,
      card_id     TEXT        NOT NULL,
      lease_id    TEXT        NOT NULL,
      holder      TEXT        NOT NULL,
      fence       BIGINT      NOT NULL DEFAULT 1,
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      released_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, card_id)
    );`,
  },
  // Approval routing + the triage seam. Probe:
  // indexExists('approvals_undelivered_idx').
  //
  // It was columnExists('approvals', 'approver_user_id') — deliberately a COLUMN
  // probe rather than a table one, because 101 ALTERs a table that already
  // exists and tableExists('approvals') would pass vacuously. That reasoning was
  // right and the chosen column was still wrong: drizzle MODELS
  // `approver_user_id`, so `drizzle-kit push` creates it on every fresh CI
  // database, the probe passed, and 101 was stamped applied without running.
  // MEASURED 2026-08-29 on a fresh postgres:18 — all four triage columns present,
  // `approvals_triage_verdict_check` absent, `approvals` carrying no CHECK at all.
  //
  // It then targeted the CHECK. ⚠️ MOVED AGAIN 2026-09-23 onto 101's partial index
  // `approvals_undelivered_idx`, because the CHECK is queued for demolition:
  // migration 130 drops the four write-only `triage_*` columns and the CHECK with
  // them, which would leave 101's probe reading FALSE on every boot and the
  // post-run integrity check throwing. The index is on `expires_at` WHERE
  // `status='pending' AND notified_at IS NULL` and survives 130 untouched.
  // schema.ts declares NO index on `approvals` at all, so push cannot create it —
  // the same honesty property the CHECK had. Full reasoning: the 101 entry in
  // src/db/migration-runner.ts.
  //
  // The synthetic body CREATEs the table first because this fixture DB has no
  // `approvals` (the real migration 043 line is far upstream of the range these
  // scenarios replay). It carries BOTH the CHECK and the index: the index because
  // it is what the probe now reads, and the CHECK because 101 still emits it and a
  // fixture that quietly dropped it would stop replaying the real file.
  {
    name: '101_approval_triage.sql',
    body: `CREATE TABLE IF NOT EXISTS approvals (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status           TEXT NOT NULL DEFAULT 'pending',
      expires_at       TIMESTAMPTZ
    );
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS approver_user_id UUID;
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ;
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS triage_verdict   TEXT;
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS triage_actor     TEXT;
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS triage_rationale TEXT;
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS triage_at        TIMESTAMPTZ;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'approvals_triage_verdict_check'
      ) THEN
        ALTER TABLE approvals
          ADD CONSTRAINT approvals_triage_verdict_check
          CHECK (triage_verdict IS NULL
                 OR triage_verdict IN ('escalate', 'auto_approve', 'auto_reject', 'defer'));
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS approvals_approver_pending_idx
      ON approvals (approver_user_id, status)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS approvals_undelivered_idx
      ON approvals (expires_at)
      WHERE status = 'pending' AND notified_at IS NULL;`,
  },
  // `router_dedupe.tenant_id` → `planka_scope_id`. Probe:
  // columnExists('router_dedupe', 'planka_scope_id') — a COLUMN probe for the same
  // reason 101 uses one: the table already exists (synthetic 082 above creates it),
  // so tableExists('router_dedupe') would pass vacuously on a DB that only ever ran
  // 082 and still carries the old column name, and every handleN8nRouterDedupe test
  // would then fail against a column the handler no longer names.
  //
  // The body is the REAL migration's drift-tolerant DO block verbatim, not an
  // `ALTER … RENAME`: replaying it here is what proves the guard makes a second
  // application a no-op instead of an error.
  {
    name: '102_router_dedupe_planka_scope_id.sql',
    body: `DO $$
    BEGIN
      IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'router_dedupe' AND column_name = 'tenant_id'
          )
         AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'router_dedupe' AND column_name = 'planka_scope_id'
          )
      THEN
        ALTER TABLE router_dedupe RENAME COLUMN tenant_id TO planka_scope_id;
      END IF;
    END $$;`,
  },

  // The last ten `tenant_id` columns text -> uuid. Probe: none of the ten
  // target tables still carries a `text` tenant_id AND `card_phase_lease`
  // exists (see the probe's own comment for why that second clause is what
  // makes 103 order-safe on a push-bootstrapped database).
  //
  // The body is the REAL migration's DO block verbatim — same reason 102 above
  // replays its real body rather than a hand-simplified `ALTER`: the loop's
  // per-table "skip unless currently text" guard and its non-uuid fail-loud
  // check are the parts worth exercising, and a simplified stand-in would prove
  // neither. In this fixture DB only the tables synthetic 045/049/093/100
  // created above exist; the loop CONTINUEs past the rest, which is exactly the
  // drift-tolerance the real migration claims.
  {
    name: '103_tenant_id_text_to_uuid.sql',
    body: `DO $$
    DECLARE
      target_tables CONSTANT text[] := ARRAY[
        'analytics_rollups', 'budget_alert_receipts', 'campaign_jobs',
        'card_phase_lease', 'kaizen_candidates', 'notifications',
        'scheduled_reports', 'scheduled_trigger_runs', 'scheduled_triggers',
        'suggested_schedules'
      ];
      tbl          text;
      current_type text;
      bad_rows     bigint;
      bad_sample   text;
    BEGIN
      FOREACH tbl IN ARRAY target_tables LOOP
        SELECT c.data_type INTO current_type
          FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name   = tbl
           AND c.column_name  = 'tenant_id';

        IF current_type IS NULL OR current_type = 'uuid' THEN
          CONTINUE;
        END IF;

        IF current_type <> 'text' THEN
          RAISE EXCEPTION
            'Migration 103: %.tenant_id has unexpected type "%" (expected text or uuid).',
            tbl, current_type;
        END IF;

        EXECUTE format(
          'SELECT count(*), min(tenant_id) FROM public.%I
            WHERE tenant_id IS NOT NULL
              AND tenant_id !~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''',
          tbl
        ) INTO bad_rows, bad_sample;

        IF bad_rows > 0 THEN
          RAISE EXCEPTION
            'Migration 103 ABORTED: %.tenant_id holds % row(s) whose value is not a uuid (e.g. %).',
            tbl, bad_rows, quote_literal(bad_sample);
        END IF;

        EXECUTE format(
          'ALTER TABLE public.%I ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid',
          tbl
        );
      END LOOP;
    END$$;`,
  },

  // `user_roles.role` constrained to the two roles the product issues. Probe:
  // constraintExists('user_roles', 'user_roles_role_check').
  //
  // A CONSTRAINT probe, not a column one: 104 adds no column, and drizzle has no
  // CHECK primitive, so `drizzle-kit push` cannot create the constraint on a
  // fresh CI database. Without the probe the backfill stamped 104 applied against
  // a DB that never got it — MEASURED 2026-08-29: `_migrations` held the row,
  // `pg_constraint` held nothing, and INSERT role='admin' succeeded.
  //
  // The synthetic body CREATEs `user_roles` first (this fixture DB has none) and
  // seeds a row carrying the legacy 'admin' value, so the DELETE-then-constrain
  // ORDER is genuinely exercised: with the two steps swapped, ADD CONSTRAINT
  // aborts on that row and this fixture fails — which is the point of seeding it.
  {
    name: '104_user_roles_role_check.sql',
    body: `CREATE TABLE IF NOT EXISTS user_roles (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     TEXT NOT NULL,
      tenant_id   UUID NOT NULL,
      role        TEXT NOT NULL,
      granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO user_roles (user_id, tenant_id, role)
      VALUES ('00000000-0000-0000-0000-000000000000',
              '01934567-89ab-7def-8123-456789abcdef', 'admin')
      ON CONFLICT DO NOTHING;

    DELETE FROM user_roles
     WHERE user_id = '00000000-0000-0000-0000-000000000000';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'user_roles'::regclass
           AND conname  = 'user_roles_role_check'
      ) THEN
        ALTER TABLE user_roles
          ADD CONSTRAINT user_roles_role_check
          CHECK (role IN ('workspace-admin', 'workspace-member'));
      END IF;
    END $$;`,
  },

  // Per-tenant uniqueness on `asset_assignments`. Probe: both partial unique
  // indexes present AND `workspace_id` leading their key list.
  //
  // Mandatory, not decoration — see the note on 099 above: `runIntegrityChecks`
  // iterates the WHOLE registry after every synthetic apply, so a COLUMN_PROBES
  // row with no file here fails every test in this suite.
  //
  // The synthetic body CREATEs the table first (this fixture DB has no
  // `asset_assignments` — the real 030 that creates it is far upstream of the
  // range these scenarios replay); the four index statements after it are the
  // REAL migration 111's DDL verbatim. The dedicated test below does NOT use
  // this copy: it reads the real file off disk, precisely so a change to the
  // real migration cannot pass by grading a stale copy.
  {
    name: MIGRATION_111,
    body: `CREATE TABLE IF NOT EXISTS asset_assignments (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      asset_type   TEXT NOT NULL,
      asset_id     TEXT NOT NULL,
      scope_level  TEXT NOT NULL,
      target_id    TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    DROP INDEX IF EXISTS asset_assignments_uq_workspace;
    DROP INDEX IF EXISTS asset_assignments_uq_with_target;

    CREATE UNIQUE INDEX IF NOT EXISTS asset_assignments_uq_workspace
      ON asset_assignments (workspace_id, asset_type, asset_id, scope_level)
      WHERE target_id IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS asset_assignments_uq_with_target
      ON asset_assignments (workspace_id, asset_type, asset_id, scope_level, target_id)
      WHERE target_id IS NOT NULL;`,
  },

  // Migration 113 — the transport ack told apart from the effect. Probe:
  // migrationEffectRecorded('113_...'), i.e. the receipt row the backfill writes
  // for itself in `_migration_effects`.
  //
  // ⚠️ IT USED TO BE constraintExists('approvals',
  // 'approvals_callback_resolution_check'), on the stated grounds that drizzle
  // has no CHECK primitive. That premise is false — `drizzle-kit push` emitted
  // 31 CHECK constraints on a scratch postgres:18, MEASURED 2026-09-06 — and
  // the constraint is now declared in schema.ts for parity, which would have
  // made that probe pass on a fresh CI database with the backfill never run.
  // `push` cannot INSERT A ROW, which is why the probe reads a row.
  //
  // Mandatory, not decoration: `runIntegrityChecks` iterates the WHOLE registry
  // after every synthetic apply, so a COLUMN_PROBES row with no file here fails
  // every test in this suite.
  //
  // ⭐ THE BODY IS THE REAL MIGRATION FILE, READ OFF DISK, not a copy of it. A
  // hand-transcribed fixture grades a duplicate: the real file could lose its
  // backfill (or its receipt) and every scenario here would stay green against
  // the transcript. Only the two pre-113 columns it reads are prefixed —
  // `callback_path`/`callback_delivered_at`/`completed_at`, which this fixture's
  // `approvals` (created by synthetic 101 above) does not carry.
  {
    name: '113_approval_callback_effect_marker.sql',
    body: `ALTER TABLE approvals
      ADD COLUMN IF NOT EXISTS callback_path         TEXT,
      ADD COLUMN IF NOT EXISTS callback_delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS completed_at          TIMESTAMPTZ;

    ${readFileSync(
      path.join(import.meta.dir, '../../../migrations/113_approval_callback_effect_marker.sql'),
      'utf8',
    )}`,
  },
  // One open gate per card (fr#1000). Probe: the migration's own receipt row.
  //
  // Mandatory, not decoration — same reason as 099/111/113 above: the post-run
  // integrity check iterates the WHOLE registry after every synthetic apply, so a
  // COLUMN_PROBES row with no file here fails every test in this suite.
  //
  // ⭐ THE BODY IS THE REAL MIGRATION, READ OFF DISK. A transcribed copy would let
  // the real file lose its void-DML or its index and leave this suite green against
  // the transcript — the defect 113's note names, and the reason its fixture does
  // the same. Only the columns this fixture's `approvals` lacks are prefixed:
  // synthetic 101 creates it with just id/status/expires_at + the triage columns,
  // and 114 reads tenant_id, card_id and created_at and writes the voided_* trio
  // that the real migration 110 introduces upstream of this range.
  {
    name: '114_approvals_one_open_gate_per_card.sql',
    body: `ALTER TABLE approvals
      ADD COLUMN IF NOT EXISTS tenant_id     UUID,
      ADD COLUMN IF NOT EXISTS card_id       TEXT,
      ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS voided_reason TEXT,
      ADD COLUMN IF NOT EXISTS voided_by     TEXT;

    ${readFileSync(
      path.join(import.meta.dir, '../../../migrations/114_approvals_one_open_gate_per_card.sql'),
      'utf8',
    )}`,
  },
  // Reverses 107's manufactured deadline on rows that are STILL PENDING. Probe:
  // the migration's own receipt row in `_migration_effects`.
  //
  // Mandatory, not decoration — same reason as 099/111/113/114 above: the
  // post-run integrity check iterates the WHOLE registry after every synthetic
  // apply, so a COLUMN_PROBES row with no file here fails every test in this
  // suite. That is exactly how this entry came to be written: adding 117's probe
  // without this fixture turned 13 of them red at once.
  //
  // ⭐ THE BODY IS THE REAL MIGRATION, READ OFF DISK, for the same reason 113 and
  // 114 do it: a transcribed copy would let the real file lose its `status`
  // guard — the one term this whole migration exists for — while this suite
  // stayed green against the transcript.
  //
  // Only the columns this fixture's `approvals` lacks are prefixed. Synthetic 101
  // creates it with id/status/expires_at + the triage columns and 114's fixture
  // adds the tenant/card/void trio; 117 additionally reads `metadata` and writes
  // `updated_at`. It needs no `_migration_effects` prefix — 117 creates that
  // table itself, guarded, precisely so a missing receipt table can never abort
  // the boot transaction.
  {
    name: '117_reverse_default_expiry_backfill.sql',
    body: `ALTER TABLE approvals
      ADD COLUMN IF NOT EXISTS metadata   JSONB,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    ${readFileSync(
      path.join(import.meta.dir, '../../../migrations/117_reverse_default_expiry_backfill.sql'),
      'utf8',
    )}`,
  },
  // Makes a token top-up un-double-creditable: UNIQUE (tenant_id,
  // idempotency_key). Probe: columnExists('budget_topups','idempotency_key').
  //
  // Mandatory for the same reason 117's comment above states outright — the
  // post-run integrity check iterates the WHOLE COLUMN_PROBES registry after
  // every synthetic apply, so a probe with no fixture here reds every test in
  // this suite. It did: adding 118's probe without this entry turned the same 13
  // red, exactly as 117 predicted it would for the next person.
  //
  // ⭐ THE BODY IS THE REAL MIGRATION, READ OFF DISK, as 113/114/117 do — a
  // transcribed copy would let the real file lose its backfill or its NOT NULL
  // (the two things that make the guarantee non-optional) while this suite stayed
  // green against the transcript.
  //
  // `budget_topups` has no earlier synthetic fixture, so the prefix creates the
  // minimum 118 touches: `id` for the 'legacy-<id>' backfill and `tenant_id` for
  // the unique index. Nothing else — the probe asserts one column.
  {
    name: '118_budget_topups_idempotency_key.sql',
    body: `CREATE TABLE IF NOT EXISTS budget_topups (
      id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL
    );

    ${readFileSync(
      path.join(import.meta.dir, '../../../migrations/118_budget_topups_idempotency_key.sql'),
      'utf8',
    )}`,
  },
  // Widens `approvals_callback_resolution_check` to admit the fifth terminal value,
  // `hold_acknowledged`. Probe: pg_get_constraintdef of that constraint contains the
  // new value — the DEFINITION, not the name, because the four-value constraint this
  // file replaces carries the same name.
  //
  // Mandatory, not decoration, and the reason is now on its fifth consecutive entry
  // (111/113/114/117/118 all say it): `runIntegrityChecks` iterates the WHOLE
  // COLUMN_PROBES registry after every synthetic apply, so a probe with no fixture
  // here reds every test in this suite. It did — 13 of them, with the message
  // "probe for '119_…' did not pass … is NOT recorded in _migrations", exactly as
  // 117 and 118 each predicted for the next person.
  //
  // ⭐ THE BODY IS THE REAL MIGRATION, READ OFF DISK, as 113/114/117/118 do. Here
  // that is load-bearing twice over: a transcribed copy would let the real file lose
  // its definition-comparing DO block (degrading to an IF NOT EXISTS (conname) guard
  // that leaves a four-value constraint standing) while this suite stayed green
  // against the transcript.
  //
  // ⛔ AND IT NEEDS NO PREFIX AT ALL, WHICH IS ITSELF THE PRECONDITION. 119 touches
  // exactly one object: the CHECK on `approvals.callback_resolution`. Both the column
  // and the four-value constraint are created upstream in this same list by synthetic
  // 113 — whose body is the real migration 113, lines 181 and 232-235 — so this
  // fixture exercises 119 against the very shape it exists to replace, rather than
  // against a hand-built approximation of it. If 113's fixture ever stops creating
  // them, this entry needs the prefix its siblings carry.
  {
    name: '119_approval_callback_hold_acknowledged.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/119_approval_callback_hold_acknowledged.sql'),
      'utf8',
    ),
  },

  // Adds `streams.project_id` — the fr project a stream's improvement work targets,
  // which the stream detector reads to mint a WORKABLE card. Probe:
  // columnExists('streams', 'project_id').
  //
  // Mandatory, not decoration, and the reason is now on its sixth consecutive entry
  // (111/113/114/117/118/119 all say it): `runIntegrityChecks` iterates the WHOLE
  // COLUMN_PROBES registry after every synthetic apply, so a probe with no fixture
  // here reds every test in this suite. It did — 13 of them, with the message
  // "probe for '120_…' did not pass … is NOT recorded in _migrations", exactly as
  // 117, 118 and 119 each predicted for the next person. CI run 34783097961.
  //
  // ⭐ THE BODY IS THE REAL MIGRATION, READ OFF DISK, as 113/114/117/118/119 do. Here
  // that is what makes the fixture worth having: 120's whole contract is "the column
  // is there", asserted against a `streams` table this file did not hand-build, so a
  // transcribed copy would let the real file lose the ADD COLUMN (or have it renamed,
  // or lose the FK's `projects` reference) while this suite stayed green against the
  // transcript.
  //
  // ⛔ AND IT NEEDS NO PREFIX, WHICH IS ITSELF THE PRECONDITION. 120 touches exactly
  // two objects and creates neither table: `streams` comes from synthetic 044 above
  // and `projects` from synthetic 001, so the real file's
  // `REFERENCES projects(id) ON DELETE SET NULL` resolves here for the same reason it
  // resolves in prod. If 044 ever stops creating `streams`, this entry needs the
  // CREATE-prefix its siblings carry.
  {
    name: '120_streams_project_id.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/120_streams_project_id.sql'),
      'utf8',
    ),
  },

  // Re-asserts the global andon singleton ROW that 065 inserts and a fresh
  // (push-built, backfill-stamped) database never gets. Probe: a CONJUNCTION of
  // the migration's own receipt in `_migration_effects` AND the row being present.
  //
  // Mandatory, not decoration, and the reason is now on its seventh consecutive
  // entry (111/113/114/117/118/119/120 all say it): `runIntegrityChecks` iterates
  // the WHOLE COLUMN_PROBES registry after every synthetic apply, so a probe with
  // no fixture here reds every test in this suite, not the one it describes.
  //
  // ⭐ THE BODY IS THE REAL MIGRATION, READ OFF DISK, as 113/114/117/118/119/120
  // do. Here it is load-bearing twice: a transcribed copy would let the real file
  // lose its `WHERE NOT EXISTS` guard (leaving a file that raises duplicate-key on
  // the second boot) or lose the INSERT while keeping the receipt (leaving a probe
  // that certifies a cord that is not there) while this suite stayed green against
  // the transcript.
  //
  // ⚠️ THE PREFIX CREATES `andon_state` AND MUST STAY, unlike 119/120's
  // prefix-less entries. No earlier synthetic fixture creates that table — the
  // real one comes from migration 065, which this synthetic history does not
  // model — and the real file deliberately does NOT create it (065 does; copying
  // 065's DDL would drag back the history trigger 085 dropped). Its `DO` block
  // therefore RAISEs on a table-less database, by design, which is exactly what
  // would happen here without this prefix.
  //
  // ⛔ THE PREFIX CREATES THE TABLE EMPTY, WITH NO ROW. Seeding the row here
  // would make the probe's row half pass before the file ran and leave the
  // INSERT — the entire point — unexercised by this suite.
  {
    name: '131_andon_singleton_reassert.sql',
    body: `CREATE TABLE IF NOT EXISTS andon_state (
      id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      engaged             BOOLEAN NOT NULL DEFAULT FALSE,
      engaged_at          TIMESTAMPTZ,
      engaged_by          TEXT,
      paused_workflow_ids JSONB,
      n8n_paused_at       TIMESTAMPTZ,
      n8n_pause_error     TEXT
    );

    ${readFileSync(
      path.join(import.meta.dir, '../../../migrations/131_andon_singleton_reassert.sql'),
      'utf8',
    )}`,
  },

  // 133 makes `repositories.name` NOT NULL and non-blank, and it has a
  // COLUMN_PROBES row. The post-run integrity check iterates the WHOLE registry
  // after every synthetic apply, so a probe with no fixture here fails EVERY
  // test in this suite with "probe for '133_…' did not pass … is NOT recorded in
  // _migrations" — which is exactly how CI caught its absence.
  //
  // ⚠️ THE PREFIX CREATES `repositories` WITH A NULLABLE `name`, AND MUST STAY.
  // No earlier synthetic fixture creates that table (the real one comes from
  // migration 072, which this synthetic history does not model), and the real
  // file deliberately does not create it. Without the prefix its DO blocks
  // resolve nothing and the probe can never pass.
  //
  // ⛔ THE COLUMN MUST BE NULLABLE HERE. Declaring it NOT NULL would make the
  // probe's first half pass BEFORE the file ran, leaving the ALTER — the entire
  // point — unexercised by this suite. Same trap as 131's empty-table note.
  //
  // The body is READ FROM THE REAL FILE rather than transcribed, so the file
  // cannot lose a statement while this suite stays green.
  {
    name: '133_repositories_name_required.sql',
    body: `CREATE TABLE IF NOT EXISTS repositories (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT,
      url        TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ${readFileSync(
      path.join(import.meta.dir, '../../../migrations/133_repositories_name_required.sql'),
      'utf8',
    )}`,
  },

  // #1104, migration 134: `approvals.callback_degraded_reads` /
  // `callback_degraded_first_at` plus the SIXTH value on
  // `approvals_callback_resolution_check`. Probe: both columns AND
  // `pg_get_constraintdef(...) LIKE '%read_degraded%'`.
  //
  // ⛔ NO PREFIX, AND THAT IS ITSELF THE PRECONDITION — exactly as on 119 above.
  // The `approvals` table, `callback_resolution` and the constraint are all created
  // upstream in this same list by synthetic 113 (whose body is the real migration
  // 113) and widened by synthetic 119, so this fixture exercises 134 against the
  // very FIVE-value shape it exists to replace rather than a hand-built
  // approximation. If either of those fixtures ever stops creating them, this entry
  // needs the prefix its siblings carry.
  {
    name: '134_approval_callback_read_degraded.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/134_approval_callback_read_degraded.sql'),
      'utf8',
    ),
  },

  // 135 creates `member_knowledge_areas` and has a COLUMN_PROBES row
  // (`tableExists('member_knowledge_areas')`). The post-run integrity check
  // iterates the WHOLE registry after every synthetic apply, so a probe with no
  // fixture here fails EVERY test in this suite with "probe for '135_…' did not
  // pass … is NOT recorded in _migrations" — which is exactly how CI caught its
  // absence.
  //
  // ⛔ NO PREFIX, AND UNLIKE 133/119 THAT IS NOT A PRECONDITION TO PRESERVE — it
  // is simply that the real file needs nothing. 135 is a self-contained
  // `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` with NO foreign
  // key (its header records the measurement behind that: 8 of 13 live tenants
  // have no `workspaces` row), so it resolves against an empty database.
  //
  // ⛔ NO EARLIER FIXTURE MAY CREATE `member_knowledge_areas`, and none does
  // (measured: 0 occurrences of the name in this file before this entry;
  // non-zero control on the same instrument: 49 for `approvals`). If one ever
  // did, `tableExists` would read TRUE before the file ran and this suite would
  // stop exercising the CREATE at all — the same trap 131's empty-table note
  // and 133's nullable-column note describe.
  //
  // The body is READ FROM THE REAL FILE rather than transcribed, so the file
  // cannot lose a statement while this suite stays green.
  {
    name: '135_member_knowledge_areas.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/135_member_knowledge_areas.sql'),
      'utf8',
    ),
  },

  // 137 renames the asset-assignment scope column `scope_level` -> `scope_kind`
  // (and the enum type `scope_level` -> `assignment_scope`), and it has a
  // COLUMN_PROBES row (`scope_kind` present, both old names absent). Mandatory
  // for the same reason as 133/135: the integrity check iterates the whole
  // registry.
  //
  // ⛔ NO PREFIX, AND THAT IS THE PRECONDITION: synthetic 111 above creates
  // `asset_assignments` with a `scope_level` column, so the probe reads FALSE
  // before this file runs and the column rename is genuinely exercised. This
  // synthetic history has no enum type, so the type half is the guarded no-op —
  // the path a push-built or pre-enum database takes.
  //
  // The body is READ FROM THE REAL FILE rather than transcribed.
  {
    name: '137_rename_assignment_scope.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/137_rename_assignment_scope.sql'),
      'utf8',
    ),
  },

  // 138 creates `wip_slot` and has a COLUMN_PROBES row
  // (`tableExists('wip_slot')`). Mandatory for the same reason as 135: the
  // post-run integrity check iterates the whole registry.
  //
  // ⛔ NO PREFIX, and none is needed: a self-contained CREATE TABLE + three
  // CREATE INDEX IF NOT EXISTS with no foreign key, so it resolves against an
  // empty database. No earlier fixture creates `wip_slot`, so the probe reads
  // FALSE before this file runs and the CREATE is genuinely exercised.
  //
  // The body is READ FROM THE REAL FILE rather than transcribed.
  {
    name: '138_wip_slot.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/138_wip_slot.sql'),
      'utf8',
    ),
  },

  // 140 creates `card_version_stamps` and has a COLUMN_PROBES row
  // (`tableExists('card_version_stamps')`). Mandatory for the same reason as
  // 135/138: the post-run integrity check iterates the whole registry.
  //
  // ⛔ NO PREFIX, and none is needed: its only dependency is the FK to
  // `projects(id)`, which synthetic 001 creates (uuid PK). No earlier fixture
  // creates `card_version_stamps`, so the probe reads FALSE before this file
  // runs and the CREATE is genuinely exercised.
  //
  // The body is READ FROM THE REAL FILE rather than transcribed.
  {
    name: '140_card_version_stamps.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/140_card_version_stamps.sql'),
      'utf8',
    ),
  },

  // 172 creates `card_phase_lease_waiter` and has a COLUMN_PROBES row
  // (`tableExists('card_phase_lease_waiter')`). Self-contained CREATE TABLE +
  // CREATE INDEX IF NOT EXISTS, no foreign key, so it resolves against an empty
  // database; no earlier fixture creates the table, so the probe reads FALSE
  // before this file runs and the CREATE is genuinely exercised.
  // The body is READ FROM THE REAL FILE rather than transcribed.
  {
    name: '172_card_phase_lease_waiter.sql',
    body: readFileSync(
      path.join(import.meta.dir, '../../../migrations/172_card_phase_lease_waiter.sql'),
      'utf8',
    ),
  },
];

// ---- lifecycle ------------------------------------------------------------

const DOCKER = dockerAvailable();
let MIGRATIONS_DIR = '';

// Best-effort cleanup if the test process is interrupted before afterAll runs
// (SIGINT from bail, CI runner cancel, bun internal timeout). Without this,
// the container survives and port stays bound for the next invocation.
if (DOCKER) {
  const bail = () => {
    try {
      stopContainer();
    } catch {
      // ignore
    }
  };
  process.once('SIGINT', bail);
  process.once('SIGTERM', bail);
  process.once('exit', bail);
}

// Docker image pull + PG ready can easily exceed 60s on a loaded machine
// (contention with the full `bun test tests/unit` run). Bun's default hook
// timeout is 5s; widen to 180s so a cold Docker cache + PG boot + migrations
// have real headroom.
beforeAll(async () => {
  if (!DOCKER) {
    console.warn('[migration-runner.test] docker unavailable — tests will be skipped');
    return;
  }
  const started = startContainer();
  if (!started.ok) {
    console.warn(`[migration-runner.test] docker run failed: ${started.reason}`);
    return;
  }
  await waitForPg();
  MIGRATIONS_DIR = await materializeMigrations(SYNTHETIC_MIGRATIONS);
}, 180_000);

// stopContainer() runs `docker rm -f` + a prefix-reap, which can exceed the
// default 5s hook timeout under CI load (saw 5.4s and 6.6s on arc-amd64
// runners 2026-05-15). Mirror the 180s ceiling that beforeAll uses.
afterAll(async () => {
  stopContainer();
  if (MIGRATIONS_DIR) {
    await rm(MIGRATIONS_DIR, { recursive: true, force: true }).catch(() => {});
  }
}, 180_000);

// ---- tests ----------------------------------------------------------------

const d = DOCKER ? describe : describe.skip;

d('migration-runner', () => {
  let sql: postgres.Sql | null = null;

  beforeEach(() => {
    sql = null;
  });

  async function open(url: string): Promise<postgres.Sql> {
    const s = postgres(url, { max: 2, onnotice: () => {} });
    sql = s;
    return s;
  }

  async function close(): Promise<void> {
    if (sql) {
      await sql.end({ timeout: 5 });
      sql = null;
    }
  }

  test('fresh DB: applies all synthetic migrations in order and records each', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    const applied = await s<{ filename: string }[]>`
      SELECT filename FROM _migrations ORDER BY filename
    `;
    expect(applied.map((r) => r.filename)).toEqual(
      SYNTHETIC_MIGRATIONS.map((m) => m.name),
    );

    const projectsColRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'planka_project_id'
    `;
    expect(projectsColRes[0]?.count).toBe(1);

    await close();
  });

  test('prod pre-fix scenario: backfills without re-running when projects already exists', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    // Simulate a prod DB where every migration has historically been applied,
    // but _migrations never existed. Include every probe target (operator
    // already added them manually) so the backfill path stamps everything
    // without applying.
    // Phase 2.G — pre-create card_drafts + agent_runtime_sessions WITH the
    // indexes the new probes assert on, so backfill can mark every
    // migration applied without the post-run integrity sweep failing.
    // This mirrors the prod path where drizzle-kit push created the
    // tables and an earlier hand-applied migration created the indexes.
    await s.unsafe(`
      CREATE TABLE projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'submitted',
        planka_project_id TEXT,
        dept_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE department_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dept_id UUID NOT NULL,
        user_id UUID NOT NULL
      );
      CREATE TABLE channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind TEXT NOT NULL
      );
      CREATE TABLE streams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_channels JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE suggested_schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id TEXT NOT NULL,
        project_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
      );
      CREATE TABLE scheduled_triggers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        from_suggestion_id UUID
      );
      CREATE TABLE card_drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL,
        producer TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE UNIQUE INDEX card_drafts_idempotency_unique_idx
        ON card_drafts (project_id, producer, (metadata->>'idempotency_key'))
        WHERE metadata ? 'idempotency_key';
      CREATE TABLE agent_runtime_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        channel TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX idx_agent_runtime_sessions_user_channel_thread
        ON agent_runtime_sessions (user_id, channel, thread_id);
      CREATE TABLE provisioning_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE project_repositories (
        project_id UUID NOT NULL,
        repo_id    UUID NOT NULL,
        is_primary BOOLEAN NOT NULL DEFAULT false,
        added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, repo_id)
      );
      CREATE TABLE notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    const applied = await s<{ filename: string }[]>`
      SELECT filename FROM _migrations ORDER BY filename
    `;
    expect(applied.length).toBe(SYNTHETIC_MIGRATIONS.length);

    // The runner must NOT have re-run 001_init — if it had, CREATE TABLE
    // projects would have errored before backfill finished.
    const projectsRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename='projects'
    `;
    expect(projectsRes[0]?.count).toBe(1);

    await close();
  });

  test('stale CI scenario: backfills 001-005, runs 006 to add missing planka_project_id', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    // Simulate a CI fr_ci DB where prior runs created `projects` but never
    // ran 006 (the column-add). Runner must self-heal: skip 006 in the
    // backfill, then RUN it to add the column.
    await s.unsafe(`
      CREATE TABLE projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL
      );
    `);

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    // All migrations must be marked applied after the heal.
    const applied = await s<{ filename: string }[]>`
      SELECT filename FROM _migrations ORDER BY filename
    `;
    expect(applied.length).toBe(SYNTHETIC_MIGRATIONS.length);

    // And the column must now exist.
    const colRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'planka_project_id'
    `;
    expect(colRes[0]?.count).toBe(1);

    // _migrations must exist (transaction committed).
    const migRes = await s<{ exists: boolean }[]>`
      SELECT to_regclass('public._migrations') IS NOT NULL AS exists
    `;
    expect(migRes[0]?.exists).toBe(true);

    await close();
  });

  test('partial: only applies files that are not already in _migrations', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    // Seed the state of a DB that has already applied 001-003.
    await s.unsafe(`
      CREATE TABLE _migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO _migrations (filename) VALUES
        ('001_init.sql'),
        ('002_description.sql'),
        ('003_status.sql');
      CREATE TABLE projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'submitted',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    const applied = await s<{ filename: string }[]>`
      SELECT filename FROM _migrations ORDER BY filename
    `;
    expect(applied.map((r) => r.filename)).toEqual(
      SYNTHETIC_MIGRATIONS.map((m) => m.name),
    );

    // 004-006 ran: tables/columns exist.
    const notesRes = await s<{ notes: boolean }[]>`
      SELECT to_regclass('public.notes') IS NOT NULL AS notes
    `;
    expect(notesRes[0]?.notes).toBe(true);

    await close();
  });

  test('fully-migrated DB: second run is a no-op', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });
    const firstRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM _migrations
    `;
    const first = firstRes[0]?.count ?? -1;

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });
    const secondRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM _migrations
    `;
    const second = secondRes[0]?.count ?? -1;

    expect(first).toBe(SYNTHETIC_MIGRATIONS.length);
    expect(second).toBe(first);

    await close();
  });

  test('corrupt SQL: rolls back transaction and throws with filename', async () => {
    const corruptDir = await materializeMigrations([
      { name: '001_ok.sql', body: 'CREATE TABLE ok (id INT);' },
      { name: '002_broken.sql', body: 'THIS IS NOT VALID SQL;' },
    ]);

    try {
      const { url } = await createFreshDb();
      const s = await open(url);

      let thrown: Error | null = null;
      try {
        await runMigrations(s, { migrationsDir: corruptDir });
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain('002_broken.sql');

      // Outer transaction rolled back — neither table nor _migrations rows exist.
      const okRes = await s<{ ok: boolean }[]>`
        SELECT to_regclass('public.ok') IS NOT NULL AS ok
      `;
      expect(okRes[0]?.ok).toBe(false);

      const migRes = await s<{ exists: boolean }[]>`
        SELECT to_regclass('public._migrations') IS NOT NULL AS exists
      `;
      expect(migRes[0]?.exists).toBe(false);

      await close();
    } finally {
      await rm(corruptDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('applyMigrations: opens and cleanly closes its own connection', async () => {
    const { url } = await createFreshDb();

    // No existing connection: applyMigrations must be self-contained.
    await applyMigrations(url, {
      migrationsDir: MIGRATIONS_DIR,
    });

    // Re-open just to verify state.
    const verify = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const rows = await verify<{ filename: string }[]>`
        SELECT filename FROM _migrations ORDER BY filename
      `;
      expect(rows.length).toBe(SYNTHETIC_MIGRATIONS.length);
    } finally {
      await verify.end({ timeout: 5 });
    }
  });

  // ---- probe-aware backfill regression tests (Spec 2 Plan 2-C Phase 0) ----
  //
  // The bug: only migration 006 had a self-heal probe. On every developer's
  // stale local DB and the persistent `fr_ci` DB on backup-host, migrations 026/027/
  // 030/040 got stamped applied without running, the column drops, and
  // every dept-RBAC-gated test rejected callers because loadProjectShape()
  // returned dept_id: null. The four tests below pin the probe-aware
  // backfill + post-run integrity check so this kind of silent schema drift
  // can never reach CI undetected again.

  test('probe: backfill leaves 026 in pending when projects.dept_id is missing', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    // Stale-CI shape: projects exists from a prior run but predates 026.
    // 027/030/040 targets are also missing — those probes should also skip,
    // but the assertion here is specifically about 026 self-healing.
    await s.unsafe(`
      CREATE TABLE projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        planka_project_id TEXT
      );
    `);

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    // 026 must have actually applied (not been silently stamped) — the
    // column it adds must now exist on the seeded projects table.
    const colRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'dept_id'
    `;
    expect(colRes[0]?.count).toBe(1);

    // And 026 ends up in _migrations exactly once.
    const migRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM _migrations
      WHERE filename = '026_workspaces_and_departments.sql'
    `;
    expect(migRes[0]?.count).toBe(1);

    await close();
  });

  test('probe: backfill stamps 026 without re-running when projects.dept_id is present', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    // Operator-managed prod shape: every probe target already present.
    await s.unsafe(`
      CREATE TABLE projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        planka_project_id TEXT,
        dept_id UUID
      );
      CREATE TABLE department_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dept_id UUID NOT NULL,
        user_id UUID NOT NULL
      );
      CREATE TABLE channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind TEXT NOT NULL
      );
      CREATE TABLE streams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_channels JSONB NOT NULL DEFAULT '[]'::jsonb
      );
      CREATE TABLE suggested_schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id TEXT NOT NULL,
        project_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
      );
      CREATE TABLE scheduled_triggers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        from_suggestion_id UUID,
        -- 094's probe target. This seed's contract is "EVERY probe target
        -- already present" — omitting it would silently move this test onto
        -- the self-heal path (094 left pending, apply loop runs it) and stop
        -- it testing the stamp-without-re-running behaviour it is named for.
        permanent_failure_count INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT
      );
    `);

    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    // 026 is stamped applied without re-running — if it had re-run, the
    // `ALTER TABLE projects ADD COLUMN dept_id UUID` body would have errored
    // on duplicate column. No throw == backfill correctly skipped re-apply.
    const migRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM _migrations
      WHERE filename = '026_workspaces_and_departments.sql'
    `;
    expect(migRes[0]?.count).toBe(1);

    // dept_id remains exactly once on projects (no duplicate-add side effect).
    const colRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'dept_id'
    `;
    expect(colRes[0]?.count).toBe(1);

    await close();
  });

  test('probe: post-run integrity check throws when 026 file does not add the column', async () => {
    // Simulate a 026 file whose body claims to add dept_id but doesn't —
    // this is the "silent drift" the integrity check exists to catch.
    const lyingDir = await materializeMigrations([
      // Minimal subset — only what's needed to drive the integrity check.
      // 026 here is a no-op SELECT. Backfill won't apply because we seed
      // projects without dept_id (probe leaves 026 in pending), then the
      // apply loop runs the no-op 026, then the post-run probe still
      // sees dept_id missing → throw.
      {
        name: '001_init.sql',
        body: `CREATE TABLE projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          planka_project_id TEXT
        );`,
      },
      {
        name: '006_projects_planka_project_id.sql',
        body: `SELECT 1;`, // already exists from 001
      },
      {
        name: '026_workspaces_and_departments.sql',
        body: `SELECT 1; -- lying: claims to add dept_id, doesn't`,
      },
      {
        name: '027_dept_member_roles.sql',
        body: `CREATE TABLE department_members (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          dept_id UUID NOT NULL,
          user_id UUID NOT NULL
        );`,
      },
      {
        name: '034_channels_registry.sql',
        body: `CREATE TABLE channels (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          kind TEXT NOT NULL
        );`,
      },
      {
        name: '044_streams_notification_channels.sql',
        body: `CREATE TABLE streams (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          notification_channels JSONB NOT NULL DEFAULT '[]'::jsonb
        );`,
      },
      {
        name: '045_spec_2_continuous_flow.sql',
        body: `CREATE TABLE scheduled_triggers (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL
        );`,
      },
      {
        name: '049_suggested_schedules.sql',
        body: `CREATE TABLE suggested_schedules (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id TEXT NOT NULL,
          project_id UUID NOT NULL,
          status TEXT NOT NULL DEFAULT 'new'
        );`,
      },
      {
        name: '051_scheduled_triggers_from_suggestion.sql',
        body: `ALTER TABLE scheduled_triggers ADD COLUMN from_suggestion_id UUID;`,
      },
      // Phase 2.G — keep the lying test passing under the new probes.
      // These two add the index-creating migrations whose probes now
      // sit alongside 026's; the 026 lie still fails first because
      // COLUMN_PROBES iterates in registration order (026 is earlier
      // in the array than 020/025) and runIntegrityChecks throws on
      // the first miss.
      {
        name: '020_bridge_idempotency_unique_idx.sql',
        body: `CREATE TABLE card_drafts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID NOT NULL,
          producer TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE UNIQUE INDEX card_drafts_idempotency_unique_idx
          ON card_drafts (project_id, producer, (metadata->>'idempotency_key'))
          WHERE metadata ? 'idempotency_key';`,
      },
      {
        name: '025_agent_runtime_sessions.sql',
        body: `CREATE TABLE agent_runtime_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          channel TEXT NOT NULL,
          thread_id TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX idx_agent_runtime_sessions_user_channel_thread
          ON agent_runtime_sessions (user_id, channel, thread_id);`,
      },
      {
        name: '056_provisioning_audit.sql',
        body: `CREATE TABLE provisioning_audit (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          actor_user_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_email TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );`,
      },
    ]);

    try {
      const { url } = await createFreshDb();
      const s = await open(url);

      let thrown: Error | null = null;
      try {
        await runMigrations(s, { migrationsDir: lyingDir });
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain('post-run integrity check failed');
      expect(thrown?.message).toContain('026_workspaces_and_departments.sql');
      expect(thrown?.message).toContain('reconcile');
      // ⭐ PINS THE EXACT SHAPE THE CHECK EXISTS FOR, not merely "it threw".
      // 026 is in the set under consideration, the apply loop RAN it, so it is
      // STAMPED in `_migrations` — and its probed effect is still absent. That
      // triple is the regression: a migration the runner believes it applied
      // whose effect is missing, which is unrecoverable without an operator
      // because the apply loop will skip the file on every future boot. Added
      // 2026-09-30 alongside the `probesInScope` scoping in the runner, so that
      // scoping a probe out of a run it cannot witness can never be widened
      // into skipping a probe it CAN — this assertion goes red if it is.
      expect(thrown?.message).toContain('IS RECORDED IN _migrations');

      await close();
    } finally {
      await rm(lyingDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('probe: post-run integrity check passes on a fresh DB after full apply', async () => {
    const { url } = await createFreshDb();
    const s = await open(url);

    // Fresh DB: every migration applies, every probe target lands.
    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    // No throw means the post-apply integrity loop accepted every probe.
    // Spot-check the four newly-probed targets.
    const deptIdRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'dept_id'
    `;
    expect(deptIdRes[0]?.count).toBe(1);

    const tablesRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('department_members', 'channels', 'streams', 'suggested_schedules', 'scheduled_triggers')
    `;
    expect(tablesRes[0]?.count).toBe(5);

    const notifColRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'streams'
        AND column_name = 'notification_channels'
    `;
    expect(notifColRes[0]?.count).toBe(1);

    // Probe 047: scheduled_triggers.from_suggestion_id (Plan 2-D Phase 8).
    const fromSuggestionColRes = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'scheduled_triggers'
        AND column_name = 'from_suggestion_id'
    `;
    expect(fromSuggestionColRes[0]?.count).toBe(1);

    await close();
  });

  // Migration 111 recreates the two partial unique indexes migration 030 already
  // created — UNDER THE SAME TWO NAMES — adding `workspace_id` as the leading key
  // column. That shared naming is what makes the stamp-not-apply hazard live here:
  // on a DB with an empty `_migrations` and a pre-existing `projects` (CI's
  // drizzle-kit-push bootstrap, and prod), the backfill stamps every migration
  // WITHOUT a probe applied without running it, and an `indexExists` probe would
  // pass under the tenant-BLIND 030 shape just as happily as under the fixed one —
  // stamping 111 against a database that still lets the first workspace to see an
  // asset claim it for the whole estate. Before this test the migration half of
  // PR #974 had ZERO coverage: the six route tests passed off the index that
  // `drizzle-kit push` builds from schema.ts, and passed with the .sql deleted.
  //
  // So the claim under test is not "111 ran" but "the probe can TELL THE TWO
  // SHAPES APART": seeded with 030's indexes it must leave 111 pending and the
  // apply loop must rewrite both indexes. The pre-run assertions are the
  // non-vacuity witness — both index NAMES already present (indexExists would
  // have passed), zero of them workspace_id-leading.
  //
  // The migrations dir is the usual synthetic set with 111's body swapped for the
  // REAL file read off backend/migrations, so this cannot pass by grading a copy.
  test('migration 111 is applied, not stamped, when the tenant-blind 030 indexes are present', async () => {
    const real111 = await readFile(path.join(REAL_MIGRATIONS_DIR, MIGRATION_111), 'utf8');
    const realDir = await materializeMigrations(
      SYNTHETIC_MIGRATIONS.map((m) =>
        m.name === MIGRATION_111 ? { name: m.name, body: real111 } : m,
      ),
    );

    try {
      const { url } = await createFreshDb();
      const s = await open(url);

      // 030's shape verbatim: both partial unique indexes, NEITHER carrying the
      // tenant key. `projects` puts the runner on the backfill branch, and
      // `_migrations` does not exist yet, so it is created EMPTY — the exact
      // pre-condition (`applied.size === 0 && projectsExists`) under which a
      // probe-less migration gets stamped.
      await s.unsafe(`
        CREATE TABLE projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL
        );
        CREATE TABLE asset_assignments (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id UUID NOT NULL,
          asset_type   TEXT NOT NULL,
          asset_id     TEXT NOT NULL,
          scope_level  TEXT NOT NULL,
          target_id    TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX asset_assignments_uq_workspace
          ON asset_assignments (asset_type, asset_id, scope_level)
          WHERE target_id IS NULL;
        CREATE UNIQUE INDEX asset_assignments_uq_with_target
          ON asset_assignments (asset_type, asset_id, scope_level, target_id)
          WHERE target_id IS NOT NULL;
      `);

      // Non-vacuity, half one: both index NAMES are already there. A name-only
      // `indexExists` probe would have returned true and stamped 111.
      const namesBefore = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'asset_assignments'
          AND indexname IN ('asset_assignments_uq_workspace', 'asset_assignments_uq_with_target')
      `;
      expect(namesBefore[0]?.count).toBe(2);

      // Non-vacuity, half two: the probe's actual target — a workspace_id-leading
      // key — is ABSENT. This is what distinguishes the 030 shape from the 111 one.
      const leadingBefore = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'asset_assignments'
          AND indexname IN ('asset_assignments_uq_workspace', 'asset_assignments_uq_with_target')
          AND indexdef LIKE '%(workspace_id,%'
      `;
      expect(leadingBefore[0]?.count).toBe(0);

      await runMigrations(s, { migrationsDir: realDir });

      // 111 is tracked exactly once...
      const migRes = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM _migrations WHERE filename = ${MIGRATION_111}
      `;
      expect(migRes[0]?.count).toBe(1);

      // ...and it was APPLIED, not stamped: had the backfill stamped it, both
      // indexes would still be the 030 shape seeded above. Assert on the
      // definitions, per index, so a single rewritten index cannot pass.
      const defs = await s<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'asset_assignments'
          AND indexname IN ('asset_assignments_uq_workspace', 'asset_assignments_uq_with_target')
        ORDER BY indexname
      `;
      expect(defs.map((r) => r.indexname)).toEqual([
        'asset_assignments_uq_with_target',
        'asset_assignments_uq_workspace',
      ]);
      for (const row of defs) {
        expect(row.indexdef).toContain('(workspace_id,');
      }

      // Both partial predicates survive the recreate — they are the reason 030
      // needed two indexes at all (Postgres treats NULLs as distinct), so a
      // rewrite that dropped them would not constrain the workspace-scope rows.
      const withTarget = defs.find((r) => r.indexname === 'asset_assignments_uq_with_target');
      const workspace = defs.find((r) => r.indexname === 'asset_assignments_uq_workspace');
      expect(workspace?.indexdef).toContain('WHERE (target_id IS NULL)');
      expect(withTarget?.indexdef).toContain('WHERE (target_id IS NOT NULL)');

      await close();
    } finally {
      await rm(realDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('bootstrap-rename: remaps OLD filenames in _migrations to NEW names without re-running SQL', async () => {
    // Pre-renumbering, the apply set contained `026_streams.sql`,
    // `028_canary_rollback_events.sql`, `030_channels_registry.sql`, etc.
    // Live DBs still have those rows in `_migrations`; the disk has the
    // renumbered names. The bootstrap-rename guard in runMigrations must
    // rewrite the tracker rows in place so the apply loop sees a fully-
    // applied schema and never re-runs (which would CREATE TABLE on
    // already-existing objects and fail).
    const { url } = await createFreshDb();
    const s = await open(url);

    // Apply the synthetic schema first so the probe targets exist and the
    // post-run integrity loop passes after the rename.
    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    // Now back-rewrite the renamed rows in place so the tracker matches
    // what a live pre-renumbering DB carries (new names removed, old names
    // present). The non-renamed rows (001/005/006/020/025/026/027) stay
    // under their unchanged names. We extra-INSERT the four old-name rows
    // that have no synthetic counterpart (026_streams etc.) so the
    // guard's probe of `026_streams.sql` fires; the bootstrap-rename
    // happily UPDATEs them to new names that also have no synthetic
    // disk file — that's fine, the apply loop will treat those new
    // names as "applied" and skip both.
    await s`UPDATE _migrations SET filename = '030_channels_registry.sql'             WHERE filename = '034_channels_registry.sql'`;
    await s`UPDATE _migrations SET filename = '040_streams_notification_channels.sql' WHERE filename = '044_streams_notification_channels.sql'`;
    await s`UPDATE _migrations SET filename = '041_spec_2_continuous_flow.sql'        WHERE filename = '045_spec_2_continuous_flow.sql'`;
    await s`UPDATE _migrations SET filename = '045_suggested_schedules.sql'           WHERE filename = '049_suggested_schedules.sql'`;
    await s`UPDATE _migrations SET filename = '047_scheduled_triggers_from_suggestion.sql' WHERE filename = '051_scheduled_triggers_from_suggestion.sql'`;
    await s`UPDATE _migrations SET filename = '052_provisioning_audit.sql'            WHERE filename = '056_provisioning_audit.sql'`;
    await s`UPDATE _migrations SET filename = '055_streams_kind_tenant_aware.sql'     WHERE filename = '059_streams_kind_tenant_aware.sql'`;
    await s`INSERT INTO _migrations (filename) VALUES
      ('026_streams.sql'),
      ('027_streams_canary_enabled.sql'),
      ('028_canary_rollback_events.sql')
    `;

    // Sanity: the old names are now present in the tracker.
    const oldBefore = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM _migrations WHERE filename = '026_streams.sql'
    `;
    expect(oldBefore[0]?.count).toBe(1);

    // Second runMigrations call: the bootstrap-rename guard fires (sees
    // '026_streams.sql' in tracker), remaps every old row, then the apply
    // loop sees zero pending work and returns.
    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    // Every old name has been rewritten.
    const oldAfter = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM _migrations
      WHERE filename IN (
        '026_streams.sql',
        '027_streams_canary_enabled.sql',
        '028_canary_rollback_events.sql',
        '030_channels_registry.sql',
        '040_streams_notification_channels.sql',
        '052_provisioning_audit.sql',
        '055_streams_kind_tenant_aware.sql'
      )
    `;
    expect(oldAfter[0]?.count).toBe(0);

    // The new names landed in the tracker.
    const newAfter = await s<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM _migrations
      WHERE filename IN (
        '017_streams.sql',
        '028_streams_canary_enabled.sql',
        '031_canary_rollback_events.sql',
        '034_channels_registry.sql',
        '044_streams_notification_channels.sql',
        '056_provisioning_audit.sql',
        '059_streams_kind_tenant_aware.sql'
      )
    `;
    expect(newAfter[0]?.count).toBe(7);

    // Third call must be a clean no-op (guard sees no old names → skips).
    await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

    await close();
  });

  // ==========================================================================
  // ⭐ reapplyIfProbeFails — THE ONLY PATH IN THE RUNNER THAT DELETES A
  //    `_migrations` ROW AND RE-EXECUTES SQL AGAINST A LIVE DATABASE.
  // ==========================================================================
  //
  // Two tests, and the SECOND is the load-bearing one.
  //
  // The flag is generic: it is a field on `Probe`, any probe may carry it, and
  // the runner's own 3am error message (migration-runner.ts, `runIntegrityChecks`)
  // INSTRUCTS an operator to set it on a wedged migration. So the property that
  // matters is not only "the opt-in re-runs" but "the ABSENCE of the opt-in does
  // NOT re-run" — a scoping bug there silently re-executes arbitrary, possibly
  // non-idempotent, migrations against production, which is the data-loss event
  // the flag's own doc comment warns about.
  //
  // Both tests build the REAL wedge rather than asserting on a boolean: a
  // database whose `_migrations` row was written by an EARLIER DRAFT of the
  // file, so the apply loop skips it forever and the corrective logic inside it
  // is unreachable by construction.

  test(
    'self-heal: an OPTED-IN migration stamped by an earlier draft is un-stamped, ' +
      're-run, and its DATA effect lands',
    async () => {
      const { url } = await createFreshDb();
      const s = await open(url);

      // A fully-migrated database: every synthetic file applied, every probe true.
      await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

      // ---- rewind 113 to exactly what an EARLIER DRAFT of the file left ----
      // The draft shipped a THREE-value CHECK list and had no receipt table at
      // all. It APPLIED CLEANLY, so `_migrations` keeps its 113 row — that row
      // is the wedge, not a corruption.
      await s.unsafe(`
        DROP TABLE _migration_effects;
        ALTER TABLE approvals DROP CONSTRAINT approvals_callback_resolution_check;
        ALTER TABLE approvals
          ADD CONSTRAINT approvals_callback_resolution_check
          CHECK (callback_resolution IS NULL
                 OR callback_resolution IN ('moved', 'not_blocked', 'card_unreadable'));
        UPDATE approvals SET callback_acked_at = NULL;
        INSERT INTO approvals (callback_path, callback_delivered_at)
          VALUES ('/webhook/decision', now() - interval '3 hours');
      `);

      // ---- non-vacuity: this is the wedge, and it is armed ----
      // (i) 113 IS stamped, so the apply loop will SKIP it. Without the
      //     self-heal loop there is no other way for the file to run.
      const stampedBefore = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM _migrations WHERE filename = ${MIGRATION_113}
      `;
      expect(stampedBefore[0]?.count).toBe(1);

      // (ii) the registered probe reads FALSE — the receipt is gone with its table.
      const probe113 = probeForMigration(MIGRATION_113)!;
      expect(typeof probe113).toBe('function');
      expect(await probe113(s)).toBe(false);

      // (iii) the constraint is the STALE three-value one: a 'send_exhausted'
      //       write is REJECTED right now. This is the runtime damage the
      //       unreachable DO block exists to repair.
      const staleDef = await s<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
         WHERE c.conname = 'approvals_callback_resolution_check'
           AND c.conrelid = 'approvals'::regclass
      `;
      expect(staleDef[0]?.def).not.toContain('send_exhausted');

      // (iv) there is a row the backfill must actually MOVE.
      const pendingBackfill = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM approvals
         WHERE callback_delivered_at IS NOT NULL AND callback_acked_at IS NULL
      `;
      expect(pendingBackfill[0]?.count).toBe(1);

      // ---- the act: an ordinary boot ----
      // ⭐ MUTANT: delete the `reapplyIfProbeFails` self-heal loop in
      // src/db/migration-runner.ts and this LINE throws — 113 stays stamped, the
      // apply loop skips it, and `runIntegrityChecks` hard-fails on its probe.
      await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

      // ---- the file RAN: its data effect landed ----
      // The receipt exists at all, which `drizzle-kit push` can never produce...
      expect(await probe113(s)).toBe(true);

      // ...and it is the receipt written by THIS re-run's backfill, counting the
      // one row that was waiting. `count(*)` on the table would not distinguish a
      // hand-inserted marker from an executed UPDATE; the count does.
      const receipt = await s<{ detail: { backfilled_rows: number } }[]>`
        SELECT detail FROM _migration_effects WHERE migration = ${MIGRATION_113}
      `;
      expect(receipt.length).toBe(1);
      expect(Number(receipt[0]!.detail.backfilled_rows)).toBe(1);

      // The UPDATE itself, not just its receipt.
      const backfilled = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM approvals
         WHERE callback_acked_at IS NOT NULL
           AND callback_acked_at = callback_delivered_at
      `;
      expect(backfilled[0]?.count).toBe(1);

      // The corrective DO block — the thing that was unreachable — ran: the
      // constraint is the FOUR-value one, so 'send_exhausted' is writable again.
      const healedDef = await s<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def
          FROM pg_constraint c
         WHERE c.conname = 'approvals_callback_resolution_check'
           AND c.conrelid = 'approvals'::regclass
      `;
      expect(healedDef[0]?.def).toContain('send_exhausted');
      await s.unsafe(
        `UPDATE approvals SET callback_resolution = 'send_exhausted'
          WHERE callback_path = '/webhook/decision'`,
      );

      // Re-stamped exactly once — un-stamp + re-apply, not a duplicate row.
      const stampedAfter = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM _migrations WHERE filename = ${MIGRATION_113}
      `;
      expect(stampedAfter[0]?.count).toBe(1);

      await close();
    },
  );

  test(
    'self-heal is SCOPED TO THE OPT-IN: a migration without reapplyIfProbeFails ' +
      'is NOT un-stamped — the run throws and the schema is left alone',
    async () => {
      const { url } = await createFreshDb();
      const s = await open(url);

      await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });

      // ---- the SAME wedge, on a migration that did NOT opt in ----
      // 111 stays stamped while its probed target is rewound to the tenant-blind
      // 030 shape — byte-for-byte the situation test one repairs, differing in
      // exactly one thing: no `reapplyIfProbeFails` on 111's probe.
      // The column is `scope_kind` here, not 030's `scope_level`: the full run
      // above already applied 137, which renamed it.
      await s.unsafe(`
        DROP INDEX asset_assignments_uq_workspace;
        DROP INDEX asset_assignments_uq_with_target;
        CREATE UNIQUE INDEX asset_assignments_uq_workspace
          ON asset_assignments (asset_type, asset_id, scope_kind)
          WHERE target_id IS NULL;
        CREATE UNIQUE INDEX asset_assignments_uq_with_target
          ON asset_assignments (asset_type, asset_id, scope_kind, target_id)
          WHERE target_id IS NOT NULL;
      `);

      // Non-vacuity: stamped, and its probe reads FALSE — same arming as above.
      const stampedBefore = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM _migrations WHERE filename = ${MIGRATION_111}
      `;
      expect(stampedBefore[0]?.count).toBe(1);
      const probe111 = probeForMigration(MIGRATION_111)!;
      expect(await probe111(s)).toBe(false);

      // ---- the act ----
      // ⭐ MUTANT: delete `if (!probe.reapplyIfProbeFails) continue;` from the
      // self-heal loop so it fires for ANY failing probe. 111 is then un-stamped
      // and re-run, the indexes are rebuilt workspace_id-first, nothing throws —
      // and every assertion below goes RED.
      let thrown: Error | null = null;
      try {
        await runMigrations(s, { migrationsDir: MIGRATIONS_DIR });
      } catch (err) {
        thrown = err as Error;
      }

      // It REFUSED rather than repaired.
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toContain('post-run integrity check failed');
      expect(thrown?.message).toContain(MIGRATION_111);
      // ...and it refused down the STAMPED branch of the message, which is the
      // one that hands the operator the `reapplyIfProbeFails` remedy. A run that
      // had silently un-stamped 111 could not print this.
      expect(thrown?.message).toContain('IS RECORDED IN _migrations');
      // 'IS RECORDED IN _migrations' is shared with the OPTED-IN branch, so it
      // alone cannot tell the two apart; 'SKIPPED it' is printed ONLY by the
      // stamped-and-not-opted-in branch. Without it, a regression that routed
      // 111 into the opted-in message would still pass.
      expect(thrown?.message).toContain('SKIPPED it');

      // Still stamped: the runner did not touch the tracker row.
      const stampedAfter = await s<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM _migrations WHERE filename = ${MIGRATION_111}
      `;
      expect(stampedAfter[0]?.count).toBe(1);

      // ⭐ AND THE FILE WAS NOT RE-EXECUTED. This is the assertion that carries
      // the property: 111's SQL rebuilds both indexes workspace_id-first, so if
      // it had re-run they would carry the tenant key. They do not.
      const defs = await s<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'asset_assignments'
          AND indexname IN ('asset_assignments_uq_workspace', 'asset_assignments_uq_with_target')
        ORDER BY indexname
      `;
      expect(defs.length).toBe(2);
      for (const row of defs) {
        expect(row.indexdef).not.toContain('(workspace_id,');
      }

      await close();
    },
  );

  // ==========================================================================
  // 185 — the project_phase / project_type vocabulary CHECKs are DROPPED
  // (design: fr consumes RM vocabulary). 165/166 are no longer probed (a presence
  // probe would re-create what 185 drops); 185 is probed for ABSENCE and opts into
  // `reapplyIfProbeFails`.
  // ==========================================================================
  //
  // Narrow migration set: a `projects` with the three columns the two CHECKs
  // read, plus the REAL 165/166/185 files read off disk.

  const PROJECTS_FOR_185 = {
    name: '001_projects_for_185.sql',
    body: `CREATE TABLE projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT NOT NULL DEFAULT 'active',
      project_phase TEXT,
      project_type TEXT
    );`,
  };
  const M165 = '165_project_phase_check.sql';
  const M166 = '166_project_type_check.sql';
  const M185 = '185_drop_project_vocabulary_checks.sql';
  const realBody = (f: string): string => readFileSync(path.join(REAL_MIGRATIONS_DIR, f), 'utf8');
  const vocabCheckCount = async (s: postgres.Sql): Promise<number> =>
    (
      await s<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_constraint
         WHERE conrelid = 'projects'::regclass
           AND conname IN ('projects_project_phase_check', 'projects_project_type_check')
      `
    )[0]!.n;
  const plantTypeCheck = (s: postgres.Sql) =>
    s.unsafe(`ALTER TABLE projects ADD CONSTRAINT projects_project_type_check
      CHECK (project_type IS NULL OR project_type IN ('it') OR status IN ('archived', 'cancelled'))`);

  test(
    '185: 165 + 166 + 185 on a fresh DB leave NEITHER CHECK; a re-planted one is self-healed away',
    async () => {
      const dir = await materializeMigrations([
        PROJECTS_FOR_185,
        { name: M165, body: realBody(M165) },
        { name: M166, body: realBody(M166) },
        { name: M185, body: realBody(M185) },
      ]);
      try {
        const { url } = await createFreshDb();
        const s = await open(url);
        await runMigrations(s, { migrationsDir: dir });
        const stamped = await s<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM _migrations WHERE filename IN (${M165}, ${M166}, ${M185})
        `;
        expect(stamped[0]?.count).toBe(3);
        expect(await vocabCheckCount(s)).toBe(0);
        expect(await probeForMigration(M185)!(s)).toBe(true);
        expect(probeForMigration(M165)).toBeUndefined();
        expect(probeForMigration(M166)).toBeUndefined();

        // A database that still carries one (e.g. re-created by hand): the probe
        // reads FALSE, the self-heal re-runs 185, and the boot succeeds clean.
        await plantTypeCheck(s);
        expect(await probeForMigration(M185)!(s)).toBe(false);
        await runMigrations(s, { migrationsDir: dir });
        expect(await vocabCheckCount(s)).toBe(0);
        // An RM-only name is now storable.
        await s`INSERT INTO projects (status, project_phase, project_type) VALUES ('active', 'scope_v3', 'bug_hunt_fix')`;
        await close();
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  test(
    'integrity message: an OPTED-IN 185 that re-ran and still fails is NOT reported as "SKIPPED"',
    async () => {
      // A broken 185 (drops nothing): its re-run over a planted CHECK is a no-op.
      const dir = await materializeMigrations([
        PROJECTS_FOR_185,
        { name: M185, body: 'SELECT 1;' },
      ]);
      try {
        const { url } = await createFreshDb();
        const s = await open(url);
        await runMigrations(s, { migrationsDir: dir });
        await plantTypeCheck(s);

        let thrown: Error | null = null;
        try {
          await runMigrations(s, { migrationsDir: dir });
        } catch (err) {
          thrown = err as Error;
        }
        expect(thrown).not.toBeNull();
        expect(thrown?.message).toContain('post-run integrity check failed');
        expect(thrown?.message).toContain(M185);
        expect(thrown?.message).toContain('IS RECORDED IN _migrations');
        expect(thrown?.message).toContain('it was NOT skipped');
        expect(thrown?.message).not.toContain('SKIPPED it');
        await close();
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

});

// ---- COLUMN_PROBES registry -----------------------------------------------
//
// ⭐ THIS IS THE PRICE OF THE SCOPING IN `runMigrations`, PAID HERE INSTEAD.
//
// The runner used to fail at boot if any registered probe's target was missing,
// whatever set it was handed. That caught a genuine registry defect as a side
// effect: a probe naming a migration file that does not exist (a typo, a
// renumber via scripts/renumber-migrations.sh, a deleted migration) read as
// "target missing" and threw. Scoping the check to the discovered set removes
// that, because an absent file is now indistinguishable from "not in this set".
//
// A registry defect is a source defect, so CI is the right place to find it —
// not a 3am boot. If this test fails, either fix the `migration:` string in
// COLUMN_PROBES (src/db/migration-runner.ts) or delete the probe; do NOT relax
// the assertion, and do NOT restore whole-registry iteration in the runner.
//
// No Docker: it reads source and a directory listing, so it runs everywhere.
describe('COLUMN_PROBES registry', () => {
  test('every registered probe names a migration file that exists on disk', () => {
    const probed = parseProbedMigrations(
      readFileSync(path.join(import.meta.dir, '../../../src/db/migration-runner.ts'), 'utf8'),
    );

    // Broken-instrument control: the parser is a regex over source. If it ever
    // stops matching, `probed` is empty and every assertion below passes
    // vacuously. Non-zero only — the number of probes grows with the registry.
    expect(probed.size).toBeGreaterThan(0);

    const onDisk = new Set(
      readdirSync(REAL_MIGRATIONS_DIR).filter((n) => /^\d{3,}_.*\.sql$/.test(n)),
    );
    // Positive control: the listing found real migrations, so a miss below means
    // the probe is wrong rather than the directory unreadable.
    expect(onDisk.size).toBeGreaterThanOrEqual(probed.size);

    const missing = [...probed].filter((name) => !onDisk.has(name)).sort();
    expect(missing).toEqual([]);
  });
});
