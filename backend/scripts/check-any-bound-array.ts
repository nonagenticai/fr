#!/usr/bin/env bun
// backend/scripts/check-any-bound-array.ts
//
// THE DEFECT THIS EXISTS TO MAKE UNREPEATABLE
// ===========================================
// Inside a drizzle `sql` tagged template, a bound JS array is NOT expanded into
// an array parameter. `PgDialect.sqlToQuery` expands it into a ROW CONSTRUCTOR,
// so
//
//     sql`UPDATE approvals … WHERE id = ANY(${approvalIds}::uuid[])`
//
// renders as
//
//     UPDATE approvals … WHERE id = ANY(($1, $2)::uuid[])
//
// and Postgres refuses it outright: `cannot cast type record to uuid[]`.
// MEASURED against a real database, both halves, 2026-09-10:
//
//     FIXED   UPDATE … WHERE id IN ($1::uuid, $2::uuid)     -> EXECUTES
//     BROKEN  UPDATE … WHERE id = ANY(($1, $2)::uuid[])     -> FAILS
//
// ⭐ WHY IT IS WORTH A BLOCKING GUARD RATHER THAN A CODE REVIEW NOTE. The live
// instance was `workers/approval-expiry.ts::recordCallbacksDeferred`, whose only
// caller wraps it in a `try/catch` that does nothing but `console.error`. So the
// statement threw on EVERY invocation, silently, and not one row the expiry tick
// ran out of time to notify was ever stamped with the marker that exists
// precisely so a human can FIND those rows. The instrument for the failure was
// itself the thing that was broken, and nothing in the tick's result, its
// metrics or its logs could say so.
//
// ⭐ AND WHY IT IS A CLASS, NOT AN INSTANCE. `workers/deblock-callback-
// redelivery.ts` already carries a long comment calling this exact spelling
// "refuted", measured against `PgDialect.sqlToQuery` before that file shipped —
// and it even names `workers/approval-expiry.ts` as a live offender it chose not
// to edit ("a peer's file; reported rather than edited"). Somebody had already
// learned this, written it down, and the second site stayed broken for weeks
// anyway. A written-down rule that has been broken after being written down is
// exactly the thing that has to be mechanised.
//
// ---------------------------------------------------------------------------
// THE RULE, stated exactly
// ---------------------------------------------------------------------------
// Inside a template literal tagged with the drizzle `sql` tag (the bare
// identifier `sql`, OR any local alias of it — `import { sql as drizzleSql }`),
// an interpolation that sits directly inside a comparison-quantifier opener —
//
//     … <op> ANY( ${expr}
//
// — is an offence UNLESS `expr` is `<tag>.join(…)` or `<tag>.raw(…)`.
//
//   <op>         =  <>  !=  <  <=  >  >=  ~  ~*  !~  !~*  ~~  ~~*  !~~  !~~*
//                LIKE  ILIKE  NOT LIKE  NOT ILIKE
//   quantifier   ANY  SOME  ALL       — MATCHED CASE-INSENSITIVELY
//
// ⭐ CASE-INSENSITIVITY IS NOT A NICETY, IT IS THE WHOLE BUG THIS SECTION EXISTS
// TO RECORD. The first cut of this guard matched `ANY` literally, so
//
//     sql`SELECT 1 WHERE id = any(${ids}::uuid[])`
//
// scored `{"offences":[],"exit":0}` — a CLEAN CERTIFICATE over the identical row
// constructor, because Postgres does not care about the case and the guard did.
// A guard against a silent-blindness defect that is itself silently blind is
// strictly worse than no guard, because it certifies. `SOME` (a Postgres synonym
// for `ANY`) and `ALL` bind their operand the same way and were missed for the
// same reason: the matcher enumerated one spelling of a class.
//
// `ALL` still REQUIRES an operator in front of it, and that is deliberate:
// `UNION ALL (${subquery})` is ordinary SQL and carries no comparison operator,
// so it cannot match.
//
// The correct spelling is the one already in use at
// `routes/tools/analytics.ts` and now at `workers/approval-expiry.ts`:
//
//     WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
//
// which renders `IN ($1::uuid, $2::uuid)`.
//
// ---------------------------------------------------------------------------
// HOW IT AVOIDS FLAGGING COMMENTS, PROSE AND ORDINARY STRINGS — three layers
// ---------------------------------------------------------------------------
// This matters more than usual here, because the repo deliberately CONTAINS the
// forbidden spelling as prose: `workers/deblock-callback-redelivery.ts:1426`
// and `:1435`, and `lib/void-approvals.ts:164`. A guard that reds on those is a
// guard that gets an allowlist entry within a week and means nothing by month
// two. Three independent layers, each of which alone kills all three:
//
//   1. COMMENTS ARE BLANKED FIRST, offset-preservingly (`stripComments`):
//      every `/* … */` block and every whole-line `//` becomes spaces, newlines
//      survive, so a reported `file:LINE` is still true. All three real-world
//      mentions above are comments and die here.
//   2. ONLY drizzle-TAGGED TEMPLATE LITERALS ARE SCANNED AT ALL. Not files, not
//      lines — the scanner walks the source, tracks quotes and template nesting,
//      and considers ONLY the text of a template literal whose tag is the bare
//      identifier `sql` or a local alias of the drizzle `sql` import resolved
//      from THAT FILE's own `from 'drizzle-orm'` clause. A log message, an
//      error string, a regex, a prose
//      constant or a `--json` help text mentioning `= ANY(${…})` is invisible to
//      it, because it is not a `sql` template.
//   3. THE MATCH IS ANCHORED AT THE INTERPOLATION BOUNDARY, not run as a regex
//      over text. For each interpolation the scanner already knows exactly which
//      literal chunk precedes it; the rule asks only whether THAT chunk ENDS
//      with a comparison-`ANY(` opener. A mention of the pattern anywhere else
//      inside the same SQL string — `-- never spell this = ANY(x)` — is not a
//      boundary and cannot match.
//
// ⚖️ WHY THE TAG MUST BE A DRIZZLE TAG, AND WHY THAT IS NOT PEDANTRY. The other
// template tag in this codebase is postgres.js — `queryClient`/`sql` from
// `db/client`, and the test files' `queryClient as sql`. postgres.js DOES bind a
// JS array as a real Postgres array, so `= ANY(${ids})` is CORRECT there and
// flagging it would be a false positive on working code. `tests/**` is NOT
// scanned (it is postgres.js territory by convention), and only a drizzle tag
// name is honoured.
//
// ⭐ AND WHY THE ALIAS HAD TO BE ADDED. `routes/projects.ts` and
// `routes/execution-approvals.ts` both write `import { …, sql as drizzleSql }
// from 'drizzle-orm'` and carry 7 `drizzleSql\`…\`` templates between them. To a
// matcher keyed on the literal identifier `sql`, those 7 statements did not
// exist — the SAME class of miss as the lowercase one, just spelt in JS instead
// of SQL. Aliases are resolved PER FILE from the file's own drizzle-orm import,
// so an alias cannot leak across files and a `postgres.js` client that happens
// to be named `sql` is unaffected by the mechanism.
//
// ---------------------------------------------------------------------------
// WHAT IT DELIBERATELY DOES NOT FLAG — each one is legal SQL
// ---------------------------------------------------------------------------
//   * `= ANY(ARRAY[1,2])` and `= ANY('{a,b}')` — no interpolation at all, so no
//     binding, so no row constructor. Never matched, by construction.
//   * `= ANY(${sql.raw('ARRAY[1,2]')})` — `sql.raw` splices TEXT, not a bound
//     parameter, so no row constructor is produced.
//   * `= ANY(${sql.join(…)})` — `sql.join` produces a comma-separated fragment,
//     not a bound array.
//
// ---------------------------------------------------------------------------
// KNOWN LIMITS, recorded rather than hidden
// ---------------------------------------------------------------------------
//   * IT DOES NOT PROVE THE ARRAY IS AN ARRAY. `= ANY(${someString})` binds a
//     single scalar, renders `ANY($1)`, and Postgres will complain at runtime
//     about the operand type rather than about a record cast. This guard reds on
//     it anyway, and that is the safe polarity: `= ANY(<bound>)` is never the
//     idiom this repo wants.
//   * `sql.raw(`…`)` BODIES ARE NOT SCANNED. The backtick there is not tagged
//     `sql`, so raw text assembled by interpolation is out of scope. That shape
//     is a SQL-injection question, which `check-client-input-not-upstream.ts`
//     and review own — not a binding question.
//   * A NON-`sql` TEMPLATE NESTED INSIDE A `sql` INTERPOLATION is scanned as
//     part of the enclosing statement (the scanner recurses through `${…}`).
//     That direction is deliberate: a fragment builder that produces the broken
//     spelling is still the broken spelling.
//   * IT PROVES A SPELLING, NOT AN EXECUTION. A statement can be perfectly spelt
//     and never run.
//   * A POSTGRES.JS CLIENT NAMED `sql` IS SCANNED AS IF IT WERE DRIZZLE, and for
//     that client `= ANY(${ids})` is CORRECT. `db/migration-runner.ts:610` and
//     `scripts/{ci-seed,require-db-reachable,encrypt-channel-credentials}.ts` all
//     do `const sql = postgres(url)` inside the scanned scope. Nothing there uses
//     `ANY(` today, so the guard is green — but if one ever does, the finding is
//     a FALSE POSITIVE and the fix is to rename the local client (e.g. `pg`), not
//     to allowlist the file. This polarity is chosen on purpose: over-flagging is
//     visible on the next CI run, under-flagging is what shipped for months.
//   * AN OPERATOR OUTSIDE THE ENUMERATED SET IS NOT COVERED — `@> ANY(${xs})`,
//     `&& ANY(…)`, a user-defined operator, `SIMILAR TO ANY(…)`. All are equally
//     broken in drizzle; none appears in this repo. The alternative — accepting
//     the whole Postgres operator-character class `+-*/<>=~!@#%^&|?` — makes
//     `--` an operator, so a commented-out `-- ANY(${x})` line inside a SQL
//     template would red. Enumerating is the trade; extend the list when a real
//     site needs it.
//   * A NESTED `sql` FRAGMENT AS THE OPERAND — `= ANY(${sql`ARRAY[1,2]`})` —
//     IS FLAGGED, and that one is a genuine false positive: a nested fragment
//     splices SQL text, it does not bind. Only `<tag>.join(…)`/`<tag>.raw(…)`
//     are exempt. Measured: no such site exists in `src` or `scripts` today. If
//     one appears, rewrite it as `<tag>.raw(…)` (which says the same thing and
//     is exempt) rather than widening the exemption to "any nested template" —
//     that widening would also exempt `= ANY(${sql`${ids}`})`, which DOES bind.
//   * A DRIZZLE TAG ALIASED THROUGH A LOCAL RE-EXPORT is not resolved. Only
//     `… from 'drizzle-orm'` (and its subpaths) is read for aliases; a
//     `export { sql } from 'drizzle-orm'` in `db/helpers.ts` re-imported as
//     `import { sql as s } from '../db/helpers'` would be missed. There is no
//     such re-export in this repo — `grep -rn "from 'drizzle-orm'" src scripts`
//     is the check that keeps that true.
//
// ---------------------------------------------------------------------------
// EXIT CODES — a finding is never confused with a broken run
// ---------------------------------------------------------------------------
//   0                     — scanned a NON-EMPTY scope and found no offence.
//   EXIT_OFFENCES (1)     — the guard worked and found real violations.
//   EXIT_BROKEN_SCOPE (2) — the guard could not see what it polices: ANY ONE of
//                           the configured roots is missing, ANY ONE of them
//                           contributed ZERO files, or zero `sql` template
//                           interpolations were found across the whole scanned
//                           set. ⛔ THE PER-ROOT CONDITION IS WHAT MAKES WIDENING
//                           THE SCOPE SAFE: with a single global file count, a
//                           second root that resolves to nothing (renamed,
//                           deleted, a typo in the list) is invisible — `src`
//                           alone keeps the count non-zero and the run prints
//                           the same green line while half the scope is unread.
//                           ⛔ FAIL-CLOSED IS THE POINT: a scan of
//                           nothing is otherwise byte-identical to a scan of a
//                           clean tree, and "0 offences" over 0 files is the
//                           single most common way a guard dies green. The
//                           second condition is the stronger one — it fails the
//                           run if the TEMPLATE SCANNER itself stops matching,
//                           which is how this guard would go inert without
//                           anybody deleting a line of it.
//
// ---------------------------------------------------------------------------
// SCOPE — which roots, and which were considered and rejected
// ---------------------------------------------------------------------------
//   src      — the application. Always was.
//   scripts  — ⭐ ADDED. The guard did not check the directory it LIVES IN, so it
//              did not police itself and did not police any repair/backfill
//              script. Those are the scripts that run one-shot against
//              production data, with no second pair of eyes and often no test;
//              `scripts/backfill-expired-signoff-requeue.ts` already imports the
//              drizzle `sql` tag, and a repair script for the deblock
//              delivered-stamp is being written against the approvals table now.
//              A one-shot script that throws on every invocation inside a
//              `catch` that only logs is EXACTLY the shipped defect, minus the
//              tests.
//
// Considered and rejected:
//   tests/**      — postgres.js territory (`queryClient as sql`), where a bound
//                   JS array IS a real Postgres array and `= ANY(${ids})` is the
//                   correct spelling. Scanning it would red working code.
//   migrations/** — `.sql` files. No JS template, no binding, nothing to see.
//   index.ts, drizzle.config.ts (backend root) — measured: zero template
//                   literals tagged `sql`. Rejected to keep the roots directory-
//                   shaped rather than a file allowlist that rots silently.
//   frontend/**   — no drizzle dependency at all.
//
// Usage:
//   bun run scripts/check-any-bound-array.ts
//   bun run scripts/check-any-bound-array.ts --root=src --root=scripts
//   bun run scripts/check-any-bound-array.ts --src-root=/some/other/src
//   bun run scripts/check-any-bound-array.ts --json

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BACKEND_DIR = join(import.meta.dir, '..');
const REPO_ROOT = join(BACKEND_DIR, '..');

