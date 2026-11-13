#!/usr/bin/env bun
// Fail-loud CI guard: reject any duplicate migration NUMBER in backend/migrations.
// Past incidents (026, 027, 028, 029 each duplicated) made the apply order
// silently depend on alphabetical secondary sort. This guard checks UNIQUENESS
// OF THE MIGRATION NUMBER AND NOTHING ELSE — it does not verify that the
// numbering is monotonic and it does not detect gaps; a deleted 042 passes it in
// silence.
//
// ⚠️ The lines above used to end "the file numbering is monotonic; this guard
// keeps it that way." It never did. The scan below builds one bucket per number
// and reports the buckets holding more than one file; nothing in it ever
// compares two numbers for order, and nothing looks for a hole in the sequence.
// A comment that claims a check the code does not perform is the same defect as
// a green run that overstates its scan: the next reader trusts a property no
// instrument is measuring. If monotonicity or gap-freedom is wanted, that is a
// new rule with its own tests — not a sentence in this header.
//
// ⛔ THE KEY IS THE PARSED INTEGER, NOT THE PREFIX STRING (fixed 2026-09-07)
// -------------------------------------------------------------------------
// DO NOT "simplify" the `Number.parseInt` below back to keying on the raw
// prefix string. The identity this guard must reproduce is the RUNNER's:
//   · src/db/migration-runner.ts:795 — `order: Number.parseInt(match[1]!, 10)`
//   · src/db/migration-runner.ts:798 — `files.sort((a, b) => (a.order - b.order)
//                                        || a.name.localeCompare(b.name))`
// Both files use the identical regex `/^(\d{3,})_.*\.sql$/`, so they see the
// same population — but the runner collapses `0114_a.sql` and `114_b.sql` onto
// ONE order (114) and then breaks the tie ALPHABETICALLY, which is exactly the
// silent-ordering incident this guard exists to prevent. Keyed on the string,
// those two prefixes are DISTINCT and the guard passes. MEASURED before the fix:
// a fixture holding `0114_mutant_pad.sql` beside `114_real.sql` exited 0 with
// "2 distinct prefix(es), no duplicates".
//
// NOT CHECKED: PREFIX WIDTH. Every file in the tree today is exactly 3 digits,
// but that is convention, not a property the runner reads — it parses the digits
// and discards the padding. `007_a.sql` and `070_b.sql` are legitimate and
// distinct, and so is any other width that does not collide numerically. This
// guard therefore says nothing about padding. Adding a width rule would be a new
// check with its own name, its own exit code and its own test — not a widening
// of this one.
//
// FAIL-CLOSED ON AN EMPTY SCOPE (fixed 2026-09-07)
// -----------------------------------------------
// This guard used to print `OK — 0 migration(s), no duplicate prefixes` and exit
// 0 for an existing-but-empty directory: a scan of nothing was indistinguishable
// from a clean tree, so a wrong cwd, a moved tree or a bad `--dir` reported
// success. A zero-file scan is now EXIT_EMPTY_SCOPE, naming the directory. The
// OK line carries its denominator so a shrinking count is visible in the log.
//
// INJECTABLE, so the rule can be proved
// -------------------------------------
// The real backend/migrations/ tree is contiguous 001–114 with zero duplicates,
// so a positive control CANNOT be built from it — the guard's green on this repo
// proves nothing about whether it can still fire. The pure rule
// (`findDuplicateNumbers`) and the directory scan (`scanMigrationNumbers`, whose
// directory is a parameter) are therefore exported. The CLI body
// sits behind `if (import.meta.main)`, the same shape as
// scripts/check-credential-absence-armed.ts and scripts/check-migration-dml-probed.ts.
//
// Run via: `cd backend && bun run check-migration-numbers`
//          `... bun run scripts/check-migration-numbers.ts <migrations-dir>`
// Wire into CI as a one-line step in the Lint & Type Check job.

import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const TAG = '[check-migration-numbers]';

/** The directory CI scans when no argument is given. Unchanged behaviour. */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dir, '..', 'migrations');

/** Byte-identical to migration-runner.ts:33 — same population, same parse. */
export const MIGRATION_FILE_RE = /^(\d{3,})_.*\.sql$/;

/** A duplicate migration-number finding: exit 1. */
export const EXIT_DUPLICATES = 1;
/** Nothing was scanned — missing dir, or zero migration files: exit 2. */
export const EXIT_EMPTY_SCOPE = 2;

/**
 * The runner's identity for a migration file: the digits parsed as an integer.
 * See migration-runner.ts:795. Padding is discarded there, so it is discarded
 * here — that is the whole point of this guard.
 */
export function migrationOrder(prefix: string): number {
  return Number.parseInt(prefix, 10);
}

export interface DuplicateGroup {
  /** The parsed integer the runner sorts on — the slot that actually collides. */
  order: number;
  /**
   * The DISTINCT LITERAL prefixes that landed on `order`, sorted. Normally one
   * (`['114']`); more than one means the collision is a padding difference
   * (`['0114', '114']`) that a string-keyed check cannot see. Reported so the
   * failure message is not the baffling "duplicate 114" over two prefixes that
   * are visibly different on disk.
   */
  prefixes: string[];
  files: string[];
}

