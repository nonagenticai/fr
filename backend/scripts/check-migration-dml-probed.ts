#!/usr/bin/env bun
// backend/scripts/check-migration-dml-probed.ts
//
// Guard: a migration that CHANGES DATA must be visible to the migration
// runner's backfill probe, or say in its own header that it deliberately is
// not.
//
// THE DEFECT
// ----------
// src/db/migration-runner.ts stamps a migration APPLIED WITHOUT RUNNING IT
// whenever `_migrations` is empty and `projects` already exists, unless that
// migration has an entry in `COLUMN_PROBES` whose target is currently missing.
// That "empty ledger, populated schema" state is EXACTLY what CI's bootstrap
// produces: `drizzle-kit push` builds the schema from schema.ts, `ci-seed`
// fills it, and only then does `migrate` run against a ledger that has never
// held a row.
//
// For a pure-DDL migration that is harmless by construction: schema.ts plus
// `drizzle-kit push` reproduce the shape, so skipping the file loses nothing.
//
// For a migration containing DML it is not harmless. `push` reproduces a
// SCHEMA; it cannot reproduce an UPDATE, an INSERT, a DELETE or a TRUNCATE,
// and it does not emit triggers or functions either. So the data effect — the
// backfill, the repair, the row the rest of the system assumes exists — is
// silently skipped while CI reports green, and the first place anybody finds
// out is production.
//
// MEASURED (2026-09-06, on this tree)
// -----------------------------------
//   111 migrations, 24 of which contain DML.
//   4 of those 24 carry a COLUMN_PROBES entry: 072, 076, 081, 104.
//   => 20 unprobed DML migrations; exactly ONE of them (107) states in its
//      header that this is deliberate.
// The class has bitten repeatedly — PR #974 (migration 111) is the most
// recent, and the migration headers record roughly ten prior recurrences,
// each one found only after a production incident, never by CI.
//
// WHY A FLOOR AND NOT THE WHOLE HISTORY
// -------------------------------------
// The obvious rule — "every DML migration must be probed" — would ship with
// 19 violators and need 19 exceptions on day one. A guard that ships red is
// not a guard; it is a backlog with an exit code, and this repo forbids it.
//
// So this enforces a FLOOR: FLOOR_MIGRATION (112), one past the highest file
// that existed when the guard was written (111). Zero violators now, and every
// future data-changing migration is constrained. The 19 historical unprobed-DML
// migrations
// (003, 019, 032, 036, 038, 040, 041, 047, 053, 054, 057, 062, 064, 065, 066,
// 068, 080, 088, 106) are grandfathered as a STATED FACT, not as an allowlist
// anyone has to maintain: their data effect landed in production long ago, so
// re-running them is not the risk. The risk is prospective, and that is the
// only thing this file measures.
//
// THE RULE
// --------
// Every migration numbered >= FLOOR_MIGRATION whose SQL contains DML
// (UPDATE ... SET, INSERT INTO, DELETE FROM, TRUNCATE) or creates a TRIGGER or
// a FUNCTION must EITHER have a COLUMN_PROBES entry in
// src/db/migration-runner.ts, OR carry the exact annotation
// `NOT PROBED, DELIBERATELY` in a comment in its own header.
//
// The probed set is PARSED OFF DISK from migration-runner.ts rather than
// restated here — a probe deleted from the runner must reappear as a violation
// here, not as a stale duplicate that keeps agreeing with a list nobody reads.
//
// WHY COMMENT-STRIPPING IS LOAD-BEARING
// -------------------------------------
// The migrations in this tree carry very long `--` prose headers that DISCUSS
// this exact defect: 107's header contains the words UPDATE, DELETE and
// "backfill" several times over, and 105/106/107 quote each other's SQL inside
// comments. A raw grep for /UPDATE/ over these files is nearly all false
// positives, and a guard that cries wolf gets switched off.
//
// So the SQL is stripped properly before any rule runs, tracking:
//   - `--` to end of line, and NESTED /* ... */ blocks (postgres nests them);
//   - `'...'` literals, `''` escapes, and E'...\'' backslash escapes, so a
//     `--` or a `*/` inside a string is not mistaken for a comment;
//   - `$tag$ ... $tag$` dollar quoting, which is how every function body and
//     DO block in this tree is written — an unhandled `$$` swallows or fakes
//     the rest of the file;
//   - `"..."` quoted identifiers.
// Comments are blanked to spaces with newlines preserved, so reported line
// numbers still point at the real line. The stripped-out comment text is
// returned separately, because the DELIBERATELY annotation must be found in a
// COMMENT — an occurrence inside a string literal is data, not a declaration.
//
// WHY THIS GUARD CANNOT QUIETLY GO BLIND
// --------------------------------------
// By design it has zero violators today, so a green run proves nothing about
// whether the detector still works: break the stripper or a regex and it stays
// green forever. It therefore runs its own control — the same detector over
// the migrations BELOW the floor, which must still flag at least
// HISTORICAL_DML_MIN of them. If that number collapses, the detector is broken
// and the run exits EXIT_BROKEN_GUARD rather than reporting a clean tree.
//
// Run via: `cd backend && bun run scripts/check-migration-dml-probed.ts`
// Wired into CI next to `check-migration-numbers` in the Lint & Type Check job.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIGRATIONS_DIR = join(BACKEND_DIR, 'migrations');
const RUNNER_PATH = join(BACKEND_DIR, 'src', 'db', 'migration-runner.ts');
const TAG = '[check-migration-dml-probed]';