/** Two distinct non-zero exits. See the header block for why. */
export const EXIT_OFFENCES = 1;
export const EXIT_BROKEN_SCOPE = 2;

export const DEFAULT_SRC_ROOT = join(BACKEND_DIR, 'src');

/**
 * The roots CI scans, relative to `backend/`. See the SCOPE block in the header
 * for what was considered and rejected. Every one of these must exist AND yield
 * at least one file, or the run exits 2.
 */
export const SCAN_ROOTS = ['src', 'scripts'];

/** The one correct spelling, quoted verbatim in every failure message. */
export const CORRECT_SPELLING =
  'WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})';

// ---------------------------------------------------------------------------
// Comment stripping — layer 1
// ---------------------------------------------------------------------------

/**
 * Offset-preserving comment strip: every comment character becomes a space and every
 * newline survives, so a reported `file:LINE` is true in a 1500-line worker.
 *
 * Block comments and whole-line `//` only. Trailing `//` comments are left
 * alone on purpose — stripping those needs to know about string literals, and
 * `'https://…'` is common enough to corrupt real code. A trailing comment is not
 * a hazard here anyway: layer 2 requires the text to be inside a `sql` template,
 * and layer 3 requires it to sit at an interpolation boundary.
 */
export function stripComments(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  return withoutBlocks
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? blank(line) : line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// The template scanner — layer 2
// ---------------------------------------------------------------------------

/** One `${…}` inside a `sql` tagged template, with the literal chunk before it. */
export interface SqlInterpolation {
  /** Absolute index of the `$` opening this interpolation. */
  dollarIndex: number;
  /** Absolute index where `literalBefore` starts. */
  literalStart: number;
  /** Template text between the previous interpolation (or the tag) and this one. */
  literalBefore: string;
  /** Source text of the interpolated expression, exclusive of `${` and `}`. */
  exprSrc: string;
}

/** `text[i]` is `'` or `"`. Returns the index just past the closing quote. */
function skipQuoted(text: string, i: number): number {
  const q = text[i];
  i += 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    // An unterminated quote would otherwise swallow the rest of the file and
    // silently hide every later template. Bail at the newline instead.
    if (c === '\n') return i;
    i += 1;
  }
  return i;
}

