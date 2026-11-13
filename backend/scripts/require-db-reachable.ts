#!/usr/bin/env bun
// backend/scripts/require-db-reachable.ts
//
// PRECONDITION gate. Run this immediately BEFORE any `bun test` line that
// collects database-backed tests; run the tests only if it exits 0.
//
// Why a separate script instead of a preload throw
// ------------------------------------------------
// A top-level `throw` inside a `[test] preload` file does produce exit 1, but
// it does NOT abort the other collected files — Bun keeps loading and running
// them, so the failure is buried under thousands of lines of unrelated output
// and (worse) the run still executes tests against a database that isn't
// there. A standalone script gives CI a hard, single-line stop with a readable
// reason, before a single test module is loaded.
//
// This is one half of a two-part guarantee:
//
//   * THIS script proves the database is THERE and MIGRATED.
//   * `tests/setup-db-guard.ts` (armed with FR_TEST_REQUIRE_DB=1) proves the
//     tests actually TOUCHED it — a body that early-returns without asserting
//     fails instead of reporting "N pass, 0 expect() calls".
//
// Neither alone is sufficient. A reachable database still lets the
// `if (!reachable) return;` idiom fake-pass if its own probe happens to fail;
// an assertion requirement without a reachability check turns a dead container
// into 100 confusing per-test failures instead of one clear message.
//
// Exit codes: 0 = OK, 1 = not usable (with the reason on stderr).

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

/** Same shape the migration runner uses: `NNN_whatever.sql`, 3+ leading digits. */
const MIGRATION_FILE_RE = /^(\d{3,})_.*\.sql$/;

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '..', 'migrations');

function die(msg: string): never {
  console.error(`[require-db-reachable] FAIL: ${msg}`);
  process.exit(1);
}

/**
 * Strip credentials from a connection string before it is printed.
 *
 * Same approach as `tests/integration/helpers/db-suite.ts` — the userinfo
 * segment between `//` and `@` is the only place postgres URLs carry a
 * password, and CI logs are world-readable on a public runner.
 */
export function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

/**
 * The migration this checkout expects to be the newest, by the same numeric
 * ordering `src/db/migration-runner.ts` applies them in. Deliberately NOT
 * alphabetical: `100_x.sql` sorts before `099_x.sql` as a string, which would
 * make this gate silently stop tightening at three digits.
 */
export function newestMigration(filenames: ReadonlyArray<string>): string | null {
  let best: { name: string; order: number } | null = null;
  for (const name of filenames) {
    const match = MIGRATION_FILE_RE.exec(name);
    if (!match) continue;
    const order = Number.parseInt(match[1]!, 10);
    if (!best || order > best.order || (order === best.order && name.localeCompare(best.name) > 0)) {
      best = { name, order };
    }
  }
  return best?.name ?? null;
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  die(
    'DATABASE_URL is not set. This script is the precondition for a ' +
      'database-backed `bun test` run — without a connection string there is ' +
      'nothing to verify, and running the tests anyway is exactly the ' +
      'fake-pass this gate exists to prevent.',
  );
}

const files = await readdir(MIGRATIONS_DIR).catch((err: unknown) =>
  die(
    `cannot read the migrations directory at ${MIGRATIONS_DIR}: ` +
      `${err instanceof Error ? err.message : String(err)}. Refusing to report ` +
      'a migrated schema this script cannot actually verify.',
  ),
);

const newest = newestMigration(files);
if (!newest) {
  die(
    `found zero \`NNN_*.sql\` files in ${MIGRATIONS_DIR} — the discovery regex ` +
      'is broken, which would make the schema check vacuously pass.',
  );
}

// max: 1 — one short-lived connection, mirroring `applyMigrations`.
const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
  try {
    await sql`SELECT 1`;
  } catch (err) {
    die(
      `cannot connect to Postgres at ${redact(url)} — ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Start the database (see the "Bootstrap schema + seed + migrations" CI ' +
        'step) before running the database-backed test lane.',
    );
  }

  let appliedRows: { filename: string }[];
  try {
    appliedRows = await sql<{ filename: string }[]>`SELECT filename FROM _migrations`;
  } catch (err) {
    die(
      `connected to ${redact(url)} but could not read the \`_migrations\` table — ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'The schema has never been migrated by `bun run migrate`; an unmigrated ' +
        'database makes every database-backed test fail for the wrong reason.',
    );
  }

  const applied = new Set(appliedRows.map((r) => r.filename));
  if (!applied.has(newest)) {
    die(
      `Postgres at ${redact(url)} is reachable but the schema is BEHIND this ` +
        `checkout: the newest migration on disk, \`${newest}\`, is not recorded ` +
        `in \`_migrations\` (${applied.size} migration(s) recorded). ` +
        'Run `bun run migrate` against this database first. Testing against a ' +
        'stale schema proves the wrong thing.',
    );
  }

  console.log(
    `[require-db-reachable] OK: ${redact(url)} reachable, schema migrated ` +
      `through ${newest} (${applied.size} migration(s) recorded).`,
  );
} finally {
  await sql.end({ timeout: 5 });
}
