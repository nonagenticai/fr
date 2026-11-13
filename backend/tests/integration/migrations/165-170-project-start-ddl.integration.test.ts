// tests/integration/migrations/165-170-project-start-ddl.integration.test.ts
//
// EXECUTES migrations 165-170 against a real Postgres and proves each file lands
// the SAME shape schema.ts does — on prod-shaped data, twice.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// ⛔ CI NEVER RUNS THESE FILES OTHERWISE. CI builds its database with
// `drizzle-kit push` (schema.ts) and then `bun run migrate`, which finds an
// empty `_migrations` ledger over an existing `projects` table and STAMPS every
// probe-satisfied DDL file applied WITHOUT EXECUTING IT
// (src/db/migration-runner.ts, backfill path). So `public.projects` in CI is the
// output of schema.ts, and every DB test in the tranche measures schema.ts —
// never the .sql that prod's runner actually executes at boot.
//
// The concrete loss that hides: 166's CHECK admits archived/cancelled rows and
// NULL. Prod HAS an archived `project_type = 'analysis'` row and archived NULL
// rows (measured 2026-10-08, see the 166 header). Drop the exemption from the
// .sql and ADD CONSTRAINT fails validation on prod's own rows ⇒ `[FATAL] Schema
// migration failed` ⇒ crashloop, with CI green, because CI never ran the file.
//
// ── WHAT EACH CASE DOES ──────────────────────────────────────────────────────
//
//   1. snapshot the push-built shape (pg_get_constraintdef of every named CHECK
//      the file creates; data_type / default / nullability of every column);
//   2. assert the registered runner probe reads TRUE on it;
//   3. DROP that state (constraints, then columns);
//   4. assert the probe now reads FALSE (so the backfill would keep the file
//      pending rather than stamp it over a missing shape);
//   5. seed prod-shaped rows where the file validates existing data;
//   6. EXECUTE the .sql file — TWICE (the runner's `reapplyIfProbeFails`
//      self-heal and a by-hand replay both depend on idempotency);
//   7. assert the shape now EQUALS the push-built snapshot, and the probe is TRUE.
//
// Equality of `pg_get_constraintdef` is what pins the arms a behavioural insert
// cannot: Postgres passes a CHECK whose expression is NULL, so dropping 166's
// `project_type IS NULL OR` arm changes NO insert outcome — only the definition.
//
// ⚠️ EVERY CASE RUNS INSIDE ONE `sql.begin()` THAT IS ALWAYS ROLLED BACK (the
// 124/127/133 discipline). The DDL here takes ACCESS EXCLUSIVE locks on
// projects / project_outlines / project_deliverables / project_requests for the
// life of the transaction and releases them at ROLLBACK; nothing commits.

import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

import { queryClient as sql } from '../../../src/db/client';
import { probeForMigration } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('165-170-project-start-ddl');

class Rollback extends Error {}

const TAG = `mig165-${process.pid}-${Date.now()}`;
const OWNER = '0195f48b-1165-7000-8000-00000001c170';
const TENANT = '0195f48b-1165-7000-8000-00000002c170';