/** The tag name every file gets for free, alias resolution or not. */
export const DEFAULT_TAG_NAMES: ReadonlySet<string> = new Set(['sql']);

/** `import { … } from 'drizzle-orm'` / `'drizzle-orm/…'`, brace clause captured. */
const DRIZZLE_IMPORT_RE =
  /import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]drizzle-orm(?:\/[^'"]*)?['"]/g;
/** `sql as drizzleSql` inside such a clause. */
const SQL_ALIAS_RE = /\bsql\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * Every identifier that names the drizzle `sql` tag IN THIS FILE: the bare `sql`
 * always, plus any `sql as X` alias imported from drizzle-orm here.
 *
 * ⚠️ Resolution is PER FILE on purpose. A global alias set would let one file's
 * `sql as q` make every other file's unrelated `q` template a scan target.
 */
export function resolveSqlTagNames(text: string): Set<string> {
  const names = new Set(DEFAULT_TAG_NAMES);
  for (const imp of text.matchAll(DRIZZLE_IMPORT_RE)) {
    for (const alias of (imp[1] ?? '').matchAll(SQL_ALIAS_RE)) {
      if (alias[1]) names.add(alias[1]);
    }
  }
  return names;
}

/**
 * Walk back from a backtick over whitespace and decide whether the tag is one of
 * this file's drizzle tag names. `sql.raw(`…`)` walks back to `(`, which is not
 * an identifier, so it is correctly NOT tagged.
 */
export function isSqlTagged(
  text: string,
  backtickIndex: number,
  tagNames: ReadonlySet<string> = DEFAULT_TAG_NAMES,
): boolean {
  let j = backtickIndex - 1;
  while (j >= 0 && /\s/.test(text[j]!)) j -= 1;
  let end = j + 1;
  while (j >= 0 && /[A-Za-z0-9_$]/.test(text[j]!)) j -= 1;
  return tagNames.has(text.slice(j + 1, end));
}

/**
 * `text[i]` is the opening backtick. Records every interpolation of THIS
 * template when `tagged`, and recurses into each `${…}` so a nested `sql`
 * template (which is how `sql.join(ids.map((id) => sql`${id}::uuid`), …)` is
 * written) is scanned too. Returns the index just past the closing backtick.
 */
function scanTemplate(
  text: string,
  i: number,
  tagged: boolean,
  out: SqlInterpolation[],
  tagNames: ReadonlySet<string>,
): number {
  i += 1;
  let literalStart = i;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return i + 1;
    if (c === '$' && text[i + 1] === '{') {
      const dollarIndex = i;
      const exprStart = i + 2;
      const exprEnd = scanExpr(text, exprStart, out, tagNames); // index just past `}`
      if (tagged) {
        out.push({
          dollarIndex,
          literalStart,
          literalBefore: text.slice(literalStart, dollarIndex),
          exprSrc: text.slice(exprStart, Math.max(exprStart, exprEnd - 1)),
        });
      }
      i = exprEnd;
      literalStart = i;
      continue;
    }
    i += 1;
  }
  return i;
}

/**
 * `i` points just past `${`. Returns the index just past the matching `}`.
 * Tracks quotes and nested templates so a `}` inside a string cannot close the
 * expression early.
 */
function scanExpr(
  text: string,
  i: number,
  out: SqlInterpolation[],
  tagNames: ReadonlySet<string>,
): number {
  let depth = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i);
      continue;
    }
    if (c === '`') {
      i = scanTemplate(text, i, isSqlTagged(text, i, tagNames), out, tagNames);
      continue;
    }
    if (c === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return i;
}

