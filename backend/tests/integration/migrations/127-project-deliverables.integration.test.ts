// tests/integration/migrations/127-project-deliverables.integration.test.ts
//
// Migration 127 stores the scope a human APPROVED on an outline, so promotion
// stops dropping it. What has to hold:
//   * `kind` admits ONLY 'deliverable' | 'intermediate' — 'epic' is a 23514;
//   * deleting a project CASCADES its deliverables and milestones away;
//   * deleting an OUTLINE nulls `source_outline_id` and the deliverable SURVIVES;
//   * UNIQUE (project_id, position) rejects a duplicate position inside one
//     project and permits the same position in a different one;
//   * schema.ts and the .sql do not DISAGREE about the kind CHECK.
//
// ── WHY EVERY BEHAVIOURAL TEST RUNS TWICE ────────────────────────────────────
//
// ⛔ THE SHAPE HAS TWO EMITTERS AND THIS SUITE MUST MEASURE BOTH. MEASURED on
// this tree, on a freshly bootstrapped Postgres 18 (drizzle-kit push → ci-seed →
// bun run migrate): `_migrations` holds `127_project_deliverables.sql` with an
// `applied_at`, and the file's SQL NEVER EXECUTED — the runner stamps a DDL-only
// migration applied when the ledger is empty and `projects` already exists
// (src/db/migration-runner.ts). So `public.project_deliverables` in CI is the
// output of schema.ts, and a test that only touches `public` says NOTHING about
// the .sql a real database actually runs. The reverse is equally true for a
// migration-built prod DB.
//
// So each behavioural test runs against both arms:
//   `public`   — whatever built THIS database (drizzle-kit push from schema.ts in
//                CI and in the container this was verified on);
//   `sql-file` — a throwaway schema into which 127's SQL is executed verbatim.
//
// ⭐ The mechanic the sql-file arm depends on, verified empirically before it was
// written: `CREATE TABLE IF NOT EXISTS project_deliverables` under
// `search_path = <tmp>, public` creates the table in <tmp> even though
// `public.project_deliverables` already exists — IF NOT EXISTS is scoped to the
// CREATION schema, not to the search path. The unqualified `ALTER TABLE projects`
// in the same file resolves the other way (no `projects` in <tmp>) and lands on
// public.projects, where the column already exists, so it is a skipped no-op.
//
// ⚠️ FK constraint NAMES differ between the emitters by construction — drizzle
// emits `project_deliverables_project_id_projects_id_fk`, Postgres's inline
// REFERENCES emits `project_deliverables_project_id_fkey`. Nothing here keys on a
// FK name; delete semantics are asserted BEHAVIOURALLY, which is what a CASCADE
// means anyway.
//
// ── ONE sql.begin() THAT ALWAYS ROLLS BACK ───────────────────────────────────
//
// Same discipline as the 124 test: the database is shared, so every fixture, the
// throwaway schema, and the migration's own DDL are undone by forcing a rollback
// with a sentinel throw (postgres.js COMMITS a callback that returns normally).
// A statement that is EXPECTED to fail runs inside `tx.savepoint()` — a raw error
// would abort the whole transaction (25P02) and every later assertion in the same
// test would fail for the wrong reason. Bind parameters are explicitly cast
// (42P18 in CI otherwise; see the 117 test).

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';

const MIGRATION_PATH = '../../../migrations/127_project_deliverables.sql';
const SCHEMA_TS_PATH = '../../../src/db/schema.ts';

const MIGRATION = readFileSync(join(import.meta.dir, MIGRATION_PATH), 'utf8');
const SCHEMA_TS = readFileSync(join(import.meta.dir, SCHEMA_TS_PATH), 'utf8');

const KIND_CHECK = 'project_deliverables_kind_check';
/** The closed vocabulary, as the migration header states it. */
const ACCEPTED_KINDS = ['deliverable', 'intermediate'];
/** The concrete near-miss the CHECK exists to refuse. */
const REJECTED_KIND = 'epic';

