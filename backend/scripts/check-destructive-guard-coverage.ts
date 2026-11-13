#!/usr/bin/env bun
// backend/scripts/check-destructive-guard-coverage.ts
//
// Guard: every table fr's drizzle schema declares must be either PROTECTED by
// the runtime destructive-statement triggers or EXPLICITLY EXEMPTED by the
// migration that installs them — and fr's own source must not grow a second
// unqualified `.delete(table)` call site.
//
// WHY THIS EXISTS, AND WHY IT IS THE SECOND OF TWO LAYERS (fr#1283)
// ----------------------------------------------------------------
// The runtime authority is backend/migrations/142_destructive_statement_guard.sql:
// a `BEFORE TRUNCATE` statement trigger plus an `AFTER DELETE ... REFERENCING
// OLD TABLE` statement trigger per protected table, both `ENABLE ALWAYS`, with a
// `SET LOCAL fr.allow_destructive = 'on'` escape hatch.
//
// That layer is PRIMARY because the threat is *any* client holding the owner
// role — a pod, psql at a prompt, an n8n Postgres node, another service handed
// the credential. A static scan of fr's source CANNOT SEE A STATEMENT TYPED AT
// A PROMPT, so a source-only guard would have missed the 2026-09-17
// `pipeline_events.events` wipe (67,143 rows) completely: nothing in that
// estate's source ever contained the statement.
//
// This layer is still necessary, for two failures the trigger cannot see:
//   1. A table added to src/db/schema.ts next month with no trigger attached.
//      The database cannot notice a guard that was never asked for.
//   2. A DB-less CI job. The trigger cannot be exercised at all in
//      `bun run ci:verify`, which has no postgres; this file runs there.
// Four stacked guards on the billing ledger each caught a DIFFERENT real error
// in this estate. This is that shape.
//
// INSTRUMENT INDEPENDENCE IS MANDATORY — NOTHING BELOW IS RESTATED
// ---------------------------------------------------------------
// The protected list is PARSED OUT OF THE MIGRATION SQL (`protected_tables
// text[] := ARRAY[...]` inside the DO block that actually attaches the
// triggers). The exempt list is parsed from the same block. The table universe
// is PARSED OUT OF `pgTable(...)` in src/db/schema.ts.
//
// Neither list may be copied into this file. House rule: a guard that keeps its own copy of the list it is
// checking cannot detect the regression it exists to prevent — deleting a table
// from the migration would leave this file happily agreeing with a constant
// nobody reads. Both sides are read off disk, every run.
//
// ⛔ backend/migrations/ IS DELIBERATELY OUT OF SCOPE FOR THE SOURCE SCAN
// ---------------------------------------------------------------------
// Rule 3 scans `src/` ONLY. TRUNCATE / DELETE inside a migration is already
// classified by scripts/check-migration-dml-probed.ts, which flags any
// migration at or above its floor containing TRUNCATE / DELETE FROM (and
// CREATE TRIGGER / CREATE FUNCTION) unless it is probed or annotated. Scanning
// migrations here too would duplicate that rule with a second, independently
// drifting detector — and the first thing it would flag is migration 142
// itself, whose whole purpose is to name TRUNCATE.
//
// THE RATCHET, AND ITS MEASURED FLOOR
// -----------------------------------
// MEASURED on this tree (2026-10-29), by this file's own detectors:
//   * 78 `pgTable(...)` tables in src/db/schema.ts
//   * 74 protected (incl. 4 migration-only tables absent from schema.ts —
//     campaign_governance_controls, campaign_jobs, card_version_stamps,
//     wip_slot — allowed, and reported) + 8 exempt
//   * 25 `.delete(<drizzle table>)` call sites in src/, none without a
//     `.where`. The last bare one (named in fr#1283) was removed on 2026-10-29
//     with the test-only hooks, and BARE_DELETE_FLOOR was lowered to 0.
//   * 0 real `TRUNCATE` statements and 0 unqualified raw `DELETE FROM <t>` in
//     src/ (the 11 textual `TRUNCATE` hits are all comments or the
//     `TRUNCATED_HEADER` / `TRUNCATION_MARKER` identifiers, which comment- and
//     string-stripping removes). Both floors are therefore 0.
//
// The ratchet is TWO-SIDED: more offenders than the floor fails, and FEWER also
// fails, demanding the literal be lowered in the same PR. A ratchet that
// silently tolerates improvement stops being an instrument — the headroom you
// freed gets quietly refilled by the next PR and nobody sees it.
//
// WHY THIS GUARD CANNOT QUIETLY GO BLIND
// --------------------------------------
// All three rules now have zero violators (rule 2's floor reached 0 on
// 2026-10-29), so a green run proves nothing about whether the detectors work:
// break the schema.ts parser and the universe is empty, so every table is
// trivially "classified"; break the `.delete(` detector and it finds 0 bare
// deletes, which equals the floor, so the ratchet cannot see it. Every derived population therefore has a non-vacuity
// FLOOR of its own (MIN_UNIVERSE, MIN_PROTECTED, MIN_EXEMPT,
// MIN_DRIZZLE_DELETE_SITES) and a miss exits EXIT_BROKEN_GUARD, not
// EXIT_OFFENCES — a broken invocation must never print the clean-tree line.
//
// Run via: `cd backend && bun run scripts/check-destructive-guard-coverage.ts`
// Wired into CI via `bun run ci:verify` (scripts/ci-verify.sh, called by the
// ts-service archetype from .github/workflows/ci.yml).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { stripSqlComments } from './check-migration-dml-probed.ts';

