// tests/unit/scripts/check-any-bound-array.test.ts
//
// THE GUARD'S OWN HONESTY. `check-any-bound-array.ts` exists because a SQL
// statement that looks right can throw on every invocation without anybody
// noticing; this file exists because a GUARD that looks right can match nothing
// in exactly the same way, and the second failure is worse — it converts
// "unpoliced" into "policed, and clean".
//
// Four separate jobs, not interchangeable:
//
//   1. NON-VACUITY — the rule must be proven to FIRE on a byte-faithful
//      reduction of the statement that actually shipped broken
//      (`workers/approval-expiry.ts::recordCallbacksDeferred`), and the pattern
//      SOURCES are asserted free of control characters (the literal 0x08 trap:
//      a Python `\b` pasted into a JS regex matches nothing and looks identical
//      in review).
//   2. THE REAL NEGATIVES. This repo deliberately CONTAINS the forbidden
//      spelling as prose — `workers/deblock-callback-redelivery.ts:1426`/`:1435`
//      and `lib/void-approvals.ts:164`. Reductions of all three are here as
//      fixtures. A guard that reds on those earns an allowlist within a week and
//      means nothing by month two.
//   3. THE FIX must be exempt, in the exact shape it was written.
//   4. THE FAIL-CLOSED CONTRACT — exit 2 on an empty scope, exit 2 when the
//      template scanner itself finds nothing, and exit 2 when ANY ONE
//      configured root is missing or empty, must be reachable and asserted.
//      An untestable fail-open branch is how a guard dies green for months.
//   5. ⭐ THE BLINDNESS FIXTURES (§2b). Every spelling an adversarial audit
//      found the guard SILENTLY MISSING is pinned here as its own case. The
//      first cut matched `ANY` literally, so `= any(${ids})` scored
//      `{"offences":[],"exit":0}` — a clean certificate over a statement that
//      throws on every call. A guard against a silent-blindness defect that is
//      itself silently blind is worse than no guard, because it certifies. The
//      audit found that by TRYING it; from here the test tries it on every run.
//
// Every fixture below is SYNTHETIC and in-memory — no test here reads a real
// file, so none of them can go green because somebody edited the tree.

import { describe, expect, test } from 'bun:test';

import {
  ANY_OPENER_RE,
  DEFAULT_TAG_NAMES,
  EXEMPT_EXPR_RE,
  EXIT_BROKEN_SCOPE,
  EXIT_OFFENCES,
  SCAN_ROOTS,
  collectSqlInterpolations,
  decideExit,
  findAnyBoundArray,
  isExemptExpr,
  isSqlTagged,
  offenceMessage,
  parseRoots,
  resolveSqlTagNames,
  stripComments,
} from '../../../scripts/check-any-bound-array';

/** One synthetic file. Lines are joined so a fixture's line numbers are obvious. */
const file = (lines: string[], path = 'backend/src/workers/x.ts') => [
  { path, text: lines.join('\n') },
];

const offencesIn = (lines: string[], path?: string) =>
  findAnyBoundArray(file(lines, path)).offences;

// ---------------------------------------------------------------------------
// 1. NON-VACUITY — the guard can actually fire.
// ---------------------------------------------------------------------------