/** Matches `NNN_whatever.sql` (three or more leading digits). */
const MIGRATION_FILE_RE = /^(\d{3,})_.*\.sql$/;

/**
 * The grandfathering floor: migrations numbered >= this are in scope.
 *
 * 112 was one past 111, the highest migration on this tree when the guard was
 * written (2026-09-06), so it shipped GREEN and constrains only work that lands
 * after it. Never raise it to make a new violation go away — that is the whole
 * rule, deleted.
 *
 * ⚠️ 112 IS NOW OCCUPIED AND THE FLOOR DELIBERATELY DID NOT MOVE WITH IT.
 * `112_approval_id_lookup_indexes.sql` landed on main the same day; it is IN
 * SCOPE (>= the floor) and it passes, because it is pure DDL — two
 * `CREATE INDEX IF NOT EXISTS` and nothing else. VERIFIED by running this
 * file's own detector over it: `findDataEffects(stripSqlComments(src).code)`
 * returns `[]`. Raising the floor to 113 would have exempted a file that
 * already satisfies the rule, and would have been a raise-to-go-green in
 * everything but appearance.
 */
export const FLOOR_MIGRATION = 112;

/** Exit code for "the rule found violations". */
export const EXIT_OFFENCES = 1;

/**
 * Exit code for "the guard itself proved nothing" — no migrations scanned, no
 * probes parsed, or the detector no longer recognises the historical DML it is
 * known to contain. Distinct from EXIT_OFFENCES so CI can tell a real finding
 * from a broken invocation.
 */
export const EXIT_BROKEN_GUARD = 2;

/**
 * The opt-out. Exact, uppercase, machine-greppable, and required to sit in a
 * COMMENT. 107 is the one migration on this tree that already carries it.
 */
export const ANNOTATION = 'NOT PROBED, DELIBERATELY';

/**
 * Non-vacuity control: the detector must still flag at least this many
 * below-floor migrations as data-changing. MEASURED at 24 on 2026-09-06
 * (003, 019, 032, 036, 038, 040, 041, 047, 053, 054, 057, 062, 064, 065, 066,
 * 068, 072, 076, 080, 081, 088, 104, 106, 107). If a historical migration is
 * ever legitimately removed, lower this and say why in the same commit — do
 * not delete the control.
 *
 * ⚠️ RE-MEASURED 2026-09-06 after adding the MERGE / CTAS / MATERIALIZED VIEW /
 * setval patterns, and RE-MEASURED AGAIN the same day after adding `nextval(`:
 * still exactly 24 both times. That is not a failure of the new patterns,
 * it is the shape of this tree's history — no migration below the floor uses any
 * of those five constructs, so the control CANNOT be their non-vacuity proof.
 * A pattern with neither a historical hit nor a unit test is decoration.
 */
export const HISTORICAL_DML_MIN = 24;