export interface ScanResult {
  /** The directory that was scanned, absolute where the caller gave one. */
  dir: string;
  /** Filenames matching NNN_*.sql, sorted. Non-matching entries are ignored. */
  files: string[];
  /** Distinct migration NUMBERS seen — the denominator of the OK line. */
  migrations: number;
  duplicates: DuplicateGroup[];
  /** Set when the directory could not be read at all (missing, not a dir, EACCES). */
  readError?: string;
}

/**
 * The rule, as a pure function over filenames.
 *
 * ONLY uniqueness of the parsed number. Order, gaps and prefix width are
 * deliberately out of scope — see the header. Returns one group per number
 * carrying more than one file, files sorted, groups in ascending numeric order.
 */
export function findDuplicateNumbers(filenames: string[]): DuplicateGroup[] {
  // ⛔ Map<number, …>, keyed by migrationOrder(). NOT the prefix string: see the
  // header block on migration-runner.ts:795.
  const byOrder = new Map<number, string[]>();

  for (const name of filenames) {
    const m = MIGRATION_FILE_RE.exec(name);
    if (!m) continue;
    const order = migrationOrder(m[1]!);
    const list = byOrder.get(order) ?? [];
    list.push(name);
    byOrder.set(order, list);
  }

  const duplicates: DuplicateGroup[] = [];
  for (const [order, names] of byOrder) {
    if (names.length < 2) continue;
    const files = [...names].sort();
    const prefixes = [...new Set(files.map((n) => MIGRATION_FILE_RE.exec(n)![1]!))].sort();
    duplicates.push({ order, prefixes, files });
  }
  return duplicates.sort((a, b) => a.order - b.order);
}

/**
 * Scan one directory. `dir` is a parameter so a test can point the guard at a
 * fixture; it defaults to DEFAULT_MIGRATIONS_DIR so the CI invocation is
 * byte-identical to what it was before this refactor.
 *
 * An unreadable directory is reported as `readError` rather than thrown, so the
 * caller decides the exit code — and so the missing-directory case is assertable
 * in-process without catching.
 */
export async function scanMigrationNumbers(
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<ScanResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    return {
      dir,
      files: [],
      migrations: 0,
      duplicates: [],
      readError: err instanceof Error ? err.message : String(err),
    };
  }

  const files = entries.filter((n) => MIGRATION_FILE_RE.test(n)).sort();
  // Numeric, for the same reason as findDuplicateNumbers: a string Set would
  // count `0114` and `114` as two migrations and put a false denominator on the
  // OK line right next to a missed duplicate.
  const orders = new Set(files.map((n) => migrationOrder(MIGRATION_FILE_RE.exec(n)![1]!)));

  return { dir, files, migrations: orders.size, duplicates: findDuplicateNumbers(files) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv: string[] = []): Promise<void> {
  const dir = argv.find((a) => !a.startsWith('-')) ?? DEFAULT_MIGRATIONS_DIR;
  const { files, migrations, duplicates, readError } = await scanMigrationNumbers(dir);

  if (readError) {
    console.error(
      `${TAG} FAIL: could not read the migrations directory ${dir} — ${readError}\n` +
        'A guard that cannot open its own scope must not report a clean tree. Check the ' +
        'cwd (this runs from backend/) or the directory argument.',
    );
    process.exit(EXIT_EMPTY_SCOPE);
  }

  if (files.length === 0) {
    console.error(
      `${TAG} FAIL: scanned ZERO migration files in ${dir}.\n` +
        'A scan of nothing is not a clean tree — this guard used to exit 0 here, which ' +
        'made a wrong cwd or a moved tree look like a pass. Point it at the real ' +
        'migrations directory, or delete the CI step if the tree is genuinely gone.',
    );
    process.exit(EXIT_EMPTY_SCOPE);
  }

  if (duplicates.length > 0) {
    // ⛔ UNIT: `duplicates` is one group per colliding NUMBER, not per prefix
    // string. On the headline fixture (`0114_a.sql` + `114_b.sql`) there is ONE
    // number and TWO visibly different prefixes, so counting "prefix(es)" here
    // understated what is printed directly below it. Count what is counted, and
    // give the file total beside it.
    const dupFileCount = duplicates.reduce((n, d) => n + d.files.length, 0);
    console.error(
      `${TAG} FAIL: ${duplicates.length} colliding migration number(s) ` +
        `across ${dupFileCount} file(s):`,
    );
    for (const { order, prefixes, files: dup } of duplicates) {
      // Print the NUMBER and the literal prefixes it came from: with a padding
      // collision the filenames on disk do not visibly share anything.
      console.error(`  migration number ${order} ← prefix(es) ${prefixes.join(', ')}:`);
      for (const f of dup) console.error(`    - ${f}`);
    }
    console.error(
      '\nEvery file in backend/migrations/ must have a unique migration NUMBER. ' +
        'The runner parses the prefix with Number.parseInt (migration-runner.ts:795), so ' +
        '`0114_` and `114_` are the SAME slot and their apply order falls to the ' +
        'alphabetical tiebreak. Re-padding is not a fix: renumber the newer file(s) to ' +
        'the next free number after the highest existing one.',
    );
    process.exit(EXIT_DUPLICATES);
  }

  console.log(
    `${TAG} OK — ${files.length} migration file(s) scanned in ${dir}, ` +
      `${migrations} distinct migration number(s), no duplicates. ` +
      '(Uniqueness of the parsed number only: monotonicity, gaps and prefix width ' +
      'are NOT checked.)',
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