const BACKEND_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TAG = '[check-destructive-guard-coverage]';

/** The migration that IS the runtime authority. Parsed, never restated. */
export const DEFAULT_MIGRATION_PATH = join(
  BACKEND_DIR,
  'migrations',
  '142_destructive_statement_guard.sql',
);
/** The table universe. Parsed, never restated. */
export const DEFAULT_SCHEMA_PATH = join(BACKEND_DIR, 'src', 'db', 'schema.ts');
/** The only tree rule 3 scans. `migrations/` is check-migration-dml-probed's. */
export const DEFAULT_SRC_DIR = join(BACKEND_DIR, 'src');

/** A rule found violations. */
export const EXIT_OFFENCES = 1;
/** The guard proved nothing — a parser or detector went blind. */
export const EXIT_BROKEN_GUARD = 2;

/**
 * Banked unqualified `.delete(<drizzle table>)` call sites in src/.
 *
 * MEASURED at 0 on 2026-10-29, after the one call site named in fr#1283 (a
 * test-only hook) was removed. Two-sided: never raise it to make a new
 * violation go away.
 */
export const BARE_DELETE_FLOOR = 0;

/** Banked real `TRUNCATE` statements in src/. MEASURED at 0 on 2026-09-30. */
export const TRUNCATE_FLOOR = 0;

/** Banked unqualified raw `DELETE FROM <t>` in src/. MEASURED at 0 on 2026-09-30. */
export const RAW_BARE_DELETE_FLOOR = 0;

/**
 * Non-vacuity floors on the DERIVED POPULATIONS, not on findings. Each one
 * answers "could this parser have silently returned nothing?" — the only way a
 * zero-violator guard can notice its own blindness. MEASURED 2026-09-30:
 * universe 69, protected 64, exempt 7, drizzle delete sites 21.
 */
export const MIN_UNIVERSE = 60;
export const MIN_PROTECTED = 50;
export const MIN_EXEMPT = 5;
export const MIN_DRIZZLE_DELETE_SITES = 15;

// ---------------------------------------------------------------------------
// Parsers — both sides read off disk
// ---------------------------------------------------------------------------

/**
 * A `name text[] := ARRAY[ 'a', 'b' ]` literal from already-comment-stripped
 * SQL. Returns null when the declaration is absent, which the caller must treat
 * as a broken guard rather than an empty list.
 */