/** Every interpolation inside every drizzle-tagged template in `text`. */
export function collectSqlInterpolations(
  text: string,
  tagNames: ReadonlySet<string> = DEFAULT_TAG_NAMES,
): SqlInterpolation[] {
  const out: SqlInterpolation[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i);
      continue;
    }
    if (c === '`') {
      i = scanTemplate(text, i, isSqlTagged(text, i, tagNames), out, tagNames);
      continue;
    }
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rule — layer 3
// ---------------------------------------------------------------------------

/**
 * Whitespace, or a SQL line comment that ENDS in a newline, between the tokens
 * of the opener. This only ever WIDENS what matches — it can never suppress a
 * match — which is the safe direction for a gap rule.
 *
 * ⛔ The tempting alternative, stripping `--` to end-of-line out of the SQL
 * before matching, is the UNSAFE direction: `WHERE note = '-- x' AND id =
 * ANY(${ids})` would lose the real offence with the fake comment, turning a
 * finding into silence. JS `/* … *\/` comments need no handling here; layer 1
 * has already blanked them to spaces.
 */
const GAP = String.raw`(?:\s|--[^\n]*\n)*`;

/**
 * Every operator that takes a quantified operand in Postgres AND appears (or
 * plausibly appears) in this repo's SQL. Longest-first so `<=` is never consumed
 * as a bare `<` and `!~~*` is never consumed as `!~`. See KNOWN LIMITS for the
 * operators deliberately left out and why the full operator-character class is
 * not used.
 */