const TAG = `mig127-${process.pid}-${Date.now()}`;
const TENANT = '00000000-0000-4000-8000-0000127b0001';
const OWNER = '00000000-0000-4000-8000-0000127b0010';

class Rollback extends Error {}

type Tx = postgres.TransactionSql<Record<string, never>>;

// ── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = (): string => `${TAG}-${(seq += 1)}`;

async function seedProject(tx: Tx): Promise<string> {
  const rows = (await tx.unsafe(
    `INSERT INTO public.projects (owner_id, name, repository_url)
     VALUES ($1::uuid, $2::text, $3::text)
     RETURNING id`,
    [OWNER, `${uniq()}-project`, 'https://github.com/nonagenticai/fr'],
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}

/** A request + one outline on it; returns the outline id. */
async function seedOutline(tx: Tx): Promise<string> {
  const req = (await tx.unsafe(
    `INSERT INTO public.project_requests
       (tenant_id, source, external_ref, payload, status, history, created_by)
     VALUES ($1::uuid, 'fr', $2::text, '{}'::jsonb, 'approved', '[]'::jsonb, $3::uuid)
     RETURNING id`,
    [TENANT, `${uniq()}-request`, OWNER],
  )) as unknown as { id: string }[];
  const outline = (await tx.unsafe(
    `INSERT INTO public.project_outlines (request_id, version, status)
     VALUES ($1::uuid, 1, 'approved')
     RETURNING id`,
    [req[0]!.id],
  )) as unknown as { id: string }[];
  return outline[0]!.id;
}

interface DeliverableFixture {
  projectId: string;
  position: number;
  kind?: string;
  outlineId?: string | null;
}

async function insertDeliverable(
  tx: Tx,
  schema: string,
  { projectId, position, kind = 'deliverable', outlineId = null }: DeliverableFixture,
): Promise<string> {
  const rows = (await tx.unsafe(
    `INSERT INTO ${schema}.project_deliverables
       (project_id, source_outline_id, position, kind, title, acceptance_criteria)
     VALUES ($1::uuid, $2::uuid, $3::int, $4::text, $5::text, $6::jsonb)
     RETURNING id`,
    [projectId, outlineId, position, kind, `${uniq()}-title`, '["a criterion"]'],
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}

async function insertMilestone(
  tx: Tx,
  schema: string,
  projectId: string,
  position: number,
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO ${schema}.project_milestones (project_id, position, name, target_date)
     VALUES ($1::uuid, $2::int, $3::text, NULL)`,
    [projectId, position, `${uniq()}-milestone`],
  );
}

async function countFor(tx: Tx, schema: string, table: string, projectId: string): Promise<number> {
  const rows = (await tx.unsafe(
    `SELECT count(*)::int AS n FROM ${schema}.${table} WHERE project_id = $1::uuid`,
    [projectId],
  )) as unknown as { n: number }[];
  return rows[0]!.n;
}

/**
 * Run a statement that is EXPECTED to fail, without poisoning the transaction.
 * Returns the SQLSTATE, or undefined when it unexpectedly SUCCEEDED — which is
 * the RED state for every caller below.
 */
async function sqlstateOf(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<string | undefined> {
  try {
    await tx.savepoint(async (sp) => {
      await fn(sp as unknown as Tx);
    });
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? `NO_SQLSTATE:${(err as Error).message}`;
  }
}

// ── the two emitters ────────────────────────────────────────────────────────

interface Arm {
  label: string;
  /** Returns the schema holding the tables under test. */
  prepare: (tx: Tx) => Promise<string>;
}

const ARMS: Arm[] = [
  {
    label: 'public (built by whatever built this DB — drizzle-kit push/schema.ts in CI)',
    prepare: async () => 'public',
  },
  {
    label: 'sql-file (127_project_deliverables.sql executed verbatim into a temp schema)',
    prepare: async (tx) => {
      // Schema name is per-transaction; everything is rolled back regardless.
      const schema = `mig127_${process.pid}_${(seq += 1)}`;
      await tx.unsafe(`CREATE SCHEMA ${schema}`);
      await tx.unsafe(`SET LOCAL search_path TO ${schema}, public`);
      await tx.unsafe(MIGRATION);
      // Back to public so every statement below is unambiguous; the tables are
      // referenced schema-qualified anyway.
      await tx.unsafe(`SET LOCAL search_path TO public`);
      // The arm is worthless if the migration silently created nothing here.
      const rows = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1::text AND c.relkind = 'r'
            AND c.relname IN ('project_deliverables', 'project_milestones')`,
        [schema],
      )) as unknown as { n: number }[];
      expect(rows[0]!.n).toBe(2);
      return schema;
    },
  },
];