describe('the guard can actually fire (anti-0x08)', () => {
  test('⭐ it fires on the statement that shipped broken, verbatim in shape', () => {
    // Reduction of workers/approval-expiry.ts::recordCallbacksDeferred as it was
    // BEFORE the repair. This is the positive control for the whole guard: if
    // this ever stops firing, nothing else in this file means anything.
    const found = offencesIn([
      'async function recordCallbacksDeferred(db, approvalIds) {',
      '  await db.execute(sql`',
      '    UPDATE approvals',
      '       SET updated_at = now()',
      '     WHERE id = ANY(${approvalIds}::uuid[])',
      '  `);',
      '}',
    ]);
    expect(found).toHaveLength(1);
    // file:LINE must be TRUE — a wrong line sends the operator hunting through a
    // 1100-line worker.
    expect(found[0]!.line).toBe(5);
    expect(found[0]!.file).toBe('backend/src/workers/x.ts');
    expect(found[0]!.expr).toBe('approvalIds');
    expect(found[0]!.operator).toBe('=');
  });

  test('the failure message names the file:line AND the correct spelling', () => {
    // A guard that reds without saying what to write instead gets its rule
    // deleted rather than obeyed.
    const msg = offenceMessage(
      offencesIn(['await db.execute(sql`SELECT 1 WHERE id = ANY(${ids}::uuid[])`);']),
    );
    expect(msg).toContain('backend/src/workers/x.ts:1');
    expect(msg).toContain('row constructor');
    expect(msg).toContain('sql.join');
  });

  test('the pattern sources contain no control character (the literal 0x08 trap)', () => {
    const bad = [
      `any-opener::${ANY_OPENER_RE.source}`,
      `exempt-expr::${EXEMPT_EXPR_RE.source}`,
    ].filter((s) => /[\x00-\x1f]/.test(s));
    expect(bad).toEqual([]);
  });

  test('⭐ the opener regex still carries the `i` flag', () => {
    // The single character whose loss re-opens the exact defect §2b exists for.
    // Asserted on the regex itself as well as through fixtures, because a
    // fixture can be deleted in the same diff that drops the flag.
    expect(ANY_OPENER_RE.flags).toContain('i');
  });
});

// ---------------------------------------------------------------------------
// 2. POSITIVES — every shape that binds an array into ANY(...).
// ---------------------------------------------------------------------------

