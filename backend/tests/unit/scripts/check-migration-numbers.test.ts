// tests/unit/scripts/check-migration-numbers.test.ts
//
// Unit tests for `scripts/check-migration-numbers.ts` — the BLOCKING CI gate
// (scripts/ci-verify.sh; `bun run check-migration-numbers`) that
// rejects duplicate NNN_ prefixes in backend/migrations.
//
// ⚠️ WHY THIS FILE EXISTS. MEASURED 2026-09-07: the real backend/migrations/
// tree holds 114 files, prefixes 001–114, contiguous, zero duplicates. So the
// guard ships with ZERO violators and a green CI run says NOTHING about whether
// it can still fire. A positive control provably cannot be built from the real
// tree — it has to be driven against a fixture, which is why the guard was made
// injectable (`scanMigrationNumbers(dir)`) before these tests could exist. It
// was previously written un-testable: no exports, a hardcoded directory, and a
// bare top-level `await main()` that ran the scan on import.
//
// The controls this file is required to carry:
//   POSITIVE          — two files sharing prefix 115 MUST be flagged;
//   POSITIVE (padded) — `0114_a.sql` + `114_b.sql` MUST be flagged: DIFFERENT
//                       strings, SAME number. See below;
//   NEGATIVE          — distinct numbers MUST NOT be flagged, including mixed
//                       widths (007 / 070 / 0114) that do not collide;
//   EMPTY SCOPE       — an empty (or missing) directory MUST FAIL, not print OK.
//
// ⛔ WHY THE PADDED CONTROL EXISTS. MEASURED 2026-09-07, against the guard as it
// then stood: a fixture holding `0114_mutant_pad.sql` beside `114_real.sql`
// exited 0 — "2 migration file(s) scanned, 2 distinct prefix(es), no
// duplicates". The guard keyed duplicate detection on the raw prefix STRING
// while src/db/migration-runner.ts:795 keys on `Number.parseInt(match[1], 10)`
// and :798 breaks the tie with `a.name.localeCompare(b.name)`. So both files
// applied, into ONE slot, in alphabetical order — precisely the silent-ordering
// incident the guard's header says it prevents, waved through green. The guard
// now keys on the parsed integer. `padded duplicate` below FAILS against the
// string key; that is the only reason it is worth having.
// The last one pins the fail-open fix: the guard used to print
// `OK — 0 migration(s), no duplicate prefixes` and exit 0 for an empty
// directory, so a scan of nothing was indistinguishable from a clean tree.
//
// ⛔ The spawn tests are not decoration, but be precise about WHICH path each
// one pins — the header used to claim more than the tests delivered.
// CI (scripts/ci-verify.sh, "No duplicate migration numeric prefixes") runs
// `cd backend && bun run check-migration-numbers`, which is the package.json
// SCRIPT, and package.json:15 expands it to `bun run scripts/check-migration-numbers.ts`.
// That is TWO links, and they can break independently:
//   · `runCli()` below spawns the SCRIPT FILE by absolute path. It pins the
//     second link only — that `if (import.meta.main)` is still wired, so the
//     script cannot scan NOTHING, print nothing and exit 0 with CI green.
//   · `the package.json script indirection is still wired` pins the FIRST link:
//     the exact argv CI types. Verified working 2026-09-07, so this is a PIN and
//     not a repair — but nothing pinned it, and a rename or deletion of the
//     package.json entry would have unwired the gate in silence.
// Both assert the OK marker and its denominator, never just the exit code: a
// guard that never ran also exits 0.
//
// No `mock.module()` (banned repo-wide, CI-guarded by
// `scripts/check-no-test-doubles.ts`) — none is needed.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_MIGRATIONS_DIR,
  EXIT_DUPLICATES,
  EXIT_EMPTY_SCOPE,
  findDuplicateNumbers,
  scanMigrationNumbers,
} from '../../../scripts/check-migration-numbers';

const BACKEND_DIR = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const GUARD = join(BACKEND_DIR, 'scripts', 'check-migration-numbers.ts');

