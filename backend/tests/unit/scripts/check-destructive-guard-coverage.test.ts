// tests/unit/scripts/check-destructive-guard-coverage.test.ts
//
// Unit tests for `scripts/check-destructive-guard-coverage.ts` — the static half
// of fr#1283's destructive-statement guard. The runtime half is
// `backend/migrations/142_destructive_statement_guard.sql`.
//
// ⚠️ WHY THIS FILE CARRIES THE WHOLE PROOF. On this tree the guard has ZERO
// violators on rules 1 and 3 and sits EXACTLY ON its floor for rule 2, so a
// green CI run says nothing about whether any detector can still fire. Break
// the schema.ts parser and the universe is empty, which makes every table
// trivially "classified"; break the `.delete(` detector and it reports 0 bare
// deletes, which reads as an IMPROVEMENT. The only evidence the rules fire is
// here: every rule is driven against a fixture tree that MUST be rejected, and
// each fixture differs from an accepted one in exactly the one respect the rule
// is about.
//
// It also pins the two decisions that were MEASURED rather than assumed:
//   * `.delete(` is keyed on the schema.ts identifier set, because src/ holds 72
//     `.delete(` sites and 51 are Map/Set/URLSearchParams deletes that take no
//     WHERE and never will — a naive grep reports 54 violations, 53 false.
//   * TRUNCATE detection is CASE-SENSITIVE, because a case-insensitive pattern
//     flags `…would truncate and corrupt the existing list`, English prose in a
//     thrown message inside a template literal.
//
// Finally it asserts against the REAL tree, so the numbers in the guard's header
// cannot rot silently.
//
// No `mock.module()` (banned repo-wide, CI-guarded by
// `scripts/check-no-test-doubles.ts`) — none is needed.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  BARE_DELETE_FLOOR,
  MIN_DRIZZLE_DELETE_SITES,
  MIN_EXEMPT,
  MIN_PROTECTED,
  MIN_UNIVERSE,
  RAW_BARE_DELETE_FLOOR,
  TRUNCATE_FLOOR,
  parseSchemaTables,
  parseSqlTextArray,
  scanCoverage,
  scanDrizzleDeletes,
  scanRawBareDeletes,
  scanTruncates,
  stripTypeScript,
} from '../../../scripts/check-destructive-guard-coverage.ts';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

let dir: string;

/** A migration whose two arrays are exactly the lists passed in. */
function migrationSql(protectedTables: string[], exemptTables: string[]): string {
  return [
    '-- Migration: fixture',
    "-- Prose that names TRUNCATE and DELETE FROM approvals; must be stripped.",
    'DO $fr_attach$',
    'DECLARE',
    `  protected_tables text[] := ARRAY[${protectedTables.map((t) => `'${t}'`).join(', ')}];`,
    `  exempt_tables text[] := ARRAY[${exemptTables.map((t) => `'${t}'`).join(', ')}];`,
    'BEGIN',
    'END',
    '$fr_attach$;',
  ].join('\n');
}

function schemaTs(tables: Array<[string, string]>): string {
  return tables
    .map(([ident, table]) => `export const ${ident} = pgTable('${table}', {\n  id: text('id'),\n});`)
    .join('\n\n');
}