// ---------------------------------------------------------------------------
// SQL comment stripping
// ---------------------------------------------------------------------------

export interface StrippedSql {
  /** SQL with every comment blanked to spaces; length and line numbers preserved. */
  code: string;
  /** The text of every comment, joined by newlines. */
  comments: string;
}

/**
 * Split a SQL file into executable code and comment prose.
 *
 * String literals, E-strings, dollar-quoted blocks and quoted identifiers are
 * tracked so that a `--` inside any of them is left in `code` rather than
 * eating the rest of the line, and so that a `$$`-quoted function body is not
 * mistaken for a quoting error.
 */
export function stripSqlComments(sql: string): StrippedSql {
  const out: string[] = [];
  const comments: string[] = [];
  let i = 0;

  const blank = (text: string): void => {
    // Preserve newlines so line numbers computed from `code` stay true.
    out.push(text.replace(/[^\n]/g, ' '));
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    // -- line comment
    if (two === '--') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      const text = sql.slice(i, end);
      comments.push(text);
      blank(text);
      i = end;
      continue;
    }

    // /* ... */ block comment, NESTED (postgres allows nesting)
    if (two === '/*') {
      let depth = 0;
      const start = i;
      while (i < sql.length) {
        const t = sql.slice(i, i + 2);
        if (t === '/*') {
          depth += 1;
          i += 2;
        } else if (t === '*/') {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          i += 1;
        }
      }
      const text = sql.slice(start, i);
      comments.push(text);
      blank(text);
      continue;
    }

    // $tag$ ... $tag$ dollar quoting (including bare $$)
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      out.push(sql.slice(i, stop));
      i = stop;
      continue;
    }

    // '...' literal, with '' escapes; E'...' additionally honours backslashes
    if (sql[i] === "'") {
      const isEString = i > 0 && /[Ee]/.test(sql[i - 1]!) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? ' ');
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (isEString && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(sql.slice(start, i));
      continue;
    }

    // "..." quoted identifier, with "" escapes
    if (sql[i] === '"') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out.push(sql.slice(start, i));
      continue;
    }

    out.push(sql[i]!);
    i += 1;
  }

  return { code: out.join(''), comments: comments.join('\n') };
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

export interface DataEffect {
  /** UPDATE / INSERT / DELETE / TRUNCATE / CREATE TRIGGER / CREATE FUNCTION */
  kind: string;
  /** 1-based line in the ORIGINAL file. */
  line: number;
  /** The matched text, trimmed for display. */
  text: string;
}

/**
 * Patterns are deliberately anchored so DDL false-friends do not match:
 *   - `UPDATE` requires a target and a `SET`, so `ON UPDATE CASCADE`,
 *     `FOR UPDATE SKIP LOCKED` and `ON CONFLICT DO UPDATE SET` do not match.
 *     An optional alias is allowed between them: MEASURED, 4 of the 24
 *     historical DML migrations (036, 047, 080, 107) write `UPDATE projects p
 *     SET …`, and an alias-less pattern missed every one of them — which is
 *     precisely the blindness HISTORICAL_DML_MIN exists to catch;
 *   - `DELETE` requires `FROM`, so `ON DELETE CASCADE` does not match.
 * TRIGGER and FUNCTION are in scope for the same reason DML is: `drizzle-kit
 * push` emits neither, so a stamped-but-unrun migration leaves them absent.
 */