const OPERATORS = String.raw`!~~\*|!~~|!~\*|!~|~~\*|~~|~\*|~|<>|!=|<=|>=|=|<|>|\b(?:NOT\s+)?I?LIKE\b`;

/** `ANY`, its SQL synonym `SOME`, and `ALL` — all three bind the same way. */
const QUANTIFIERS = String.raw`ANY|SOME|ALL`;

/**
 * THE OPENER, anchored at the END of the literal chunk.
 *
 * `$` is the whole reason this cannot fire on prose: it matches only when the
 * `ANY(` is the LAST thing before the interpolation, i.e. when the bound value
 * really is the ANY operand. `-- do not write = ANY(x)` earlier in the same
 * statement is not at the boundary and cannot match.
 *
 * ⭐ THE `i` FLAG IS LOAD-BEARING AND MUST NOT BE DROPPED. Postgres is
 * case-insensitive about `ANY`; a case-SENSITIVE guard reported `{"offences":[],
 * "exit":0}` over `= any(${ids}::uuid[])`, which throws exactly as loudly as the
 * uppercase spelling. `tests/unit/scripts/check-any-bound-array.test.ts` carries
 * `any(`, `Any(`, `aNy(`, `some(` and `all(` as fixtures so dropping the flag
 * cannot pass review twice.
 */