async function fixture(opts: {
  protected: string[];
  exempt: string[];
  schema: Array<[string, string]>;
  src: Record<string, string>;
}): Promise<{ migrationPath: string; schemaPath: string; srcDir: string }> {
  const migrationPath = join(dir, 'migration.sql');
  const schemaPath = join(dir, 'schema.ts');
  const srcDir = join(dir, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(migrationPath, migrationSql(opts.protected, opts.exempt));
  await writeFile(schemaPath, schemaTs(opts.schema));
  for (const [name, body] of Object.entries(opts.src)) {
    await writeFile(join(srcDir, name), body);
  }
  return { migrationPath, schemaPath, srcDir };
}

/** Enough sites to clear MIN_DRIZZLE_DELETE_SITES, all properly qualified. */
function qualifiedDeletes(ident: string, n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `export const q${i} = () => db.delete(${ident}).where(eq(${ident}.id, '${i}'));`,
  ).join('\n');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fr-destructive-guard-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parseSqlTextArray', () => {
  test('reads a text[] := ARRAY[...] declaration', () => {
    const code = "  protected_tables text[] := ARRAY[\n    'a',\n    'b_c'\n  ];";
    expect(parseSqlTextArray(code, 'protected_tables')).toEqual(['a', 'b_c']);
  });

  test('returns null — not [] — when the declaration is absent', () => {
    // Load-bearing: an empty list would make every rule trivially satisfied, so
    // the caller must be able to tell "absent" from "empty" and fail closed.
    expect(parseSqlTextArray('SELECT 1;', 'protected_tables')).toBeNull();
  });

  test('does not confuse the two arrays for each other', () => {
    const code =
      "  protected_tables text[] := ARRAY['p'];\n  exempt_tables text[] := ARRAY['e'];";
    expect(parseSqlTextArray(code, 'protected_tables')).toEqual(['p']);
    expect(parseSqlTextArray(code, 'exempt_tables')).toEqual(['e']);
  });
});

describe('parseSchemaTables', () => {
  test('maps the drizzle identifier to the SQL table name across newlines', () => {
    const src = "export const cardDrafts = pgTable(\n  'card_drafts',\n  { id: text('id') },\n);";
    expect(parseSchemaTables(src)).toEqual([{ ident: 'cardDrafts', table: 'card_drafts' }]);
  });

  test('ignores a pgTable call that is not an exported const', () => {
    expect(parseSchemaTables("const local = pgTable('local', {});")).toEqual([]);
  });
});

describe('stripTypeScript', () => {
  test('blanks comments but preserves line numbers', () => {
    const out = stripTypeScript('// TRUNCATE x\nconst a = 1;', { blankTemplateLiterals: true });
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toContain('TRUNCATE');
  });

  test('blanks single-quoted strings, so a log message is not a statement', () => {
    const out = stripTypeScript("log('TRUNCATE happened');", { blankTemplateLiterals: true });
    expect(out).not.toContain('TRUNCATE');
  });

  test('KEEPS template literals when asked, because raw SQL lives in them', () => {
    // If this inverts, rule 3 becomes vacuous by construction: every raw
    // statement in this codebase is written inside a backtick template.
    const src = 'await db.execute(sql`TRUNCATE approvals`);';
    expect(stripTypeScript(src, { blankTemplateLiterals: false })).toContain('TRUNCATE approvals');
    expect(stripTypeScript(src, { blankTemplateLiterals: true })).not.toContain('TRUNCATE');
  });
});

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

describe('scanDrizzleDeletes', () => {
  const idents = new Set(['approvals']);

  test('flags a table delete with no .where', () => {
    const scan = scanDrizzleDeletes('await db.delete(approvals);', idents, 'f.ts');
    expect(scan.sites).toBe(1);
    expect(scan.bare).toHaveLength(1);
    expect(scan.bare[0]!.line).toBe(1);
  });

  test('accepts a .where on a later line', () => {
    const scan = scanDrizzleDeletes(
      'await db.delete(approvals)\n  \n  .where(eq(approvals.id, id));',
      idents,
      'f.ts',
    );
    expect(scan.sites).toBe(1);
    expect(scan.bare).toHaveLength(0);
  });

  test('IGNORES a Map/Set/URLSearchParams delete — the 53 false positives', () => {
    // MEASURED: src/ holds 72 `.delete(` sites, 51 of which are Map/Set/
    // URLSearchParams. A `.delete(`-keyed grep reports 54 bare deletes; keying
    // on the schema.ts identifier set reports the one that is real.
    const scan = scanDrizzleDeletes(
      "cache.delete(key);\nsockets.delete(ws);\nparams.delete('limit');",
      idents,
      'f.ts',
    );
    expect(scan.sites).toBe(0);
    expect(scan.bare).toHaveLength(0);
  });

  test('does not run past the end of the statement to borrow a later .where', () => {
    const scan = scanDrizzleDeletes(
      'await db.delete(approvals);\nawait db.update(x).where(eq(x.id, id));',
      idents,
      'f.ts',
    );
    expect(scan.bare).toHaveLength(1);
  });
});