/** One forced-rollback transaction per test, with the arm prepared inside it. */
async function inArm(arm: Arm, body: (tx: Tx, schema: string) => Promise<void>): Promise<void> {
  let failure: unknown;
  try {
    await sql.begin(async (tx) => {
      const schema = await arm.prepare(tx as unknown as Tx);
      await body(tx as unknown as Tx, schema);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) failure = err;
  }
  if (failure) throw failure;
}

for (const arm of ARMS) {
  test(`127 [${arm.label}] kind admits only deliverable|intermediate — 'epic' is a 23514`, async () => {
    await inArm(arm, async (tx, schema) => {
      const projectId = await seedProject(tx);

      // POSITIVE CONTROL. Both legal kinds must actually INSERT, or the
      // rejection below would be satisfied by a broken fixture (a missing
      // column, a NOT NULL, the wrong schema) and prove nothing about `kind`.
      let position = 0;
      for (const kind of ACCEPTED_KINDS) {
        position += 1;
        const id = await insertDeliverable(tx, schema, { projectId, position, kind });
        expect(id).toBeTruthy();
      }
      expect(await countFor(tx, schema, 'project_deliverables', projectId)).toBe(
        ACCEPTED_KINDS.length,
      );

      const code = await sqlstateOf(tx, (sp) =>
        insertDeliverable(sp, schema, { projectId, position: 99, kind: REJECTED_KIND }),
      );
      // 23514 = check_violation, pinned deliberately (the reason db-invariants
      // gives): a bare "it threw" would also be satisfied by a NOT NULL, a type
      // error or a duplicate key, none of which say the kind CHECK is in force.
      expect(code).toBe('23514');
      // …and the row did not land.
      expect(await countFor(tx, schema, 'project_deliverables', projectId)).toBe(
        ACCEPTED_KINDS.length,
      );
    });
  });

  test(`127 [${arm.label}] deleting a project CASCADES its deliverables and milestones`, async () => {
    await inArm(arm, async (tx, schema) => {
      const doomed = await seedProject(tx);
      const bystander = await seedProject(tx);

      await insertDeliverable(tx, schema, { projectId: doomed, position: 1 });
      await insertDeliverable(tx, schema, {
        projectId: doomed,
        position: 2,
        kind: 'intermediate',
      });
      await insertMilestone(tx, schema, doomed, 1);
      await insertDeliverable(tx, schema, { projectId: bystander, position: 1 });
      await insertMilestone(tx, schema, bystander, 1);

      // Positive control: the rows exist BEFORE the delete, so "0 afterwards"
      // is the cascade and not an insert that never happened.
      expect(await countFor(tx, schema, 'project_deliverables', doomed)).toBe(2);
      expect(await countFor(tx, schema, 'project_milestones', doomed)).toBe(1);

      await tx.unsafe(`DELETE FROM public.projects WHERE id = $1::uuid`, [doomed]);

      expect(await countFor(tx, schema, 'project_deliverables', doomed)).toBe(0);
      expect(await countFor(tx, schema, 'project_milestones', doomed)).toBe(0);
      // NEGATIVE CONTROL: the cascade is scoped to the deleted project. A
      // "cascade" that took everything would satisfy the two assertions above.
      expect(await countFor(tx, schema, 'project_deliverables', bystander)).toBe(1);
      expect(await countFor(tx, schema, 'project_milestones', bystander)).toBe(1);
    });
  });

  test(`127 [${arm.label}] deleting an outline NULLs source_outline_id and the deliverable SURVIVES`, async () => {
    await inArm(arm, async (tx, schema) => {
      const projectId = await seedProject(tx);
      const outlineId = await seedOutline(tx);
      const deliverableId = await insertDeliverable(tx, schema, {
        projectId,
        position: 1,
        outlineId,
      });

      const before = (await tx.unsafe(
        `SELECT source_outline_id::text AS source_outline_id
           FROM ${schema}.project_deliverables WHERE id = $1::uuid`,
        [deliverableId],
      )) as unknown as { source_outline_id: string | null }[];
      // Positive control: provenance was actually stored, so a NULL below is
      // the SET NULL firing and not a column that was never written.
      expect(before[0]?.source_outline_id).toBe(outlineId);

      await tx.unsafe(`DELETE FROM public.project_outlines WHERE id = $1::uuid`, [outlineId]);

      const after = (await tx.unsafe(
        `SELECT source_outline_id::text AS source_outline_id, title
           FROM ${schema}.project_deliverables WHERE id = $1::uuid`,
        [deliverableId],
      )) as unknown as { source_outline_id: string | null; title: string }[];
      // THE ROW SURVIVES — this is the assertion a CASCADE on this FK would
      // break, and the whole reason the column is SET NULL.
      expect(after.length).toBe(1);
      expect(after[0]!.source_outline_id).toBeNull();
      // Still the approved scope, not a husk.
      expect(after[0]!.title).toContain(TAG);
      expect(await countFor(tx, schema, 'project_deliverables', projectId)).toBe(1);
    });
  });

  test(`127 [${arm.label}] UNIQUE(project_id, position) is per-project, not global`, async () => {
    await inArm(arm, async (tx, schema) => {
      const a = await seedProject(tx);
      const b = await seedProject(tx);

      await insertDeliverable(tx, schema, { projectId: a, position: 1 });

      const dup = await sqlstateOf(tx, (sp) =>
        insertDeliverable(sp, schema, { projectId: a, position: 1, kind: 'intermediate' }),
      );
      // 23505 = unique_violation. Pinned, not `toThrow()`.
      expect(dup).toBe('23505');
      expect(await countFor(tx, schema, 'project_deliverables', a)).toBe(1);

      // …and position 1 in ANOTHER project is fine. This is what stops the
      // constraint from being "fixed" into a global UNIQUE (position).
      const id = await insertDeliverable(tx, schema, { projectId: b, position: 1 });
      expect(id).toBeTruthy();
      expect(await countFor(tx, schema, 'project_deliverables', b)).toBe(1);
    });
  });
}

// ── the two-emitter drift detector ──────────────────────────────────────────
//
// Reuses the mechanism tests/integration/services/db-invariants.integration.test.ts
// established — compare `pg_get_constraintdef`, because Postgres canonicalises
// both spellings (`kind IN (...)` from either emitter becomes
// `CHECK ((kind = ANY (ARRAY['deliverable'::text, 'intermediate'::text])))`), so
// equality is about the ACCEPTED SET and not about text style.
//
// ⚠️ THE DIFFERENCE FROM db-invariants, AND WHY: that file pins each constraint
// against a STRING LITERAL captured by hand from the SQL migration. A literal
// cannot notice a change made to BOTH files, and it rots. Here the two emitters
// are compared against EACH OTHER inside one transaction, so neither file is the
// authority and a one-sided edit in EITHER direction is RED.
//
// ⚠️ HONESTY BOUND: on a database whose `public` was built by RUNNING the .sql
// (prod), this arm compares the .sql with itself and is vacuous. It is meaningful
// exactly where the drift ships — a drizzle-push DB, which is CI. The emitter is
// detectable from the FK naming (drizzle's `..._projects_id_fk` vs Postgres's
// `..._fkey`), so the test says which situation it is in instead of quietly
// claiming a parity proof it did not make. The static test below covers BOTH
// environments and needs no database at all.

test(`127 the ${KIND_CHECK} constraint is IDENTICAL as emitted by schema.ts and by the .sql`, async () => {
  await inArm(ARMS[1]!, async (tx, sqlFileSchema) => {
    const defs = (await tx.unsafe(
      `SELECT n.nspname::text AS schema, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.conname = $1::text
          AND t.relname = 'project_deliverables'
          AND n.nspname IN ('public', $2::text)`,
      [KIND_CHECK, sqlFileSchema],
    )) as unknown as { schema: string; def: string }[];

    const fromSqlFile = defs.find((d) => d.schema === sqlFileSchema)?.def;
    const fromSchemaTs = defs.find((d) => d.schema === 'public')?.def;

    // Either side MISSING is the loudest form of drift: schema.ts without the
    // table-level check() is a CI database that silently accepts 'epic'.
    expect(fromSqlFile).toBeTruthy();
    expect(fromSchemaTs).toBeTruthy();
    expect(fromSqlFile).toContain('deliverable');

    const fkRows = (await tx.unsafe(
      `SELECT c.conname::text AS conname FROM pg_constraint c
         WHERE c.conrelid = 'public.project_deliverables'::regclass AND c.contype = 'f'
           AND c.conname LIKE '%project_id%'`,
    )) as unknown as { conname: string }[];
    const publicFromPush = fkRows.some((r) => r.conname.endsWith('_projects_id_fk'));
    if (!publicFromPush) {
      console.warn(
        '[127 drift] public.project_deliverables was NOT built by drizzle-kit push ' +
          `(FK names: ${fkRows.map((r) => r.conname).join(', ') || 'none'}). This ` +
          'assertion is comparing the .sql with itself and proves nothing about ' +
          'schema.ts in THIS environment — the static drift test does.',
      );
    }

    expect(fromSchemaTs).toBe(fromSqlFile!);
  });
});

test(`127 schema.ts and the .sql declare the SAME accepted kinds (static, no database)`, async () => {
  // .sql:      CONSTRAINT project_deliverables_kind_check
  //              CHECK (kind IN ('deliverable', 'intermediate'))
  // schema.ts: check('project_deliverables_kind_check',
  //              sql`${t.kind} IN ('deliverable', 'intermediate')`)
  //
  // ⚠️ The constraint name appears in PROSE in both files too (a COMMENT ON
  // COLUMN in the .sql, a header comment in schema.ts), so each pattern is
  // anchored on what FOLLOWS the name — `CHECK (` / `sql\`` — not on the name
  // alone. A pattern that matched nothing would yield an empty set and pass
  // against another empty set, so both sets are asserted non-empty and the
  // rejected kind is asserted ABSENT: the three together cannot be satisfied
  // vacuously.
  const sqlMatch = new RegExp(`CONSTRAINT\\s+${KIND_CHECK}\\s*\\n?\\s*CHECK\\s*\\(([^;]*?)\\)\\s*\\n`).exec(
    MIGRATION,
  );
  const tsMatch = new RegExp(`'${KIND_CHECK}',\\s*\\n?\\s*sql\`([^\`]*)\``).exec(SCHEMA_TS);

  expect(sqlMatch).not.toBeNull();
  expect(tsMatch).not.toBeNull();

  const literals = (expr: string): string[] =>
    [...expr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();

  const fromSql = literals(sqlMatch![1]!);
  const fromTs = literals(tsMatch![1]!);

  expect(fromSql.length).toBeGreaterThanOrEqual(2);
  expect(fromTs.length).toBeGreaterThanOrEqual(2);
  expect(fromSql).toEqual([...ACCEPTED_KINDS].sort());
  expect(fromTs).toEqual(fromSql);
  expect(fromTs).not.toContain(REJECTED_KIND);
});