const EFFECT_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  {
    kind: 'UPDATE',
    re: /\bUPDATE\s+(?:ONLY\s+)?[A-Za-z_"][\w".]*(?:\s+(?:AS\s+)?[A-Za-z_"][\w"]*)?\s+SET\b/gi,
  },
  { kind: 'INSERT', re: /\bINSERT\s+INTO\b/gi },
  { kind: 'DELETE', re: /\bDELETE\s+FROM\b/gi },
  { kind: 'TRUNCATE', re: /\bTRUNCATE\b/gi },
  { kind: 'CREATE TRIGGER', re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/gi },
  { kind: 'CREATE FUNCTION', re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi },
  // ⭐ ADDED 2026-09-06 — five shapes an adversarial audit found the detector
  // blind to. Each writes rows or advances state that `drizzle-kit push` cannot
  // reproduce, so each was a way to land a data effect past this guard while it
  // reported a clean tree.
  //
  //   MERGE INTO      — the SQL:2003 upsert. Postgres 15+ supports it, this
  //                     fleet is on 18, and it is neither UPDATE nor INSERT
  //                     syntactically, so both patterns above miss it entirely.
  //   CREATE TABLE AS — CTAS materialises ROWS, not a shape. push creates the
  //                     table from schema.ts (empty) and the data never arrives.
  //                     Anchored on `AS SELECT/WITH/VALUES/TABLE` so a plain
  //                     `CREATE TABLE (...)` does not match.
  //   CREATE/REFRESH MATERIALIZED VIEW — a matview holds a materialised result
  //                     set; push emits no views at all, so both the definition
  //                     and its contents are absent.
  //   setval(         — advances a sequence. Nothing about the schema records
  //                     where a sequence was left, and a stamped-not-run
  //                     migration means the next nextval() collides with rows
  //                     that already exist. The classic silent duplicate-key.
  //   nextval(        — ⭐ ADDED after a SECOND audit, which noticed the comment
  //                     above NAMES `nextval()` as the thing that breaks while
  //                     the pattern list matched only `setval(`. It is the same
  //                     defect in the other direction: `nextval` ADVANCES the
  //                     sequence as a side effect of being evaluated (it is not
  //                     a read), so a migration that consumes ids with it —
  //                     `INSERT ... VALUES (nextval('s'), ...)`, or a bare
  //                     `SELECT nextval('s')` to reserve a block — leaves the
  //                     sequence somewhere `drizzle-kit push` cannot reproduce.
  //                     A stamped-not-run file then hands out ids that were
  //                     supposed to be spoken for. Listing the one and not the
  //                     other let exactly half of the sequence-mutation surface
  //                     through a guard whose own comment claimed to cover it.
  { kind: 'MERGE', re: /\bMERGE\s+INTO\b/gi },
  {
    kind: 'CREATE TABLE AS',
    re: /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_"][\w".]*\s*(?:\([^()]*\)\s*)?AS\s+(?:\(\s*)?(?:SELECT|WITH|VALUES|TABLE)\b/gi,
  },
  {
    kind: 'CREATE MATERIALIZED VIEW',
    re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW\b/gi,
  },
  {
    kind: 'REFRESH MATERIALIZED VIEW',
    re: /\bREFRESH\s+MATERIALIZED\s+VIEW\b/gi,
  },
  { kind: 'SETVAL', re: /\bsetval\s*\(/gi },
  { kind: 'NEXTVAL', re: /\bnextval\s*\(/gi },
];

/** Every data effect in already-stripped SQL, with original line numbers. */
export function findDataEffects(code: string): DataEffect[] {
  const effects: DataEffect[] = [];
  for (const { kind, re } of EFFECT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const line = code.slice(0, m.index).split('\n').length;
      effects.push({ kind, line, text: m[0]!.replace(/\s+/g, ' ').trim() });
    }
  }
  return effects.sort((a, b) => a.line - b.line);
}

/**
 * The migration filenames registered in COLUMN_PROBES, read out of
 * migration-runner.ts source rather than restated. Deleting a probe there must
 * surface here as a violation, not as agreement with a stale copy.
 */
export function parseProbedMigrations(runnerSource: string): Set<string> {
  const probed = new Set<string>();
  const re = /migration:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(runnerSource)) !== null) probed.add(m[1]!);
  return probed;
}

export interface Violation {
  file: string;
  number: number;
  effects: DataEffect[];
}

export interface ScanResult {
  /** Migrations at or above the floor that were examined. */
  scanned: number;
  /** Migrations below the floor the detector still recognises as data-changing. */
  historicalDml: string[];
  violations: Violation[];
}

export interface ScanOptions {
  migrationsDir?: string;
  probed?: Set<string>;
  floor?: number;
}