describe('what IS an offence', () => {
  test('a formatter that wraps the interpolation onto its own line does not hide it', () => {
    const found = offencesIn([
      'const q = sql`',
      '  DELETE FROM approvals',
      '   WHERE id = ANY(',
      '     ${approvalIds}::uuid[]',
      '   )`;',
    ]);
    expect(found).toHaveLength(1);
    // Reported at the OPERATOR, not at the `${` — the operator is what names it.
    expect(found[0]!.line).toBe(3);
  });

  test('the non-`=` comparison operators take ANY(...) too and are equally broken', () => {
    for (const op of ['<>', '!=', '<', '<=', '>', '>=']) {
      const found = offencesIn([`const q = sql\`SELECT 1 WHERE n ${op} ANY(\${xs}::int[])\`;`]);
      expect(found).toHaveLength(1);
      expect(found[0]!.operator).toBe(op);
    }
  });

  test('⚠️ EVERY occurrence counts, not every file', () => {
    // The tempting dedup — one offence per file — would let a file that already
    // has one broken statement carry a second for free.
    const found = offencesIn([
      'const a = sql`UPDATE t SET x = 1 WHERE id = ANY(${ids}::uuid[])`;',
      'const b = sql`UPDATE u SET y = 2 WHERE id = ANY(${others}::uuid[])`;',
    ]);
    expect(found).toHaveLength(2);
    expect(found.map((o) => o.line)).toEqual([1, 2]);
  });

  test('a nested `sql` fragment builder is scanned too', () => {
    // A broken spelling assembled one layer in is still the broken spelling.
    const found = offencesIn([
      'const frag = sql`${cond} AND ${sql`id = ANY(${ids}::uuid[])`}`;',
    ]);
    expect(found).toHaveLength(1);
  });

  test('⚠️ a bound SCALAR is flagged too, and that is the safe polarity', () => {
    // `= ANY(${oneString})` renders `ANY($1)`. It is not the row-constructor
    // failure, but `= ANY(<bound>)` is never the idiom this repo wants, and a
    // guard that had to prove the operand is an array could not exist.
    expect(offencesIn(['const q = sql`SELECT 1 WHERE id = ANY(${maybeArray})`;'])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2b. ⭐ THE BLINDNESS FIXTURES — every spelling the guard once silently missed.
//
// Each case below was demonstrated MISSING by an adversarial audit of the first
// cut, which returned `{"offences":[],"interpolations":1,"exit":0}` on code that
// throws `cannot cast type record to uuid[]` on every invocation. They are
// separate tests, not a loop, so a failure names the spelling that regressed.
// ---------------------------------------------------------------------------

describe('⭐ blindness fixtures — the spellings an audit found the guard missing', () => {
  test('⛔ LOWERCASE `any(` — the audit’s exact line, once a CLEAN exit 0', () => {
    // sql`SELECT 1 WHERE id = any(${ids}::uuid[])` scored {"offences":[],"exit":0}.
    // Postgres does not care about the case; the guard did.
    const found = offencesIn(['const q = sql`SELECT 1 WHERE id = any(${ids}::uuid[])`;']);
    expect(found).toHaveLength(1);
    expect(found[0]!.quantifier).toBe('any');
    expect(found[0]!.operator).toBe('=');
  });

  test('⛔ MIXED CASE — `Any(`, `aNy(`, `AnY (` are all the same statement', () => {
    for (const spelling of ['Any(', 'aNy(', 'AnY (', 'ANy\t(']) {
      const found = offencesIn([`const q = sql\`SELECT 1 WHERE id = ${spelling}\${ids})\`;`]);
      expect({ spelling, n: found.length }).toEqual({ spelling, n: 1 });
    }
  });

  test('⛔ `SOME(` — a Postgres SYNONYM for ANY, in both cases', () => {
    // `= SOME(array)` is defined as `= ANY(array)`. Identical row constructor.
    expect(offencesIn(['const q = sql`SELECT 1 WHERE id = SOME(${ids})`;'])).toHaveLength(1);
    expect(offencesIn(['const q = sql`SELECT 1 WHERE id = some(${ids})`;'])).toHaveLength(1);
  });

  test('⛔ `ALL(` — the same binding, the opposite quantifier, in both cases', () => {
    const found = offencesIn(['const q = sql`SELECT 1 WHERE n <> ALL(${ids}::int[])`;']);
    expect(found).toHaveLength(1);
    expect(found[0]!.quantifier).toBe('ALL');
    expect(offencesIn(['const q = sql`SELECT 1 WHERE n <> all(${ids})`;'])).toHaveLength(1);
  });

  test('⛔ WORD OPERATORS — `LIKE ANY`, `ILIKE any`, `NOT LIKE ANY` bind identically', () => {
    for (const op of ['LIKE', 'ILIKE', 'NOT LIKE', 'NOT ILIKE', 'not ilike']) {
      const found = offencesIn([`const q = sql\`SELECT 1 WHERE name ${op} ANY(\${pats})\`;`]);
      expect({ op, n: found.length }).toEqual({ op, n: 1 });
      expect(found[0]!.operator).toBe(op);
    }
  });

  test('⛔ REGEX-MATCH OPERATORS — `~ ANY`, `!~* ANY`, `~~ ANY`', () => {
    for (const op of ['~', '~*', '!~', '!~*', '~~', '!~~*']) {
      const found = offencesIn([`const q = sql\`SELECT 1 WHERE name ${op} ANY(\${pats})\`;`]);
      expect({ op, n: found.length }).toEqual({ op, n: 1 });
      // Longest-first alternation: `!~~*` must never be reported as `!~`.
      expect(found[0]!.operator).toBe(op);
    }
  });

  test('⛔ A GAP between the operator and the quantifier — newline, JS comment, SQL comment', () => {
    // Whitespace and `/* … */` (layer 1 blanks it) were already fine; a SQL
    // `--` line comment in the gap was not.
    expect(offencesIn(['const q = sql`WHERE id =', '  ANY(${ids})`;'])).toHaveLength(1);
    expect(offencesIn(['const q = sql`WHERE id = /* why */ ANY(${ids})`;'])).toHaveLength(1);
    const withSqlComment = offencesIn([
      'const q = sql`WHERE id = -- the ids come from the tick',
      '  ANY(${ids})`;',
    ]);
    expect(withSqlComment).toHaveLength(1);
    // Reported at the OPERATOR line, which is where a reader must look.
    expect(withSqlComment[0]!.line).toBe(1);
    // …and a gap after the `(` too.
    expect(offencesIn(['const q = sql`WHERE id = ANY( -- ids', '  ${ids})`;'])).toHaveLength(1);
  });

  test('⛔ AN ALIASED DRIZZLE TAG — `import { sql as drizzleSql }`, 7 live uses on main', () => {
    // routes/projects.ts + routes/execution-approvals.ts both import the tag
    // under this alias. To a matcher keyed on the identifier `sql`, every one of
    // their templates did not exist.
    const found = offencesIn([
      "import { and, eq, sql as drizzleSql } from 'drizzle-orm';",
      'const q = drizzleSql`UPDATE approvals SET x = 1 WHERE id = ANY(${ids}::uuid[])`;',
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
    // …and the exemption follows the alias, or the fix would red.
    expect(
      offencesIn([
        "import { sql as drizzleSql } from 'drizzle-orm';",
        'const q = drizzleSql`WHERE id IN (${drizzleSql.join(parts, drizzleSql`, `)})`;',
      ]),
    ).toHaveLength(0);
  });

  test('⚠️ an alias is resolved PER FILE and must not leak to a file that never imported it', () => {
    // Without the file's own drizzle-orm import, `drizzleSql` is just some
    // identifier — flagging it would make one file's naming govern every other.
    expect(
      offencesIn(['const q = drizzleSql`UPDATE t SET x = 1 WHERE id = ANY(${ids})`;']),
    ).toHaveLength(0);
    expect(resolveSqlTagNames('const x = 1;')).toEqual(new Set(['sql']));
    expect(
      resolveSqlTagNames("import {\n  eq,\n  sql as dz,\n} from 'drizzle-orm/pg-core';"),
    ).toEqual(new Set(['sql', 'dz']));
    // An alias of something that is NOT drizzle-orm is not a drizzle tag.
    expect(resolveSqlTagNames("import { queryClient as sqlish } from '../db/client';")).toEqual(
      new Set(['sql']),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. THE REAL NEGATIVES — the false positives that genuinely exist on main.
// ---------------------------------------------------------------------------

describe('what it must NOT flag', () => {
  test('⭐ THE FIX ITSELF — `IN (...)` via sql.join, in the exact shape it was written', () => {
    expect(
      offencesIn([
        'await db.execute(sql`',
        '  UPDATE approvals',
        '     SET updated_at = now()',
        '   WHERE id IN (${sql.join(',
        '     approvalIds.map((id) => sql`${id}::uuid`),',
        '     sql`, `,',
        '   )})',
        '`);',
      ]),
    ).toHaveLength(0);
  });

  test('⚠️ `= ANY(${sql.join(...)})` and `= ANY(${sql.raw(...)})` are exempt', () => {
    // Neither builder binds a parameter, so neither can produce a row
    // constructor. Exempting them by EXPRESSION, not by file, is what keeps this
    // guard from ever needing a path allowlist.
    expect(offencesIn(['const q = sql`WHERE id = ANY(${sql.raw("ARRAY[1,2]")})`;'])).toHaveLength(0);
    expect(offencesIn(['const q = sql`WHERE id = ANY(${sql.join(parts, sql`, `)})`;'])).toHaveLength(
      0,
    );
  });

  test('⚠️ the deblock-callback-redelivery DOCBLOCK naming the refuted spelling (real, :1426/:1435)', () => {
    // A block comment that quotes the forbidden pattern — twice — in prose. If
    // this reds, the guard is unusable on this repo from its first run.
    expect(
      offencesIn([
        '/**',
        ' * ⛔ `IN (…)` VIA `sql.join`, NOT `= ANY(${array}::text[])`, AND THAT IS NOT A',
        ' * STYLE CHOICE. drizzle expands a bound JS array into a ROW CONSTRUCTOR.',
        ' *',
        ' * ⚠️ DRIVE-BY: `workers/approval-expiry.ts:418` uses the refuted spelling',
        ' * (`id = ANY(${approvalIds}::uuid[])`) and renders the same row constructor.',
        ' */',
        'const notARejectedHold = sql`NOT (a.status = ${status})`;',
      ]),
    ).toHaveLength(0);
  });

  test('⚠️ the void-approvals LINE COMMENT naming the pattern (real, :164)', () => {
    expect(
      offencesIn([
        '    // Real run. One UPDATE per row rather than a single `= ANY(${ids})` batch:',
        '    // per-row keeps the parameter binding identical to every other site.',
        '    const q = sql`UPDATE approvals SET status = ${next} WHERE id = ${id}::uuid`;',
      ]),
    ).toHaveLength(0);
  });

  test('⚠️ an ordinary STRING or log line mentioning the spelling is not code', () => {
    // Layer 2: only a `sql`-tagged template is scanned at all.
    expect(
      offencesIn([
        'const HINT = "never write `= ANY(${ids}::uuid[])` in a drizzle template";',
        "console.error('refused: = ANY(${x}) is a row constructor');",
      ]),
    ).toHaveLength(0);
  });

  test('⛔ a postgres.js `queryClient` template is CORRECT and must never be flagged', () => {
    // postgres.js binds a JS array as a real Postgres array. Flagging this would
    // be a false positive on working code, and is why the tag must be exactly
    // `sql` (drizzle) rather than "any template containing SQL".
    expect(
      offencesIn(['const rows = await queryClient`SELECT * FROM t WHERE id = ANY(${ids})`;']),
    ).toHaveLength(0);
  });

  test('⚠️ `UNION ALL (${…})` is ordinary SQL — this is why ALL still needs an operator', () => {
    // Widening the quantifier set to `ALL` is only safe because the opener still
    // demands a comparison operator in front of it. `UNION ALL (` has none.
    expect(offencesIn(['const q = sql`SELECT 1 UNION ALL (${otherLeg})`;'])).toHaveLength(0);
    expect(offencesIn(['const q = sql`SELECT ALL (${col}) FROM t`;'])).toHaveLength(0);
  });

  test('⚠️ `Array.prototype.join` is NOT the drizzle builder and stays flagged', () => {
    // The exemption matches on the RECEIVER, not on the method name. Exempting
    // any `x.join(` would let `= ANY(${ids.join(",")})` — a bound STRING —
    // through, which is the same class of miss dressed as a fix.
    const found = offencesIn(['const q = sql`WHERE id = ANY(${ids.join(",")})`;']);
    expect(found).toHaveLength(1);
    expect(isExemptExpr('ids.join(",")', DEFAULT_TAG_NAMES)).toBe(false);
    expect(isExemptExpr('sql.join(parts)', DEFAULT_TAG_NAMES)).toBe(true);
    expect(isExemptExpr('sql.raw("x")', DEFAULT_TAG_NAMES)).toBe(true);
    expect(isExemptExpr('dz.join(parts)', new Set(['sql', 'dz']))).toBe(true);
  });

  test('⛔ a postgres.js client named `sql` in a SCRIPT is scanned — the accepted over-flag', () => {
    // `scripts/{ci-seed,require-db-reachable,encrypt-channel-credentials}.ts` and
    // `db/migration-runner.ts` all do `const sql = postgres(url)`, where a bound
    // array IS a real Postgres array and `= ANY(${ids})` is CORRECT. None of them
    // uses `ANY(` today (measured), so the tree is green — but the polarity is
    // recorded here on purpose: if one ever does, the finding is a FALSE POSITIVE
    // and the fix is to rename the local client, never to allowlist the file.
    // Over-flagging is visible on the next CI run; under-flagging shipped for months.
    expect(
      offencesIn([
        "const sql = postgres(url, { max: 1 });",
        'const rows = await sql`SELECT 1 WHERE id = ANY(${ids})`;',
      ]),
    ).toHaveLength(1);
  });

  test('a SQL array literal / ARRAY[] constructor has no interpolation at all', () => {
    expect(
      offencesIn([
        "const a = sql`SELECT 1 WHERE id = ANY('{a,b}')`;",
        'const b = sql`SELECT 1 WHERE n = ANY(ARRAY[1,2])`;',
        'const c = sql`SELECT 1 WHERE id = ANY(SELECT id FROM other)`;',
      ]),
    ).toHaveLength(0);
  });

  test('⚠️ a mention of the pattern INSIDE the SQL, away from the boundary, is not a match', () => {
    // Layer 3: the opener must be the LAST thing before the interpolation.
    expect(
      offencesIn([
        'const q = sql`',
        '  -- never spell this as id = ANY(x)',
        '  UPDATE approvals SET status = ${next} WHERE id = ${id}::uuid',
        '`;',
      ]),
    ).toHaveLength(0);
  });

  test('an unrelated `ANY` word, and an unrelated interpolation, stay quiet', () => {
    expect(
      offencesIn([
        'const q = sql`SELECT ${col} FROM t WHERE company = ${name} AND note LIKE ${like}`;',
      ]),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3b. The scanner primitives, asserted directly.
// ---------------------------------------------------------------------------

describe('the template scanner', () => {
  test('recognises the bare `sql` tag and refuses everything else', () => {
    const tagged = 'sql`x`';
    expect(isSqlTagged(tagged, tagged.indexOf('`'))).toBe(true);
    const spaced = 'sql `x`';
    expect(isSqlTagged(spaced, spaced.indexOf('`'))).toBe(true);
    // `sql.raw(`…`)` walks back to `(` — not an identifier, so not tagged.
    const raw = 'sql.raw(`x`)';
    expect(isSqlTagged(raw, raw.indexOf('`'))).toBe(false);
    const other = 'queryClient`x`';
    expect(isSqlTagged(other, other.indexOf('`'))).toBe(false);
    const untagged = 'const s = `x`';
    expect(isSqlTagged(untagged, untagged.indexOf('`'))).toBe(false);
  });

  test('a `}` inside a string cannot close an interpolation early', () => {
    const found = collectSqlInterpolations("const q = sql`a ${f('}')} b ${g} c`;");
    expect(found).toHaveLength(2);
    expect(found[1]!.literalBefore).toBe(' b ');
  });

  test('stripComments preserves offsets so reported lines stay true', () => {
    const src = ['/* one', '   two */', 'const q = sql`WHERE id = ANY(${ids})`;'].join('\n');
    const stripped = stripComments(src);
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).toHaveLength(src.length);
    expect(findAnyBoundArray([{ path: 'p.ts', text: src }]).offences[0]!.line).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. THE FAIL-CLOSED CONTRACT.
// ---------------------------------------------------------------------------

describe('exit-code contract — a finding is never confused with a broken run', () => {
  test('⛔ ZERO FILES SCANNED exits 2, never 0', () => {
    // A scan of nothing is otherwise byte-identical to a scan of a clean tree.
    const summary = findAnyBoundArray([]);
    expect(summary.filesScanned).toBe(0);
    expect(decideExit(summary)).toBe(EXIT_BROKEN_SCOPE);
    expect(EXIT_BROKEN_SCOPE).toBe(2);
  });

  test('⛔ files scanned but ZERO `sql` interpolations found ALSO exits 2', () => {
    // The stronger half: this is what fails the run if the template scanner
    // itself stops matching — the way this guard would go inert without anybody
    // deleting a line of it.
    const summary = findAnyBoundArray([{ path: 'a.ts', text: 'export const x = 1;\n' }]);
    expect(summary.filesScanned).toBe(1);
    expect(summary.interpolations).toBe(0);
    expect(decideExit(summary)).toBe(EXIT_BROKEN_SCOPE);
  });

  test('⛔ ONE MISSING ROOT exits 2 even when the other root is large and clean', () => {
    // ⭐ THE TRAP THAT COMES WITH WIDENING A SCOPE. With only a global file
    // count, a second root that resolves to nothing — renamed, deleted, a typo
    // in SCAN_ROOTS — is invisible: `src` alone keeps the total large and the
    // run prints the same green line while half the scope is never read.
    const summary = findAnyBoundArray(file(['const q = sql`WHERE id = ${id}`;']));
    expect(decideExit(summary, [])).toBe(0); // control: no root info, clean
    expect(
      decideExit(summary, [
        { root: 'src', dir: '/x/src', present: true, files: 509 },
        { root: 'scripts', dir: '/x/scripts', present: false, files: 0 },
      ]),
    ).toBe(EXIT_BROKEN_SCOPE);
  });

  test('⛔ A ROOT THAT EXISTS BUT CONTRIBUTES ZERO FILES also exits 2', () => {
    // Present-but-empty is the sneakier half: `statSync` says yes, the glob says
    // nothing, and a total-only check never notices.
    const summary = findAnyBoundArray(file(['const q = sql`WHERE id = ${id}`;']));
    expect(
      decideExit(summary, [
        { root: 'src', dir: '/x/src', present: true, files: 509 },
        { root: 'scripts', dir: '/x/scripts', present: true, files: 0 },
      ]),
    ).toBe(EXIT_BROKEN_SCOPE);
  });

  test('⛔ zero interpolations still exits 2 AFTER the scope widened', () => {
    // Widening a glob is a classic way to make a scanner's empty case look
    // clean: more files, still nothing matched. Both roots healthy, scanner
    // dead -> 2.
    const summary = findAnyBoundArray([
      { path: 'backend/src/a.ts', text: 'export const x = 1;\n' },
      { path: 'backend/scripts/b.ts', text: 'export const y = 2;\n' },
    ]);
    expect(summary.filesScanned).toBe(2);
    expect(summary.interpolations).toBe(0);
    expect(
      decideExit(summary, [
        { root: 'src', dir: '/x/src', present: true, files: 1 },
        { root: 'scripts', dir: '/x/scripts', present: true, files: 1 },
      ]),
    ).toBe(EXIT_BROKEN_SCOPE);
  });

  test('a real offence over a real scope exits 1', () => {
    const summary = findAnyBoundArray(file(['const q = sql`WHERE id = ANY(${ids}::uuid[])`;']));
    expect(summary.interpolations).toBeGreaterThan(0);
    expect(decideExit(summary)).toBe(EXIT_OFFENCES);
    expect(EXIT_OFFENCES).toBe(1);
  });

  test('a clean, NON-EMPTY scope exits 0', () => {
    const summary = findAnyBoundArray(
      file(['const q = sql`WHERE id IN (${sql.join(parts, sql`, `)})`;']),
    );
    expect(summary.filesScanned).toBe(1);
    expect(summary.interpolations).toBeGreaterThan(0);
    expect(summary.offences).toHaveLength(0);
    expect(decideExit(summary)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. THE SCOPE ITSELF — the guard must police the directory it lives in.
// ---------------------------------------------------------------------------

describe('scan scope', () => {
  test('⭐ `scripts` is in scope — the guard did not check its own directory', () => {
    // The gap this closes: no repair/backfill script was policed, including the
    // guard itself. A one-shot script that throws on every invocation inside a
    // `catch` that only logs is EXACTLY the shipped defect, minus the tests.
    expect(SCAN_ROOTS).toContain('scripts');
    expect(SCAN_ROOTS).toContain('src');
  });

  test('`tests` is NOT in scope — postgres.js territory, where `= ANY(${ids})` is correct', () => {
    // Scanning it would red working code and earn the guard an allowlist.
    expect(SCAN_ROOTS).not.toContain('tests');
  });

  test('the roots resolve against backend/, and both CLI overrides still work', () => {
    const dflt = parseRoots(['bun', 'check-any-bound-array.ts']);
    expect(dflt).toHaveLength(SCAN_ROOTS.length);
    expect(dflt.some((r) => r.endsWith('/src'))).toBe(true);
    expect(dflt.some((r) => r.endsWith('/scripts'))).toBe(true);
    // `--root=` is repeatable and replaces the defaults.
    expect(parseRoots(['--root=src', '--root=scripts'])).toHaveLength(2);
    // `--src-root=` stays a single ABSOLUTE root, for back-compat with the
    // documented usage line.
    expect(parseRoots(['--src-root=/tmp/elsewhere'])).toEqual(['/tmp/elsewhere']);
  });
});