describe('scanTruncates', () => {
  test('flags an upper-case TRUNCATE statement', () => {
    expect(scanTruncates('sql`TRUNCATE approvals`', 'f.ts')).toHaveLength(1);
  });

  test('does NOT flag English prose — the measured false positive', () => {
    // src/services/improvement-cards/relations.ts:186 is the real line; a
    // case-insensitive pattern flagged it and the guard shipped red.
    expect(scanTruncates('`writing it would truncate and corrupt the list`', 'f.ts')).toEqual([]);
  });

  test('does NOT flag the TRUNCATED_HEADER / TRUNCATION_MARKER identifiers', () => {
    expect(scanTruncates('TRUNCATED_HEADER + TRUNCATION_MARKER', 'f.ts')).toEqual([]);
  });

  test('still flags a lower-case `truncate table`', () => {
    expect(scanTruncates('sql`truncate table approvals`', 'f.ts')).toHaveLength(1);
  });
});

describe('scanRawBareDeletes', () => {
  test('flags DELETE FROM with no WHERE', () => {
    expect(scanRawBareDeletes('sql`DELETE FROM approvals`', 'f.ts')).toHaveLength(1);
  });

  test('accepts DELETE FROM ... USING ... WHERE, the real prune shape', () => {
    expect(
      scanRawBareDeletes(
        'sql`DELETE FROM scheduled_trigger_runs t USING doomed WHERE t.ctid = doomed.ctid`',
        'f.ts',
      ),
    ).toEqual([]);
  });

  test('does not borrow a WHERE from the NEXT statement', () => {
    const found = scanRawBareDeletes(
      'sql`DELETE FROM approvals`;\nsql`SELECT 1 FROM x WHERE y`;',
      'f.ts',
    );
    expect(found).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — the partition, driven end to end
// ---------------------------------------------------------------------------

describe('scanCoverage — rule 1 (every schema.ts table is classified)', () => {
  const schema: Array<[string, string]> = [
    ['approvals', 'approvals'],
    ['cardDrafts', 'card_drafts'],
  ];
  const src = { 'a.ts': qualifiedDeletes('approvals', MIN_DRIZZLE_DELETE_SITES) };

  test('ACCEPTS a complete partition', async () => {
    const paths = await fixture({
      protected: ['approvals'],
      exempt: ['card_drafts'],
      schema,
      src,
    });
    const r = scanCoverage(paths);
    expect(r.unclassified).toEqual([]);
    expect(r.overlap).toEqual([]);
    expect(r.staleExempt).toEqual([]);
    expect(r.universe).toHaveLength(2);
  });

  test('REJECTS a table that is in neither list — the regression it exists for', async () => {
    const paths = await fixture({ protected: ['approvals'], exempt: [], schema, src });
    expect(scanCoverage(paths).unclassified).toEqual(['card_drafts']);
  });

  test('REJECTS a table in BOTH lists', async () => {
    const paths = await fixture({
      protected: ['approvals', 'card_drafts'],
      exempt: ['card_drafts'],
      schema,
      src,
    });
    expect(scanCoverage(paths).overlap).toEqual(['card_drafts']);
  });

  test('REJECTS a stale exemption naming no schema.ts table', async () => {
    const paths = await fixture({
      protected: ['approvals', 'card_drafts'],
      exempt: ['a_table_that_was_dropped'],
      schema,
      src,
    });
    expect(scanCoverage(paths).staleExempt).toEqual(['a_table_that_was_dropped']);
  });

  test('ALLOWS a protected table outside schema.ts, and reports it', async () => {
    // wip_slot / card_version_stamps are migration-only by design.
    const paths = await fixture({
      protected: ['approvals', 'card_drafts', 'wip_slot'],
      exempt: [],
      schema,
      src,
    });
    const r = scanCoverage(paths);
    expect(r.unclassified).toEqual([]);
    expect(r.extraProtected).toEqual(['wip_slot']);
  });

  test('THROWS rather than reporting an empty list when the array is gone', async () => {
    const paths = await fixture({ protected: ['approvals'], exempt: ['card_drafts'], schema, src });
    await writeFile(paths.migrationPath, '-- protected_tables text[] := ARRAY[]\nSELECT 1;');
    // The declaration survives only inside a COMMENT, which stripSqlComments
    // blanks — so the parse must fail closed, not read [].
    expect(() => scanCoverage(paths)).toThrow(/BROKEN GUARD/);
  });
});

// ---------------------------------------------------------------------------
// Rules 2 and 3, driven end to end
// ---------------------------------------------------------------------------

describe('scanCoverage — rules 2 and 3 over a source tree', () => {
  const schema: Array<[string, string]> = [['approvals', 'approvals']];

  test('a clean tree reports nothing', async () => {
    const paths = await fixture({
      protected: ['approvals'],
      exempt: [],
      schema,
      src: { 'a.ts': qualifiedDeletes('approvals', MIN_DRIZZLE_DELETE_SITES) },
    });
    const r = scanCoverage(paths);
    expect(r.bareDeletes).toEqual([]);
    expect(r.truncates).toEqual([]);
    expect(r.rawBareDeletes).toEqual([]);
    expect(r.drizzleDeleteSites).toBe(MIN_DRIZZLE_DELETE_SITES);
  });

  test('finds a bare delete, a TRUNCATE and a bare raw DELETE in one pass', async () => {
    const paths = await fixture({
      protected: ['approvals'],
      exempt: [],
      schema,
      src: {
        'a.ts': qualifiedDeletes('approvals', MIN_DRIZZLE_DELETE_SITES),
        'b.ts': [
          '// TRUNCATE in a comment must not count.',
          'export const bad1 = () => db.delete(approvals);',
          'export const bad2 = () => db.execute(sql`TRUNCATE approvals`);',
          'export const bad3 = () => db.execute(sql`DELETE FROM approvals`);',
        ].join('\n'),
      },
    });
    const r = scanCoverage(paths);
    expect(r.bareDeletes).toHaveLength(1);
    expect(r.bareDeletes[0]!.line).toBe(2);
    expect(r.truncates).toHaveLength(1);
    expect(r.truncates[0]!.line).toBe(3);
    expect(r.rawBareDeletes).toHaveLength(1);
    expect(r.rawBareDeletes[0]!.line).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The real tree — so the header's measured numbers cannot rot in silence
// ---------------------------------------------------------------------------

describe('the real backend tree', () => {
  const real = scanCoverage();

  test('every pgTable in src/db/schema.ts is classified by migration 142', () => {
    expect(real.unclassified).toEqual([]);
    expect(real.overlap).toEqual([]);
    expect(real.staleExempt).toEqual([]);
  });

  test('the banked floors still describe the tree', () => {
    expect(real.bareDeletes).toHaveLength(BARE_DELETE_FLOOR);
    expect(real.truncates).toHaveLength(TRUNCATE_FLOOR);
    expect(real.rawBareDeletes).toHaveLength(RAW_BARE_DELETE_FLOOR);
  });

  test('no bare delete remains in src/ (the fr#1283 site was removed, floor 0)', () => {
    expect(BARE_DELETE_FLOOR).toBe(0);
    expect(real.bareDeletes).toEqual([]);
  });

  test('the non-vacuity floors are not already met by accident', () => {
    expect(real.universe.length).toBeGreaterThanOrEqual(MIN_UNIVERSE);
    expect(real.protectedTables.length).toBeGreaterThanOrEqual(MIN_PROTECTED);
    expect(real.exemptTables.length).toBeGreaterThanOrEqual(MIN_EXEMPT);
    expect(real.drizzleDeleteSites).toBeGreaterThanOrEqual(MIN_DRIZZLE_DELETE_SITES);
  });

  test('migration 142 attaches the guard to `projects`, which the probe reads', () => {
    expect(real.protectedTables).toContain('projects');
    expect(real.exemptTables).not.toContain('projects');
  });
});