const runCli = (...args: string[]) => {
  const proc = Bun.spawnSync(['bun', 'run', GUARD, ...args], { cwd: BACKEND_DIR });
  return {
    exitCode: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
};

// ---------------------------------------------------------------------------
// The tree the guard ships with — and the CI invocation path
// ---------------------------------------------------------------------------

describe('the real migrations tree', () => {
  test('default directory is backend/migrations and is clean', async () => {
    expect(DEFAULT_MIGRATIONS_DIR).toBe(join(BACKEND_DIR, 'migrations'));
    const { files, migrations, duplicates, readError } = await scanMigrationNumbers();
    expect(readError).toBeUndefined();
    // Non-vacuity only: the scan must have found the real migrations tree. No
    // floor — adding or retiring a migration must not red this test; the
    // derived `migrations === files.length` below is the assertion.
    expect(files.length).toBeGreaterThan(0);
    expect(migrations).toBe(files.length); // no duplicates => one prefix per file
    expect(duplicates).toEqual([]);
  });

  test('the CLI still executes and exits 0 — import.meta.main is wired', () => {
    // If the guard were dead (never invoked), this would ALSO exit 0 with no
    // output. So assert the OK line and its denominator, not just the code.
    // NB this spawns the SCRIPT FILE; the test below spawns what CI actually
    // types. See the header for why both links need pinning.
    const { exitCode, out } = runCli();
    expect(out).toContain('[check-migration-numbers] OK');
    expect(out).toMatch(/\d+ migration file\(s\) scanned/);
    expect(exitCode).toBe(0);
  });

  test('the package.json script indirection is still wired — the argv CI types', () => {
    // scripts/ci-verify.sh runs `bun run check-migration-numbers` from backend/, NOT a
    // path to the .ts file. That resolves through package.json:15
    // (`"check-migration-numbers": "bun run scripts/check-migration-numbers.ts"`),
    // a link no other test in this repo touches: renaming or deleting that entry
    // unwires the blocking gate while every file-path spawn above stays green.
    //
    // ⛔ Not `exitCode === 0` alone — `bun run <unknown-script>` is a failure,
    // but a REPOINTED script (at a no-op, or at a script whose entrypoint is
    // dead) exits 0 with no output. The OK marker plus the denominator is what
    // distinguishes "the gate ran" from "the command succeeded".
    const proc = Bun.spawnSync(['bun', 'run', 'check-migration-numbers'], { cwd: BACKEND_DIR });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain('[check-migration-numbers] OK');
    expect(out).toMatch(/\d+ migration file\(s\) scanned/);
    expect(out).not.toMatch(/\b0 migration file\(s\) scanned/);
    expect(proc.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The rule, as a pure function
// ---------------------------------------------------------------------------

describe('findDuplicateNumbers', () => {
  test('POSITIVE control: two files sharing a prefix are flagged', () => {
    // NO-REGRESSION control for the ordinary case: identical prefix STRINGS.
    // The numeric key must not have traded the old defect for a new one — this
    // is the shape 100% of the real tree's past incidents (026-029) took.
    const dups = findDuplicateNumbers(['114_x.sql', '115_b.sql', '115_a.sql']);
    expect(dups).toEqual([{ order: 115, prefixes: ['115'], files: ['115_a.sql', '115_b.sql'] }]);
  });

  test('POSITIVE control: prefixes differing as STRINGS but equal as INTEGERS are flagged', () => {
    // `0114` !== `114` as strings; `Number.parseInt` makes them the same slot,
    // which is the identity migration-runner.ts:795 uses. A string-keyed
    // implementation returns [] here and this assertion is what catches it.
    const dups = findDuplicateNumbers(['113_x.sql', '0114_a.sql', '114_b.sql']);
    expect(dups).toEqual([
      { order: 114, prefixes: ['0114', '114'], files: ['0114_a.sql', '114_b.sql'] },
    ]);
  });

  test('NEGATIVE control: mixed prefix WIDTHS that do not collide numerically are clean', () => {
    // This is what stops the fix from degenerating into "any padding is an
    // error". 007=7, 070=70, 0114=114, 115=115 — four distinct numbers, three
    // different widths, nothing to report. The guard checks the NUMBER; prefix
    // width is not its business (see the guard header).
    expect(
      findDuplicateNumbers(['007_a.sql', '070_b.sql', '0114_c.sql', '115_d.sql']),
    ).toEqual([]);
  });

  test('NEGATIVE control: distinct prefixes are not flagged', () => {
    expect(findDuplicateNumbers(['113_a.sql', '114_b.sql', '115_c.sql'])).toEqual([]);
  });

  test('non-migration entries are ignored, not counted as a prefix', () => {
    expect(findDuplicateNumbers(['README.md', '.keep', 'meta.json', '115_a.sql'])).toEqual([]);
  });

  test('SCOPE PIN: gaps and out-of-order prefixes are NOT flagged', () => {
    // The header used to claim this guard keeps the numbering monotonic. It does
    // not, and expanding it to do so would change which trees pass CI. This
    // assertion is what stops that claim from being re-introduced by accident:
    // 003 is missing and the files are out of order, and it is still clean.
    expect(findDuplicateNumbers(['005_c.sql', '001_a.sql', '002_b.sql', '009_d.sql'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The directory scan, against fixtures
// ---------------------------------------------------------------------------

describe('scanMigrationNumbers — against fixture directories', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fr-migration-numbers-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string) => writeFile(join(dir, name), '-- fixture\nSELECT 1;\n');

  test('POSITIVE control: a duplicated prefix on disk is flagged and the CLI exits 1', async () => {
    await write('115_a.sql');
    await write('115_b.sql');

    const { files, migrations, duplicates } = await scanMigrationNumbers(dir);
    expect(files).toEqual(['115_a.sql', '115_b.sql']);
    expect(migrations).toBe(1); // two files, ONE prefix — the whole defect
    expect(duplicates).toEqual([
      { order: 115, prefixes: ['115'], files: ['115_a.sql', '115_b.sql'] },
    ]);

    const { exitCode, out } = runCli(dir);
    expect(out).toContain('1 colliding migration number(s) across 2 file(s)');
    expect(out).toContain('115_a.sql');
    expect(out).toContain('115_b.sql');
    expect(exitCode).toBe(EXIT_DUPLICATES);
  });

  test('NEGATIVE control: distinct prefixes are clean and the CLI exits 0', async () => {
    await write('115_a.sql');
    await write('116_b.sql');
    await write('117_c.sql');

    const { files, migrations, duplicates } = await scanMigrationNumbers(dir);
    expect(files).toHaveLength(3);
    expect(migrations).toBe(3);
    expect(duplicates).toEqual([]);

    const { exitCode, out } = runCli(dir);
    expect(out).toContain('OK');
    expect(out).toContain('3 migration file(s) scanned');
    expect(exitCode).toBe(0);
  });

  test('POSITIVE control: a PADDED duplicate on disk is flagged and the CLI exits 1', async () => {
    // ⛔ The test this whole change exists for. Against the previous string key
    // this fixture produced `OK — 2 migration file(s) scanned, 2 distinct
    // prefix(es), no duplicates` and exit 0 (measured 2026-09-07).
    await write('0114_a.sql');
    await write('114_b.sql');

    const { files, migrations, duplicates } = await scanMigrationNumbers(dir);
    expect(files).toEqual(['0114_a.sql', '114_b.sql']);
    expect(migrations).toBe(1); // two files, ONE migration number — the defect
    expect(duplicates).toEqual([
      { order: 114, prefixes: ['0114', '114'], files: ['0114_a.sql', '114_b.sql'] },
    ]);

    const { exitCode, out } = runCli(dir);
    // ⛔ UNIT PIN. This fixture is ONE colliding number spread over TWO files
    // whose prefixes differ as strings. The FAIL header used to read
    // `1 duplicate numeric prefix(es) found` — a count of NUMBERS labelled as
    // prefixes, printed directly above two visibly different prefixes. The
    // literal below is what stops that unit from being reintroduced.
    expect(out).toContain('1 colliding migration number(s) across 2 file(s)');
    // The message must carry the NUMBER and both LITERAL prefixes — "duplicate
    // 114" over two visibly different filenames is not actionable on its own.
    expect(out).toContain('migration number 114');
    expect(out).toContain('0114, 114');
    expect(out).toContain('0114_a.sql');
    expect(out).toContain('114_b.sql');
    expect(out).not.toContain('OK —');
    expect(exitCode).toBe(EXIT_DUPLICATES);
  });

  test('NEGATIVE control: mixed widths with distinct NUMBERS are clean and the CLI exits 0', async () => {
    // The guard must not have become "all prefixes must be 3 digits". 007, 070
    // and 0114 are three widths and three distinct numbers; the runner applies
    // them 7 → 70 → 114 → 115 with no tiebreak needed.
    await write('007_a.sql');
    await write('070_b.sql');
    await write('0114_c.sql');
    await write('115_d.sql');

    const { migrations, duplicates } = await scanMigrationNumbers(dir);
    expect(migrations).toBe(4);
    expect(duplicates).toEqual([]);

    const { exitCode, out } = runCli(dir);
    expect(out).toContain('OK —');
    expect(out).toContain('4 migration file(s) scanned');
    expect(exitCode).toBe(0);
  });

  test('EMPTY-SCOPE control: an EXISTING but empty directory FAILS', async () => {
    const { files, migrations, duplicates, readError } = await scanMigrationNumbers(dir);
    expect(readError).toBeUndefined(); // the directory opened fine — it is just empty
    expect(files).toEqual([]);
    expect(migrations).toBe(0);
    expect(duplicates).toEqual([]);

    // Before the fix this printed `OK — 0 migration(s), no duplicate prefixes`
    // and exited 0. A scan of nothing must never be a pass.
    const { exitCode, out } = runCli(dir);
    expect(out).toContain('scanned ZERO migration files');
    expect(out).toContain(dir); // the failure names the directory it could not see
    // NB matched against 'OK —', not 'OK': mkdtemp's random suffix can itself
    // contain the letters O and K, which would make a bare substring check flaky.
    expect(out).not.toContain('OK —');
    expect(exitCode).toBe(EXIT_EMPTY_SCOPE);
  });

  test('EMPTY-SCOPE control: a directory holding only non-migration files FAILS', async () => {
    // The zero-check counts MATCHING files, not directory entries — otherwise a
    // tree whose .sql files were renamed away would still read as populated.
    await writeFile(join(dir, 'README.md'), '# not a migration\n');
    await writeFile(join(dir, 'schema.json'), '{}\n');

    expect((await scanMigrationNumbers(dir)).files).toEqual([]);

    const { exitCode, out } = runCli(dir);
    expect(out).toContain('scanned ZERO migration files');
    expect(exitCode).toBe(EXIT_EMPTY_SCOPE);
  });

  test('EMPTY-SCOPE control: a MISSING directory FAILS and names itself', async () => {
    const missing = join(dir, 'does-not-exist');

    const { files, readError } = await scanMigrationNumbers(missing);
    expect(readError).toBeDefined();
    expect(files).toEqual([]);

    const { exitCode, out } = runCli(missing);
    expect(out).toContain('could not read the migrations directory');
    expect(out).toContain(missing);
    expect(exitCode).toBe(EXIT_EMPTY_SCOPE);
  });

  test('the two failure exit codes are distinct, and both non-zero', () => {
    // A dead scope and a real finding are different facts; a caller that only
    // sees "non-zero" should still be able to tell them apart.
    expect(EXIT_DUPLICATES).not.toBe(EXIT_EMPTY_SCOPE);
    expect(EXIT_DUPLICATES).toBeGreaterThan(0);
    expect(EXIT_EMPTY_SCOPE).toBeGreaterThan(0);
  });

  test('importing the module does not run the scan as a side effect', () => {
    // The old file ended in a bare top-level `await main()`, so importing it
    // executed a scan (and could process.exit) inside the test runner. If that
    // regressed, this suite would not have reached this point — but assert the
    // observable consequence anyway: the import above bound real functions.
    expect(typeof scanMigrationNumbers).toBe('function');
    expect(typeof findDuplicateNumbers).toBe('function');
  });
});