export function scanMigrations(options: ScanOptions = {}): ScanResult {
  const dir = options.migrationsDir ?? MIGRATIONS_DIR;
  const floor = options.floor ?? FLOOR_MIGRATION;
  const probed = options.probed ?? parseProbedMigrations(readFileSync(RUNNER_PATH, 'utf8'));

  const violations: Violation[] = [];
  const historicalDml: string[] = [];
  let scanned = 0;

  for (const name of readdirSync(dir).sort()) {
    const m = MIGRATION_FILE_RE.exec(name);
    if (!m) continue;
    const number = Number(m[1]);
    const { code, comments } = stripSqlComments(readFileSync(join(dir, name), 'utf8'));
    const effects = findDataEffects(code);

    if (number < floor) {
      if (effects.length > 0) historicalDml.push(name);
      continue;
    }

    scanned += 1;
    if (effects.length === 0) continue;
    if (probed.has(name)) continue;
    if (comments.includes(ANNOTATION)) continue;
    violations.push({ file: name, number, effects });
  }

  return { scanned, historicalDml, violations };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const runnerSource = readFileSync(RUNNER_PATH, 'utf8');
  const probed = parseProbedMigrations(runnerSource);

  if (probed.size === 0) {
    console.error(
      `${TAG} BROKEN GUARD: parsed 0 COLUMN_PROBES entries from ${RUNNER_PATH}. ` +
        'The parser or the runner changed shape — refusing to report a clean tree ' +
        'this guard cannot actually see.',
    );
    process.exit(EXIT_BROKEN_GUARD);
  }

  const { scanned, historicalDml, violations } = scanMigrations({ probed });

  if (historicalDml.length < HISTORICAL_DML_MIN) {
    console.error(
      `${TAG} BROKEN GUARD: the detector flags only ${historicalDml.length} of the known ` +
        `${HISTORICAL_DML_MIN} data-changing migrations below the floor. This guard has ` +
        'zero violators by design, so it cannot notice its own blindness any other way. ' +
        'Fix stripSqlComments/EFFECT_PATTERNS, or — if a historical migration was ' +
        'legitimately removed — lower HISTORICAL_DML_MIN in the same commit and say why.',
    );
    process.exit(EXIT_BROKEN_GUARD);
  }

  if (violations.length > 0) {
    console.error(
      `${TAG} FAIL: ${violations.length} migration(s) at or above ${FLOOR_MIGRATION} change ` +
        'data but are invisible to the migration runner:\n',
    );
    for (const v of violations) {
      console.error(`  migrations/${v.file}`);
      for (const e of v.effects.slice(0, 5)) {
        console.error(`    line ${e.line}: ${e.kind} — ${e.text}`);
      }
      if (v.effects.length > 5) console.error(`    … and ${v.effects.length - 5} more`);
      console.error('');
    }
    console.error(
      'WHY: src/db/migration-runner.ts stamps an unprobed migration APPLIED WITHOUT\n' +
        'RUNNING IT when `_migrations` is empty and `projects` exists — which is exactly\n' +
        "what CI's `drizzle-kit push` -> ci-seed -> migrate bootstrap produces. `push`\n" +
        'reproduces a schema; it cannot reproduce an UPDATE, and it emits no triggers or\n' +
        'functions. So the data effect is skipped in silence while CI stays green.\n\n' +
        'FIX — pick one:\n' +
        '  1. Add a COLUMN_PROBES entry for the file in src/db/migration-runner.ts whose\n' +
        '     check returns false when the data effect is absent (a row, a constraint, a\n' +
        '     trigger). Remember the probe is re-evaluated on EVERY boot, so it must stay\n' +
        '     true forever once applied — see 107 for when that is the wrong choice.\n' +
        `  2. Or state the exception in the migration's own header comment, verbatim:\n` +
        `       -- ⚠️ ${ANNOTATION}: <why skipping this on a fresh DB loses nothing>\n` +
        '     107_default_expiry_backfill.sql is the worked example.',
    );
    process.exit(EXIT_OFFENCES);
  }

  console.log(
    `${TAG} OK — ${scanned} migration(s) at or above ${FLOOR_MIGRATION} scanned, ` +
      `0 unprobed data-changing; detector control still flags ${historicalDml.length} ` +
      `grandfathered data-changing migration(s) below the floor (min ${HISTORICAL_DML_MIN}); ` +
      `${probed.size} COLUMN_PROBES entries parsed.`,
  );
}

if (import.meta.main) main();