export const ANY_OPENER_RE = new RegExp(
  `(${OPERATORS})${GAP}(${QUANTIFIERS})${GAP}\\(${GAP}$`,
  'i',
);

/**
 * A `<tag>.join(…)` / `<tag>.raw(…)` call — the two drizzle SQL-fragment
 * builders, neither of which produces a bound parameter and so neither of which
 * can produce a row constructor.
 *
 * ⚠️ THE RECEIVER IS CAPTURED, NOT ASSUMED, and `isExemptExpr` checks it against
 * the file's drizzle tag names. Exempting any `x.join(` would exempt
 * `= ANY(${ids.join(',')})` — `Array.prototype.join`, a bound STRING, which this
 * guard reds on purpose.
 */
export const EXEMPT_EXPR_RE = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*(join|raw)\s*\(/;

/** Exempt only when the `.join(`/`.raw(` receiver is a drizzle tag in this file. */
export function isExemptExpr(
  expr: string,
  tagNames: ReadonlySet<string> = DEFAULT_TAG_NAMES,
): boolean {
  const m = EXEMPT_EXPR_RE.exec(expr);
  return m !== null && tagNames.has(m[1]!);
}

export interface Offence {
  file: string;
  line: number;
  /** The interpolated expression, trimmed and clipped, for the message. */
  expr: string;
  /** The comparison operator that opened the quantifier, verbatim. */
  operator: string;
  /** `ANY` / `SOME` / `ALL`, verbatim — case included, so a miss is readable. */
  quantifier: string;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') n += 1;
  return n;
}

export interface ScannedFile {
  path: string;
  text: string;
}

export interface ScanSummary {
  offences: Offence[];
  filesScanned: number;
  /** Total `sql` template interpolations seen — the guard's own non-vacuity denominator. */
  interpolations: number;
}

/** Run the whole rule over a set of already-read files. Pure; no I/O. */
export function findAnyBoundArray(files: readonly ScannedFile[]): ScanSummary {
  const offences: Offence[] = [];
  let interpolations = 0;

  for (const file of files) {
    const prepared = stripComments(file.text);
    // Tag names are resolved from THIS file only — see `resolveSqlTagNames`.
    const tagNames = resolveSqlTagNames(prepared);
    const found = collectSqlInterpolations(prepared, tagNames);
    interpolations += found.length;

    for (const interp of found) {
      const opener = ANY_OPENER_RE.exec(interp.literalBefore);
      if (!opener) continue;
      const expr = interp.exprSrc.trim();
      if (isExemptExpr(expr, tagNames)) continue;
      // Report the line of the `ANY(` opener, not of the `${`: a formatter that
      // wraps the interpolation onto its own line must not move the finding away
      // from the operator that names it.
      const openerAbs = interp.literalStart + interp.literalBefore.length - opener[0].length;
      offences.push({
        file: file.path,
        line: lineOf(prepared, openerAbs),
        expr: expr.length > 80 ? `${expr.slice(0, 77)}…` : expr,
        operator: opener[1]!,
        quantifier: opener[2]!,
      });
    }
  }

  return { offences, filesScanned: files.length, interpolations };
}

/** What one configured root contributed. Absent or empty is a BROKEN SCOPE. */
export interface RootScan {
  /** The root as configured, e.g. `scripts`. */
  root: string;
  /** Resolved absolute directory. */
  dir: string;
  /** Did it resolve to a directory at all? */
  present: boolean;
  /** `.ts` files it contributed. */
  files: number;
}

/**
 * THE EXIT CONTRACT AS A PURE FUNCTION, so the fail-closed branches are
 * reachable from a unit test. An untestable fail-open branch is how a guard
 * stays green over an empty scope for months.
 *
 * ⛔ `rootScans` IS THE HALF THAT MAKES A WIDENED SCOPE HONEST. A global file
 * count cannot tell "both roots read" from "`src` read, `scripts` renamed and
 * silently contributing nothing" — the totals stay large and the run stays
 * green. Every configured root must be present AND contribute at least one file.
 */
export function decideExit(summary: ScanSummary, rootScans: readonly RootScan[] = []): number {
  for (const r of rootScans) {
    if (!r.present || r.files === 0) return EXIT_BROKEN_SCOPE;
  }
  if (summary.filesScanned === 0) return EXIT_BROKEN_SCOPE;
  if (summary.interpolations === 0) return EXIT_BROKEN_SCOPE;
  if (summary.offences.length > 0) return EXIT_OFFENCES;
  return 0;
}

export function offenceMessage(offences: readonly Offence[]): string {
  const lines = offences.map(
    (o) =>
      `  ${o.file}:${o.line}  ${o.operator} ${o.quantifier}(\${${o.expr}})` +
      '  <- binds a JS array into a ROW CONSTRUCTOR',
  );
  return (
    `FAIL: ${offences.length} drizzle \`sql\` template(s) bind a JS array into ` +
    `\`ANY(...)\`.\n${lines.join('\n')}\n\n` +
    'drizzle expands a bound array into a row constructor, so this renders as\n' +
    '  ANY(($1, $2)::uuid[])\n' +
    'and Postgres rejects it: `cannot cast type record to uuid[]`. The statement\n' +
    'throws on EVERY invocation — and where the caller catches and only logs, it\n' +
    'throws SILENTLY and writes nothing at all.\n\n' +
    `Correct spelling:\n  ${CORRECT_SPELLING}\n\n` +
    '(`sql.join(...)` and `sql.raw(...)` are exempt — neither binds a parameter.)'
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Every `.ts` beneath `root`, absolute, sorted. `.d.ts` and node_modules skipped. */
export function discoverSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** `--root=` (repeatable) / `--src-root=` (single, back-compat) / default roots. */
export function parseRoots(argv: readonly string[]): string[] {
  const roots = argv.filter((a) => a.startsWith('--root=')).map((a) => a.slice('--root='.length));
  if (roots.length > 0) return roots.map((r) => resolve(BACKEND_DIR, r));
  const srcRootArg = argv.find((a) => a.startsWith('--src-root='));
  if (srcRootArg) return [resolve(srcRootArg.slice('--src-root='.length))];
  return SCAN_ROOTS.map((r) => join(BACKEND_DIR, r));
}

function main(): void {
  const roots = parseRoots(process.argv);
  const asJson = process.argv.includes('--json');

  const rootScans: RootScan[] = [];
  const files: ScannedFile[] = [];
  for (const dir of roots) {
    let present = false;
    try {
      present = statSync(dir).isDirectory();
    } catch {
      present = false;
    }
    const found = present ? discoverSourceFiles(dir) : [];
    rootScans.push({ root: relative(BACKEND_DIR, dir) || dir, dir, present, files: found.length });
    for (const abs of found) {
      files.push({ path: relative(REPO_ROOT, abs), text: readFileSync(abs, 'utf8') });
    }
  }

  const summary = findAnyBoundArray(files);
  const code = decideExit(summary, rootScans);
  const rootLine = rootScans
    .map((r) => `${r.root}=${r.present ? `${r.files} file(s)` : 'MISSING'}`)
    .join(', ');

  if (asJson) {
    console.log(JSON.stringify({ ...summary, roots: rootScans, exit: code }, null, 2));
  }

  if (code === EXIT_BROKEN_SCOPE) {
    console.error(
      `ERROR: scope is broken. Roots: ${rootLine}. Total ${summary.filesScanned} file(s) ` +
        `carrying ${summary.interpolations} drizzle \`sql\` template interpolation(s). A root ` +
        'that is MISSING or contributed ZERO files, or a total of zero interpolations, means ' +
        'this run proves nothing — either the scope is empty or the template scanner has ' +
        'stopped matching. Fail-closed by design; a scan of nothing must never print the ' +
        'same line as a clean scan.',
    );
    process.exit(EXIT_BROKEN_SCOPE);
  }

  if (code === EXIT_OFFENCES) {
    console.error(offenceMessage(summary.offences));
    process.exit(EXIT_OFFENCES);
  }

  if (!asJson) {
    // THE DENOMINATORS ARE LOAD-BEARING on the OK path too — without them a
    // green run and a run that saw nothing read identically. PER ROOT, because a
    // total hides a root that went empty.
    console.log(
      `OK: no \`<op> ANY|SOME|ALL(\${bound})\` in any drizzle \`sql\` template ` +
        `(case-insensitive; aliased tags resolved). Roots: ${rootLine}. ` +
        `${summary.interpolations} \`sql\` template interpolation(s) scanned.`,
    );
    console.log(
      'NOTE: this proves a SPELLING, not an execution. That a statement actually runs and ' +
        "writes its row is an integration test's job.",
    );
  }
}

if (import.meta.main) main();