export function parseSqlTextArray(code: string, name: string): string[] | null {
  const re = new RegExp(`${name}\\s+text\\[\\]\\s*:=\\s*ARRAY\\s*\\[([^\\]]*)\\]`, 'i');
  const m = re.exec(code);
  if (!m) return null;
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/**
 * Every drizzle table in schema.ts, as `{ ident, table }`:
 *   `export const cardDrafts = pgTable('card_drafts', { … })`
 * `ident` is what src/ writes inside `.delete(...)`; `table` is the SQL name the
 * migration's arrays use. Both are needed, and neither may be hardcoded.
 */
export interface SchemaTable {
  ident: string;
  table: string;
}

export function parseSchemaTables(schemaSource: string): SchemaTable[] {
  const out: SchemaTable[] = [];
  const re = /export const ([A-Za-z0-9_$]+)\s*=\s*pgTable\(\s*'([^']+)'/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schemaSource)) !== null) out.push({ ident: m[1]!, table: m[2]! });
  return out;
}

/**
 * Blank TypeScript comments (and, optionally, string literals) to spaces,
 * preserving newlines so reported line numbers stay true.
 *
 * ⚠️ `blankTemplateLiterals` is the load-bearing option and the two rules want
 * OPPOSITE values. Rule 2 matches `.delete(ident)` in real code, so blanking
 * templates is harmless. Rule 3 looks for raw SQL, and in this codebase raw SQL
 * lives INSIDE backtick templates (``sql`DELETE FROM …` ``) — blanking them
 * would make rule 3 vacuous by construction. Single- and double-quoted strings
 * are always blanked: every `'… TRUNCATE …'` in src/ today is a log message or
 * an error string, never a statement.
 */
export function stripTypeScript(
  src: string,
  opts: { blankTemplateLiterals: boolean },
): string {
  const out: string[] = [];
  let i = 0;
  const blank = (text: string): void => {
    out.push(text.replace(/[^\n]/g, ' '));
  };

  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    const q = src[i];
    if (q === "'" || q === '"' || q === '`') {
      const start = i;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      const text = src.slice(start, i);
      if (q === '`' && !opts.blankTemplateLiterals) out.push(text);
      else blank(text);
      continue;
    }
    out.push(src[i]!);
    i += 1;
  }
  return out.join('');
}

/** Every `.ts` file under `dir`, `node_modules` excluded. */
export function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules') continue;
      listTsFiles(p, out);
    } else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

export interface Finding {
  file: string;
  line: number;
  text: string;
}

export interface DeleteScan {
  /** Every `.delete(<drizzle table ident>)` site — the non-vacuity denominator. */
  sites: number;
  /** Those with no `.where(` in the same statement. */
  bare: Finding[];
}

/**
 * `.delete(ident)` where `ident` is a drizzle table from schema.ts, and whether
 * the chained statement carries a `.where(`.
 *
 * Keying on the schema.ts identifier set is what makes this a DRIZZLE detector
 * rather than a `.delete(` grep: src/ holds 72 `.delete(` call sites and 51 of
 * them are `Map`/`Set`/`URLSearchParams` deletes, which take no WHERE and never
 * will. Measured — a naive grep reports 54 "violations", all but one false.
 */