async function rolledBack(fn: (tx: postgres.Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as postgres.Sql);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

function readMigration(file: string): string {
  return readFileSync(join(import.meta.dir, '../../../migrations', file), 'utf8');
}

// ── shape snapshot ──────────────────────────────────────────────────────────

interface Spec {
  file: string;
  /** [table, constraint name] — every named CHECK the file creates. */
  constraints: Array<[string, string]>;
  /** [table, column] — every column the file adds. */
  columns: Array<[string, string]>;
}

// ⛔ 165 + 166 (the project_phase / project_type vocabulary CHECKs) are NOT here
// any more: migration 185 drops both and schema.ts no longer declares them (design:
// fr consumes RM vocabulary). Their executed-and-dropped proof was the
// project-vocabulary-checks integration suite, deleted 2026-10-29 under the
// no-test-doubles ruling — it is no longer in the suite.
const SPECS: Spec[] = [
  {
    file: '167_project_outline_phase_plan.sql',
    constraints: [
      ['project_outlines', 'project_outlines_phase_plan_pair_check'],
      ['project_outlines', 'project_outlines_phase_plan_hash_hex'],
    ],
    columns: [
      ['project_outlines', 'phase_plan'],
      ['project_outlines', 'phase_plan_hash'],
    ],
  },
  {
    file: '168_project_template.sql',
    constraints: [['projects', 'projects_template_pair_check']],
    columns: [
      ['projects', 'template_id'],
      ['projects', 'template_hash'],
    ],
  },
  {
    file: '169_project_deliverables_minting.sql',
    constraints: [['project_deliverables', 'project_deliverables_minting_check']],
    columns: [
      ['project_deliverables', 'deferred'],
      ['project_deliverables', 'minter'],
      ['project_deliverables', 'minted_at'],
      ['project_deliverables', 'minted_count'],
    ],
  },
  {
    file: '170_project_request_bits.sql',
    constraints: [['project_requests', 'project_requests_request_bits_object_check']],
    columns: [['project_requests', 'request_bits']],
  },
  {
    // fr#1481 (U-PS-PHASEEXIT): the row → plan-deliverable join. Same proof:
    // the .sql must land the push-built CHECK + UNIQUE byte-identically.
    file: '171_project_deliverables_plan_id.sql',
    constraints: [
      ['project_deliverables', 'project_deliverables_plan_deliverable_id_check'],
      ['project_deliverables', 'project_deliverables_project_plan_deliverable_unique'],
    ],
    columns: [['project_deliverables', 'plan_deliverable_id']],
  },
];

interface Shape {
  constraints: Record<string, string | null>;
  columns: Record<string, { type: string; default: string | null; nullable: string } | null>;
}

async function snapshot(tx: postgres.Sql, spec: Spec): Promise<Shape> {
  const shape: Shape = { constraints: {}, columns: {} };
  for (const [table, name] of spec.constraints) {
    const rows = await tx<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class     t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname = ${table} AND c.conname = ${name}
    `;
    shape.constraints[`${table}.${name}`] = rows[0]?.def ?? null;
  }
  for (const [table, column] of spec.columns) {
    const rows = await tx<{ type: string; default: string | null; nullable: string }[]>`
      SELECT data_type AS type, column_default AS default, is_nullable AS nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    `;
    shape.columns[`${table}.${column}`] = rows[0] ?? null;
  }
  return shape;
}

/** Remove what the file creates, so executing the file is what restores it. */
async function dropState(tx: postgres.Sql, spec: Spec): Promise<void> {
  for (const [table, name] of spec.constraints) {
    await tx.unsafe(`ALTER TABLE public.${table} DROP CONSTRAINT ${name}`);
  }
  for (const [table, column] of spec.columns) {
    await tx.unsafe(`ALTER TABLE public.${table} DROP COLUMN ${column}`);
  }
}

// ── prod-shaped fixtures ────────────────────────────────────────────────────

let seq = 0;
const uniq = (): string => `${TAG}-${(seq += 1)}`;

/**
 * A prod-shaped row population (worker4, BEGIN READ ONLY,
 * 2026-10-08): archived NULL ×2, archived 'analysis' (the retired value),
 * archived 'feature', one live row per in-use active type, the NULL-typed
 * `pending` pre-approval row — spread over the four phases prod actually holds.
 */
const PROD_SHAPED_PROJECTS: Array<{ status: string; type: string | null; phase: string }> = [
  { status: 'archived', type: null, phase: 'request' },
  { status: 'archived', type: null, phase: 'contract' },
  { status: 'archived', type: 'analysis', phase: 'preliminary_analysis' },
  { status: 'archived', type: 'feature', phase: 'deep_analysis' },
  { status: 'active', type: 'it', phase: 'request' },
  { status: 'active', type: 'kaizen', phase: 'contract' },
  { status: 'active', type: 'meta_prompt', phase: 'preliminary_analysis' },
  { status: 'active', type: 'meta_procedure', phase: 'deep_analysis' },
  { status: 'active', type: 'system_ops', phase: 'request' },
  { status: 'pending', type: null, phase: 'request' },
];

async function seedProdShapedProjects(tx: postgres.Sql): Promise<void> {
  for (const row of PROD_SHAPED_PROJECTS) {
    await tx.unsafe(
      `INSERT INTO public.projects (owner_id, name, repository_url, status, project_phase, project_type)
       VALUES ($1::uuid, $2::text, '', $3::text, $4::text, $5::text)`,
      [OWNER, uniq(), row.status, row.phase, row.type],
    );
  }
}


async function seedRequest(tx: postgres.Sql): Promise<string> {
  const rows = (await tx.unsafe(
    `INSERT INTO public.project_requests
       (tenant_id, source, external_ref, payload, status, history, created_by)
     VALUES ($1::uuid, 'fr', $2::text, '{}'::jsonb, 'approved', '[]'::jsonb, $3::uuid)
     RETURNING id`,
    [TENANT, uniq(), OWNER],
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}

async function seedOutline(tx: postgres.Sql): Promise<string> {
  const requestId = await seedRequest(tx);
  const rows = (await tx.unsafe(
    `INSERT INTO public.project_outlines (request_id, version, status)
     VALUES ($1::uuid, 1, 'approved') RETURNING id`,
    [requestId],
  )) as unknown as { id: string }[];
  return rows[0]!.id;
}

/** A deliverable that exists BEFORE 169 adds its columns (169's NOT NULL DEFAULT must backfill it). */
async function seedLegacyDeliverable(tx: postgres.Sql): Promise<string> {
  const p = (await tx.unsafe(
    `INSERT INTO public.projects (owner_id, name, repository_url)
     VALUES ($1::uuid, $2::text, '') RETURNING id`,
    [OWNER, uniq()],
  )) as unknown as { id: string }[];
  const d = (await tx.unsafe(
    `INSERT INTO public.project_deliverables
       (project_id, position, kind, title, acceptance_criteria)
     VALUES ($1::uuid, 0, 'deliverable', $2::text, '["a criterion"]'::jsonb)
     RETURNING id`,
    [p[0]!.id, uniq()],
  )) as unknown as { id: string }[];
  return d[0]!.id;
}

// ── the generic execute-the-file proof ──────────────────────────────────────

async function executeAndCompare(
  tx: postgres.Sql,
  spec: Spec,
  seed?: (tx: postgres.Sql) => Promise<void>,
): Promise<void> {
  const probe = probeForMigration(spec.file);
  expect(typeof probe).toBe('function');

  const pushed = await snapshot(tx, spec);
  // Guard against a vacuous equality (null === null): push MUST have built it.
  for (const [k, v] of Object.entries(pushed.constraints)) expect({ k, v }).not.toEqual({ k, v: null });
  for (const [k, v] of Object.entries(pushed.columns)) expect({ k, v }).not.toEqual({ k, v: null });
  expect(await probe!(tx)).toBe(true);

  await dropState(tx, spec);
  expect(await probe!(tx)).toBe(false);

  if (seed) await seed(tx);

  const body = readMigration(spec.file);
  await tx.unsafe(body);
  await tx.unsafe(body); // idempotent replay

  expect(await snapshot(tx, spec)).toEqual(pushed);
  expect(await probe!(tx)).toBe(true);
}

describe('migrations 167-171 EXECUTED (not stamped) land the schema.ts shape', () => {
  for (const spec of SPECS) {
    itDb(`${spec.file}: drop → execute ×2 → constraintdef/columns equal schema.ts, probe FALSE→TRUE`, async () => {
      await rolledBack(async (tx) => {
        await executeAndCompare(tx, spec);
      });
    });
  }
});

describe('167-170 on rows that predate the columns', () => {
  itDb('167: an existing outline reads phase_plan/phase_plan_hash NULL after the file', async () => {
    await rolledBack(async (tx) => {
      let outlineId = '';
      await executeAndCompare(tx, SPECS[0]!, async (t) => {
        outlineId = await seedOutline(t);
      });
      const rows = await tx<{ plan: unknown; hash: string | null }[]>`
        SELECT phase_plan AS plan, phase_plan_hash AS hash
          FROM public.project_outlines WHERE id = ${outlineId}::uuid
      `;
      expect([...rows]).toEqual([{ plan: null, hash: null }]);
    });
  });

  itDb('168: an existing project reads template_id/template_hash NULL after the file', async () => {
    await rolledBack(async (tx) => {
      await executeAndCompare(tx, SPECS[1]!, seedProdShapedProjects);
      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.projects
         WHERE owner_id = ${OWNER}::uuid AND template_id IS NULL AND template_hash IS NULL
      `;
      expect(rows[0]!.n).toBe(PROD_SHAPED_PROJECTS.length);
    });
  });

  itDb('169: an existing deliverable is backfilled deferred=false with NULL minter/minted_*', async () => {
    await rolledBack(async (tx) => {
      let did = '';
      await executeAndCompare(tx, SPECS[2]!, async (t) => {
        did = await seedLegacyDeliverable(t);
      });
      const rows = await tx<
        { deferred: boolean; minter: string | null; minted_at: Date | null; minted_count: number | null }[]
      >`
        SELECT deferred, minter, minted_at, minted_count
          FROM public.project_deliverables WHERE id = ${did}::uuid
      `;
      expect([...rows]).toEqual([{ deferred: false, minter: null, minted_at: null, minted_count: null }]);
    });
  });

  itDb('170: an existing request reads request_bits NULL after the file', async () => {
    await rolledBack(async (tx) => {
      let rid = '';
      await executeAndCompare(tx, SPECS[3]!, async (t) => {
        rid = await seedRequest(t);
      });
      const rows = await tx<{ bits: unknown }[]>`
        SELECT request_bits AS bits FROM public.project_requests WHERE id = ${rid}::uuid
      `;
      expect([...rows]).toEqual([{ bits: null }]);
    });
  });
});