export function scanDrizzleDeletes(code: string, idents: Set<string>, file: string): DeleteScan {
  const bare: Finding[] = [];
  let sites = 0;
  for (const m of code.matchAll(/\.delete\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    if (!idents.has(m[1]!)) continue;
    sites += 1;
    // Walk to the end of the chained statement: the first `;` at depth 0, or a
    // closing bracket that belongs to an enclosing expression.
    let i = m.index! + m[0].length;
    let depth = 0;
    while (i < code.length) {
      const c = code[i]!;
      if (c === '(' || c === '{' || c === '[') depth += 1;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (c === ';' && depth === 0) break;
      i += 1;
    }
    const span = code.slice(m.index!, i);
    if (!/\.where\s*\(/.test(span)) {
      bare.push({
        file,
        line: code.slice(0, m.index!).split('\n').length,
        text: span.replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }
  return { sites, bare };
}

/**
 * Real `TRUNCATE` statements in already-stripped TS (templates KEPT).
 *
 * ⚠️ CASE-SENSITIVE ON PURPOSE, and this was MEASURED, not assumed. A
 * case-insensitive `/\bTRUNCATE\b/` over template-literal-preserving source
 * flags src/services/improvement-cards/relations.ts:186, whose template reads
 * `…would truncate and corrupt the existing list` — English prose in a thrown
 * message, not a statement. Every raw statement in this codebase is written in
 * upper case (`DELETE FROM`, `INSERT INTO`, `SELECT`), and no identifier
 * survives the boundary check (`TRUNCATED_HEADER` / `TRUNCATION_MARKER` both
 * fail `\b` after the final E). A lowercase `truncate table|only` is still
 * caught by the second pattern, so the only shape this misses is a lowercase
 * `truncate <ident>` — which nothing in this tree writes and which the runtime
 * trigger refuses anyway.
 */
export function scanTruncates(code: string, file: string): Finding[] {
  const out: Finding[] = [];
  const re = /\bTRUNCATE\b|\btruncate\s+(?:table|only)\b/g;
  for (const m of code.matchAll(re)) {
    out.push({
      file,
      line: code.slice(0, m.index!).split('\n').length,
      text: code.slice(m.index!, m.index! + 80).replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/**
 * Raw `DELETE FROM <t>` with no `WHERE` and no `USING` before the statement
 * ends. `USING` counts as qualified: this codebase's two bulk prunes are
 * `DELETE FROM t USING doomed WHERE …`, and the WHERE is found anyway — the
 * clause is listed so the intent is legible if one is ever written without it.
 */
export function scanRawBareDeletes(code: string, file: string): Finding[] {
  const out: Finding[] = [];
  for (const m of code.matchAll(/\bDELETE\s+FROM\s+([A-Za-z_][\w.]*)/gi)) {
    const rest = code.slice(m.index!);
    const end = /[;`]/.exec(rest.slice(m[0].length));
    const span = rest.slice(0, m[0].length + (end ? end.index : 200));
    if (/\bWHERE\b/i.test(span)) continue;
    out.push({
      file,
      line: code.slice(0, m.index!).split('\n').length,
      text: span.replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface CoverageResult {
  universe: SchemaTable[];
  protectedTables: string[];
  exemptTables: string[];
  /** schema.ts tables classified neither way — rule 1 violations. */
  unclassified: string[];
  /** In BOTH lists — the partition is not a partition. */
  overlap: string[];
  /** Exempt entries that name no schema.ts table — a stale exemption. */
  staleExempt: string[];
  /** Protected entries outside schema.ts (migration-only tables). Allowed. */
  extraProtected: string[];
  drizzleDeleteSites: number;
  bareDeletes: Finding[];
  truncates: Finding[];
  rawBareDeletes: Finding[];
}

export interface ScanOptions {
  migrationPath?: string;
  schemaPath?: string;
  srcDir?: string;
}

export function scanCoverage(options: ScanOptions = {}): CoverageResult {
  const migrationPath = options.migrationPath ?? DEFAULT_MIGRATION_PATH;
  const schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
  const srcDir = options.srcDir ?? DEFAULT_SRC_DIR;

  const { code: migrationCode } = stripSqlComments(readFileSync(migrationPath, 'utf8'));
  const protectedTables = parseSqlTextArray(migrationCode, 'protected_tables');
  const exemptTables = parseSqlTextArray(migrationCode, 'exempt_tables');
  if (protectedTables === null || exemptTables === null) {
    throw new Error(
      `${TAG} BROKEN GUARD: could not find ` +
        `${protectedTables === null ? 'protected_tables' : 'exempt_tables'} as a ` +
        `\`text[] := ARRAY[…]\` declaration in ${migrationPath}. The migration changed ` +
        'shape; fix parseSqlTextArray rather than restating the list here.',
    );
  }

  const universe = parseSchemaTables(readFileSync(schemaPath, 'utf8'));
  const universeTables = new Set(universe.map((t) => t.table));
  const protectedSet = new Set(protectedTables);
  const exemptSet = new Set(exemptTables);

  const unclassified = [...universeTables]
    .filter((t) => !protectedSet.has(t) && !exemptSet.has(t))
    .sort();
  const overlap = protectedTables.filter((t) => exemptSet.has(t)).sort();
  const staleExempt = exemptTables.filter((t) => !universeTables.has(t)).sort();
  const extraProtected = protectedTables.filter((t) => !universeTables.has(t)).sort();

  const idents = new Set(universe.map((t) => t.ident));
  let drizzleDeleteSites = 0;
  const bareDeletes: Finding[] = [];
  const truncates: Finding[] = [];
  const rawBareDeletes: Finding[] = [];

  for (const file of listTsFiles(srcDir)) {
    // Fixture trees in the unit test live outside BACKEND_DIR; keep the path
    // intelligible instead of slicing a prefix that is not there.
    const rel = file.startsWith(`${BACKEND_DIR}/`) ? file.slice(BACKEND_DIR.length + 1) : file;
    const raw = readFileSync(file, 'utf8');
    const forCode = stripTypeScript(raw, { blankTemplateLiterals: true });
    const forSql = stripTypeScript(raw, { blankTemplateLiterals: false });

    const scan = scanDrizzleDeletes(forCode, idents, rel);
    drizzleDeleteSites += scan.sites;
    bareDeletes.push(...scan.bare);
    truncates.push(...scanTruncates(forSql, rel));
    rawBareDeletes.push(...scanRawBareDeletes(forSql, rel));
  }

  return {
    universe,
    protectedTables,
    exemptTables,
    unclassified,
    overlap,
    staleExempt,
    extraProtected,
    drizzleDeleteSites,
    bareDeletes,
    truncates,
    rawBareDeletes,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function ratchet(
  label: string,
  found: Finding[],
  floor: number,
  literal: string,
  errors: string[],
): void {
  if (found.length > floor) {
    errors.push(
      `${label}: ${found.length} found, floor is ${floor}.\n` +
        found.map((f) => `    ${f.file}:${f.line}: ${f.text}`).join('\n'),
    );
  } else if (found.length < floor) {
    errors.push(
      `${label}: ${found.length} found but the banked floor is ${floor}. ` +
        `The ratchet is two-sided — lower ${literal} to ${found.length} in THIS PR ` +
        'and say why, so the headroom you just freed cannot be quietly refilled.',
    );
  }
}

function main(): void {
  let result: CoverageResult;
  try {
    result = scanCoverage();
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(EXIT_BROKEN_GUARD);
  }

  // Non-vacuity first: a derived population that came back empty makes every
  // rule below trivially satisfied, so this must never report a clean tree.
  const blind: string[] = [];
  if (result.universe.length < MIN_UNIVERSE) {
    blind.push(
      `parsed ${result.universe.length} pgTable(...) tables from ${DEFAULT_SCHEMA_PATH} ` +
        `(expected at least ${MIN_UNIVERSE}) — with an empty universe every table is ` +
        'trivially classified and rule 1 cannot fire.',
    );
  }
  if (result.protectedTables.length < MIN_PROTECTED) {
    blind.push(
      `parsed ${result.protectedTables.length} protected tables from the migration ` +
        `(expected at least ${MIN_PROTECTED}).`,
    );
  }
  if (result.exemptTables.length < MIN_EXEMPT) {
    blind.push(
      `parsed ${result.exemptTables.length} exempt tables from the migration ` +
        `(expected at least ${MIN_EXEMPT}).`,
    );
  }
  if (result.drizzleDeleteSites < MIN_DRIZZLE_DELETE_SITES) {
    blind.push(
      `the drizzle-delete detector found ${result.drizzleDeleteSites} \`.delete(<table>)\` ` +
        `call sites in src/ (expected at least ${MIN_DRIZZLE_DELETE_SITES}). A detector that ` +
        'finds nothing reports 0 bare deletes, which reads as an improvement and trips the ' +
        'ratchet in the flattering direction.',
    );
  }
  if (blind.length > 0) {
    console.error(`${TAG} BROKEN GUARD — this run proved nothing:`);
    for (const b of blind) console.error(`  - ${b}`);
    process.exit(EXIT_BROKEN_GUARD);
  }

  const errors: string[] = [];

  if (result.unclassified.length > 0) {
    errors.push(
      `RULE 1 — ${result.unclassified.length} table(s) in src/db/schema.ts are neither ` +
        'protected nor exempt in backend/migrations/142_destructive_statement_guard.sql:\n' +
        result.unclassified.map((t) => `    ${t}`).join('\n') +
        '\n  FIX: add each one to `protected_tables` (the default — these tables are ' +
        'recovered by RESTORE, never by re-seeding), or to `exempt_tables` WITH a reason ' +
        'in the migration header naming the codified bulk-delete or regeneration path ' +
        'that makes a guard on it a guard on normal operation.',
    );
  }
  if (result.overlap.length > 0) {
    errors.push(
      `RULE 1 — table(s) in BOTH lists, so the partition is not a partition: ` +
        `${result.overlap.join(', ')}`,
    );
  }
  if (result.staleExempt.length > 0) {
    errors.push(
      `RULE 1 — exempt entr(ies) naming no table in src/db/schema.ts: ` +
        `${result.staleExempt.join(', ')}. A stale exemption is an exemption nobody ` +
        're-read; delete it.',
    );
  }

  ratchet('RULE 2 — unqualified `.delete(<drizzle table>)` in src/', result.bareDeletes, BARE_DELETE_FLOOR, 'BARE_DELETE_FLOOR', errors);
  ratchet('RULE 3a — `TRUNCATE` in src/', result.truncates, TRUNCATE_FLOOR, 'TRUNCATE_FLOOR', errors);
  ratchet('RULE 3b — raw `DELETE FROM <t>` with no WHERE in src/', result.rawBareDeletes, RAW_BARE_DELETE_FLOOR, 'RAW_BARE_DELETE_FLOOR', errors);

  if (errors.length > 0) {
    console.error(`${TAG} FAIL:\n`);
    for (const e of errors) console.error(`  ${e}\n`);
    console.error(
      'WHY THIS MATTERS: the runtime triggers in migration 142 are the primary defence, ' +
        'but the database cannot notice a guard that was never asked for, and it cannot be ' +
        'exercised at all in a DB-less CI job. See fr#1283.',
    );
    process.exit(EXIT_OFFENCES);
  }

  console.log(
    `${TAG} OK — ${result.universe.length} pgTable(...) table(s) in schema.ts, all classified ` +
      `(${result.protectedTables.length} protected incl. ${result.extraProtected.length} ` +
      `migration-only [${result.extraProtected.join(', ')}], ${result.exemptTables.length} ` +
      `exempt); ${result.drizzleDeleteSites} \`.delete(<table>)\` site(s) in src/, ` +
      `${result.bareDeletes.length} unqualified (floor ${BARE_DELETE_FLOOR}); ` +
      `${result.truncates.length} TRUNCATE (floor ${TRUNCATE_FLOOR}); ` +
      `${result.rawBareDeletes.length} raw unqualified DELETE FROM (floor ${RAW_BARE_DELETE_FLOOR}).`,
  );
}

if (import.meta.main) main();
