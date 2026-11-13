#!/usr/bin/env bun
// backend/scripts/check-credential-absence-armed.ts
//
// Guard: a test that asserts a credential is ABSENT from an outgoing request
// must run in a request frame that HAD a credential to leak. Otherwise it is a
// green light on nothing — the assertion holds because the harness supplied no
// token, not because the code withheld one.
//
// The hole this closes
// --------------------
// Four separate tests were found asserting "no Authorization header" from an
// EMPTY AsyncLocalStorage frame, each fixed by hand before this guard existed.
//
// Hand-fixing an instance does not stop the next one. And the pattern is not
// theoretical: MEASURED 2026-08-31, the S6/S8 scar guards —
// named after the 2026-04-26 outage in which fr's end-user Keycloak JWT reached
// coding-gateway and was introspected as a licence — could not detect that leak:
//
//     coding/client.ts `sendAuthorization: false`  ->  36 pass, 0 fail
//     coding/client.ts `sendAuthorization: true`   ->  36 pass, 0 fail   <-- the outage
//
// The guard for the original incident was blind to the original incident.
//
// HOW IT WORKS
// ------------
// For each `test(...)` / `it(...)` block, find assertions that a credential is
// absent. If the block does not also put a `bearerToken` in the request frame,
// the absence is unearned. A block may opt out with an inline
// `// unarmed-absence-ok: <reason>` — a decision with a reason attached, not a
// silent exemption.
//
// FAIL-CLOSED, deliberately (a fail-open regex in an earlier guard reported
// 5 of 23 and exited 0):
//   * zero test files walked            -> exit 1
//   * zero absence assertions detected  -> exit 1 (the pattern rotted)
//   * fewer than MIN_DETECTED detected  -> exit 1 (the pattern rotted PARTIALLY,
//                                         which a bare zero-check cannot see)
//
// ---------------------------------------------------------------------------
// THREE MEASURED BLIND SPOTS, CLOSED 2026-09-07
// ---------------------------------------------------------------------------
// The guard above shipped detecting exactly ONE syntactic shape. It reported
// `0 UNARMED` and had never been watched fire. Three escapes were measured on
// this repo, all of them real:
//
//   B  `test.each([...])('name', fn)` was ENTIRELY INVISIBLE. The old
//      TEST_HEADER required a quote IMMEDIATELY after `test(`, so a `.each`
//      file yielded ZERO test blocks and was skipped in silence — not reported
//      as unscannable, just absent from the denominator. 34 files in this repo
//      use `.each`. A guard whose denominator quietly excludes a sixth of the
//      suite is a censored measurement, not a clean one.
//
//   C  `ARMED_IN_BODY` was a bare /bearerToken/ over RAW text, so the WORD —
//      in a comment, in a string, in prose — marked a test ARMED. MEASURED
//      2026-09-07 on a REAL block, tests/unit/routes/agui.test.ts:355:
//      inserting the single line `// this hop deliberately supplies no
//      bearerToken at all` flipped that block from armed=false to armed=true
//      under the old detector (18 -> 19 armed, 11 -> 10 waived) and left it at
//      armed=false under this one. The guard could be disarmed by describing
//      it — including by a comment that says the opposite of what it does.
//
//   D  `CREDENTIAL_RECEIVER` was tested only against the text inside the
//      literal `expect(...)` argument, so routing the value through a local
//      first —
//          const sent = captured.headers.authorization;
//          expect(sent).toBeUndefined();
//      — made the assertion invisible. Not the absence UNARMED: the absence
//      ASSERTION itself unseen, so the block never entered the denominator.
//
// The shared root cause is that each check ran against the wrong text. The fix
// is a single small lexer (`lexSource`) producing two offset-preserving views:
//
//   noComments — comments blanked, string LITERALS KEPT.
//                Used for header/block splitting and for finding absence
//                assertions. Strings must survive here: the receiver name in
//                `res.headers.get('authorization')` lives INSIDE a string, and
//                blanking it would delete true findings. (Measured while
//                writing this: blanking strings for the assertion pass drops
//                real detections.)
//
//   code       — comments AND string contents blanked.
//                Used for the ARMING check only. A credential mentioned in
//                prose supplies no credential.
//
// Both views are offset-preserving (every blanked character becomes a space,
// newlines survive): a strip that shifts offsets
// reports the wrong line, and a wrong line sends the operator hunting.
//
// ⚠️ `lexSource` IS A HEURISTIC LEXER, NOT A PARSER — READ THIS BEFORE TRUSTING
// A GREEN. It is ~120 lines of hand-rolled character scanning, and it decides
// the one genuinely ambiguous question in JS tokenisation — is `/` the start of
// a REGEX LITERAL or a DIVISION operator? — from a SINGLE preceding non-space
// character (see the regex-literal branch, `'([{,;:=!&|?+-*%~^<>'.includes(prev)`).
// A real lexer answers that from full expression state. So a pathological case
// such as `return /don't/` can mis-lex: `return` ends in a letter, not one of
// those punctuators, so the `/` is not taken as a regex opener and the
// apostrophe opens a phantom string.
//
// The blast radius is deliberately bounded rather than eliminated: `'` and `"`
// strings terminate at an unescaped NEWLINE as well as at their quote, so a
// mis-lex corrupts one LINE of the views, not the remainder of the file. A
// corrupted line can drop an absence assertion out of the denominator (a false
// GREEN) or blank an arming credential (a false RED). Neither shape occurs in
// the tree today, and no such case has been observed — but this guard's green
// is only as good as the lexer, and that is a heuristic. If a finding here ever
// looks impossible, suspect the lexer before the code under test. The fix, if
// it is ever needed, is a real tokeniser, not another punctuator in that list.
// This admission is repeated on `lexSource` itself; it is stated here because
// this block is where a reader forms an impression of what the guard proves.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Receivers that name a credential. Kept as an explicit, readable list rather
 * than one clever regex: recall matters more than elegance here, and the first
 * draft of this detector matched only `authorization` and therefore MISSED
 * a test that captured the header into `.auth`.
 * A detector that misses one of the four cases that motivated it is not a guard.
 */
const CREDENTIAL_RECEIVER = /(?:authorization|authHeader|\.auth\b|bearer)/i;

/** Absence, in every shape this repo actually writes it. */
const ABSENCE_ASSERTION =
  /expect\(([^;]*?)\)\s*\.\s*(?:toBeNull\(\)|toBeUndefined\(\)|toBe\(\s*(?:null|undefined)\s*\)|toEqual\(\s*undefined\s*\))/g;

/**
 * A credential the code under test could have forwarded, present in the frame.
 *
 * Two accepted shapes, because both are real in this repo:
 *   - the test body supplies `bearerToken` inline;
 *   - the test enters `withRequestContext(...)` with a frame constant shared at
 *     module level (e.g. `CALLER_FRAME`), and the FILE supplies `bearerToken`.
 * The second is why this is not a body-only match: the first draft of this
 * detector reported the six guards armed in this very commit as still unarmed,
 * which would have taught the next reader that arming does not count.
 *
 * ⚠️ Both are now tested against the `code` view (gap C). Reverting either to
 * raw text re-opens "a test is armed by talking about arming".
 */
const ARMED_IN_BODY = /bearerToken/;
const ENTERS_FRAME = /withRequestContext\s*\(/;

/**
 * Opt out, with a reason. An empty reason is not a waiver.
 *
 * The character class after the colon is `[ \t]`, NOT `\s` — deliberately.
 * `\s` matches a newline, so `\s*(\S.*)` walked past a bare
 * `// unarmed-absence-ok:` and adopted the FIRST NON-SPACE OF THE NEXT LINE as
 * the reason. Measured 2026-08-31: a marker with its reason deleted still
 * waived, because the following `const req = …` served as the justification.
 * An exemption mechanism that accepts a line of code as a rationale is
 * fail-open, which is the defect class this guard exists to catch.
 *
 * ⚠️ Matched against the RAW body, never a stripped view — the waiver LIVES in
 * a comment. This is the one check that must see comments.
 */
const WAIVER = /\/\/[ \t]*unarmed-absence-ok:[ \t]*(\S[^\n]*)/;

/**
 * Start of a candidate test header. The NAME is not matched here — see
 * `readHeaderName`, which walks the `.each` argument (array literal or tagged
 * template) before the name string. A regex cannot do that: the table argument
 * nests brackets and contains strings, and `[\s\S]*?` across it silently ate
 * whole files.
 *
 * `describe` is admitted ONLY with a `.each` modifier. Plain `describe(` was
 * never a scanned block and admitting it now would move block boundaries for
 * the whole suite — a denominator change with no defect behind it.
 */
const HEADER_KEYWORDS = ['test', 'it', 'describe'];
const HEADER_MODS = '((?:[ \\t]*\\.[ \\t]*[A-Za-z]+)*)';

/**
 * fr#1507. Test WRAPPERS open blocks too. `itDb(` (tests/integration/helpers/
 * db-suite.ts) heads ~2300 blocks; before this they were invisible, so every
 * `itDb` was attributed to the last preceding `it(` — an absence assertion was
 * judged against the wrong block's arming, and one waiver silently covered
 * every `itDb` up to the next `it(`.
 *
 * A wrapper is recognised from what the FILE ITSELF declares, never from a
 * hand-kept list that rots:
 *   const { itDb } = createDbSuite(…)            -- `itDb` is always admitted
 *   const { itDb: itDbBase } = createDbSuite(…)  -- the alias
 *   const itDb = test.skipIf(!reachable);        -- a curried skip
 *   const ifReachable = (name: string, fn: () => …) => test(name, …)
 *   function ifReachable(name: string, fn: () => …): void { … }
 * The function shapes require the SECOND parameter to be typed as a function,
 * so `(name: string, body: string) => writeFile(…)` is not a wrapper.
 * Read from the `code` view: a wrapper declared inside a string (this guard's
 * own fixtures) or a comment declares nothing.
 */
const WRAPPER_DECLS: RegExp[] = [
  /\{[^}]*\bitDb[ \t]*:[ \t]*([A-Za-z_$][\w$]*)[^}]*\}[ \t]*=[ \t]*createDbSuite\b/g,
  /\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:test|it)[ \t]*\.[ \t]*(?:skipIf|runIf|if)[ \t]*\(/g,
  /\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]+)?\([ \t]*\w+[ \t]*:[ \t]*string[ \t]*,[ \t]*\w+[ \t]*:[ \t]*\([^)]*\)[ \t]*=>/g,
  /\bfunction[ \t]+([A-Za-z_$][\w$]*)[ \t]*\([ \t]*\w+[ \t]*:[ \t]*string[ \t]*,[ \t]*\w+[ \t]*:[ \t]*\([^)]*\)[ \t]*=>/g,
];

export function testWrappers(code: string): Set<string> {
  const out = new Set<string>(['itDb']);
  for (const re of WRAPPER_DECLS) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) out.add(m[1]!);
  }
  for (const k of HEADER_KEYWORDS) out.delete(k);
  return out;
}

function headerStart(wrappers: Set<string>): RegExp {
  const names = [...HEADER_KEYWORDS, ...[...wrappers].map((w) => w.replace(/\$/g, '\\$'))];
  return new RegExp(`^[ \\t]*(${names.join('|')})(?![\\w$])${HEADER_MODS}`, 'gm');
}

/** `const sent = captured.headers.authorization` — gap D, same block only. */
const LOCAL_BINDING = /\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=([^;\n]*)/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Floor for pattern rot. A detector that silently stops matching reads exactly
 * like a clean repo. Raise this when the true count rises; lowering it is a
 * decision that belongs in the same commit as the deletions that justify it.
 * 12 → 6 on 2026-10-29: the other six lived in fetch-stub tests deleted under
 * the no-test-doubles ruling. 6 → 4 the same day: agui.test.ts (stand-in
 * registered action) and dispatcher-pipeline.test.ts (stand-in identity
 * resolver) cases removed under the same ruling.
 */
export const MIN_DETECTED = 4;

export interface Finding {
  file: string;
  line: number;
  test: string;
  armed: boolean;
  waiver?: string;
}

/**
 * One pass, two offset-preserving views. See the header block for why there
 * must be two and what each is allowed to be used for.
 *
 * `'` / `"` strings are terminated by an unescaped newline as well as by their
 * quote: JS forbids a raw newline inside them, so this bounds the damage of a
 * mis-lex (an apostrophe inside a regex literal, say) to a single line instead
 * of blanking the rest of the file.
 */
export function lexSource(src: string): { noComments: string; code: string } {
  const nc: string[] = [];
  const cd: string[] = [];
  const keep = (ch: string) => {
    nc.push(ch);
    cd.push(ch);
  };
  const blankBoth = (ch: string) => {
    const c = ch === '\n' ? '\n' : ' ';
    nc.push(c);
    cd.push(c);
  };
  const blankCodeOnly = (ch: string) => {
    nc.push(ch);
    cd.push(ch === '\n' ? '\n' : ' ');
  };

  const n = src.length;
  // Brace depth per open template substitution, so `${ {a:1} }` closes right.
  const tmplBraces: number[] = [];
  let depth = 0;
  let prev = ''; // last significant CODE character, for regex-literal detection
  let i = 0;

  while (i < n) {
    const ch = src[i]!;

    // -- comments ----------------------------------------------------------
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') blankBoth(src[i++]!);
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      blankBoth(src[i++]!);
      blankBoth(src[i++]!);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blankBoth(src[i++]!);
      if (i < n) {
        blankBoth(src[i++]!);
        blankBoth(src[i++]!);
      }
      continue;
    }

    // -- regex literal -------------------------------------------------------
    // Only where a regex can legally start. Without this, `/don't/` opens a
    // phantom string. Consumed verbatim in BOTH views: a regex is code.
    if (ch === '/' && (prev === '' || '([{,;:=!&|?+-*%~^<>'.includes(prev))) {
      keep(src[i++]!);
      let cls = false;
      while (i < n && src[i] !== '\n') {
        const c = src[i]!;
        if (c === '\\') {
          keep(src[i++]!);
          if (i < n) keep(src[i++]!);
          continue;
        }
        if (c === '[') cls = true;
        else if (c === ']') cls = false;
        else if (c === '/' && !cls) {
          keep(src[i++]!);
          break;
        }
        keep(src[i++]!);
      }
      prev = '/';
      continue;
    }

    // -- quoted strings ------------------------------------------------------
    if (ch === "'" || ch === '"') {
      blankCodeOnly(src[i++]!);
      while (i < n && src[i] !== ch && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < n) blankCodeOnly(src[i++]!);
        blankCodeOnly(src[i++]!);
      }
      if (i < n && src[i] === ch) blankCodeOnly(src[i++]!);
      prev = 'x';
      continue;
    }

    // -- template literals ---------------------------------------------------
    if (ch === '`') {
      blankCodeOnly(src[i++]!);
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          blankCodeOnly(src[i++]!);
          blankCodeOnly(src[i++]!);
          continue;
        }
        if (src[i] === '`') {
          blankCodeOnly(src[i++]!);
          break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          // Substitutions are CODE — `${bearerToken}` really does supply one.
          keep(src[i++]!);
          keep(src[i++]!);
          tmplBraces.push(depth);
          prev = '{';
          break;
        }
        blankCodeOnly(src[i++]!);
      }
      if (tmplBraces.length === 0) prev = 'x';
      continue;
    }

    // -- plain code ----------------------------------------------------------
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (tmplBraces.length > 0 && depth === tmplBraces[tmplBraces.length - 1]) {
        // closing a `${ … }` — resume the template literal
        tmplBraces.pop();
        keep(src[i++]!);
        while (i < n) {
          if (src[i] === '\\' && i + 1 < n) {
            blankCodeOnly(src[i++]!);
            blankCodeOnly(src[i++]!);
            continue;
          }
          if (src[i] === '`') {
            blankCodeOnly(src[i++]!);
            break;
          }
          if (src[i] === '$' && src[i + 1] === '{') {
            keep(src[i++]!);
            keep(src[i++]!);
            tmplBraces.push(depth);
            break;
          }
          blankCodeOnly(src[i++]!);
        }
        prev = 'x';
        continue;
      }
      depth--;
    }
    if (!/\s/.test(ch)) prev = ch;
    keep(src[i++]!);
  }

  return { noComments: nc.join(''), code: cd.join('') };
}

/** Skip whitespace. */
function ws(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/**
 * Index just past the group opened at `s[i]` (`(`, `[` or `{`), respecting
 * nesting and string literals. -1 if unbalanced. Input is comment-free.
 */
function skipGroup(s: string, i: number): number {
  const open = '([{';
  const close = ')]}';
  const stack: string[] = [];
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"') {
      i = skipQuoted(s, i);
      continue;
    }
    if (c === '`') {
      i = skipTemplate(s, i);
      continue;
    }
    if (open.includes(c)) stack.push(close[open.indexOf(c)]!);
    else if (close.includes(c)) {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Index of the closing quote of the literal opened at `s[i]`. */
function skipQuoted(s: string, i: number): number {
  const q = s[i]!;
  for (i++; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === q || s[i] === '\n') return i;
  }
  return s.length;
}

/** Index of the closing backtick of the template opened at `s[i]`. */
function skipTemplate(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
    else if (s[i] === '$' && s[i + 1] === '{') {
      const end = skipGroup(s, i + 1);
      if (end < 0) return s.length;
      i = end - 1;
    }
  }
  return s.length;
}

/** Skip a TypeScript generic argument list at `s[i] === '<'`. */
function skipGenerics(s: string, i: number): number {
  if (s[i] !== '<') return i;
  let d = 0;
  for (; i < s.length; i++) {
    if (s[i] === '<') d++;
    else if (s[i] === '>') {
      d--;
      if (d === 0) return i + 1;
    } else if (s[i] === '\n') return -1;
  }
  return -1;
}

/**
 * Read the NAME of a test block whose header keyword+modifiers end at `i`.
 * Handles, in one place, every call shape this repo writes:
 *
 *   test('name', fn)                       -- the only shape the old regex saw
 *   test.each([...])('name %s', fn)        -- gap B, array table
 *   test.each<[string, number]>([...])(…)  -- gap B, with a generic
 *   test.each`a | b ⏎ …`('name %s', fn)    -- gap B, tagged-template table
 *
 * Returns null when no string name is reachable (e.g. `test(nameVar, fn)`),
 * which keeps the old behaviour of not inventing a block.
 */
function readHeaderName(s: string, i: number, isEach: boolean): string | null {
  i = ws(s, i);
  if (s[i] === '<') {
    i = skipGenerics(s, i);
    if (i < 0) return null;
    i = ws(s, i);
  }
  if (isEach) {
    if (s[i] === '`') i = skipTemplate(s, i) + 1;
    else if (s[i] === '(' || s[i] === '[') {
      const end = skipGroup(s, i);
      if (end < 0) return null;
      i = end;
    } else return null;
    i = ws(s, i);
    if (s[i] === '<') {
      i = skipGenerics(s, i);
      if (i < 0) return null;
      i = ws(s, i);
    }
  }
  if (s[i] !== '(') return null;
  i = ws(s, i + 1);
  const q = s[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  const end = q === '`' ? skipTemplate(s, i) : skipQuoted(s, i);
  return s.slice(i + 1, end);
}

/**
 * Split a source file into test blocks: name, 1-based line, body.
 *
 * Headers are located on the COMMENT-STRIPPED view so a commented-out `test(`
 * cannot open a phantom block; the returned body is the RAW slice, because the
 * waiver the caller looks for lives in a comment. Both views share offsets, so
 * the same indices address both.
 */
export function testBlocks(src: string): { name: string; line: number; body: string }[] {
  const { noComments, code } = lexSource(src);
  const HEADER_START = headerStart(testWrappers(code));
  const heads: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = HEADER_START.exec(noComments)) !== null) {
    const kind = m[1]!;
    const mods = (m[2] ?? '').replace(/[ \t]/g, '');
    const isEach = /\.each\b/.test(mods);
    if (kind === 'describe' && !isEach) continue;
    let at = m.index + m[0]!.length;
    // `test.skipIf(cond)('name', fn)` — step over the condition group to the
    // call that carries the name (fr#1507 sibling: these were invisible too).
    if (/\.(?:skipIf|runIf|if)$/.test(mods)) {
      at = ws(noComments, at);
      if (noComments[at] !== '(') continue;
      at = skipGroup(noComments, at);
      if (at < 0) continue;
    }
    const name = readHeaderName(noComments, at, isEach);
    if (name === null) continue;
    heads.push({ name, index: m.index });
  }
  return heads.map((h, i) => ({
    name: h.name.replace(/\s+/g, ' ').trim(),
    line: src.slice(0, h.index).split('\n').length,
    body: src.slice(h.index, i + 1 < heads.length ? heads[i + 1]!.index : src.length),
  }));
}

/**
 * Names bound in this block from an expression that names a credential —
 * gap D. Deliberately SAME-BLOCK and single-line: a conservative binding is
 * enough to see `const sent = captured.headers.authorization`, and anything
 * wider is cross-file dataflow this guard has no business guessing at.
 */
// GAP D's KNOWN FALSE-POSITIVE CLASS — MEASURED 2026-09-08, disclosed rather
// than narrowed.
//
// This collects same-block `const/let/var X = <expr>` where <expr> matches
// CREDENTIAL_RECEIVER, so that `const sent = captured.headers.authorization;
// expect(sent).toBeUndefined();` is seen as the absence assertion it is. But
// CREDENTIAL_RECEIVER is a text test, so ANY right-hand side carrying the word
// is admitted — including one that never touched a request:
//
//     const mode = config.authorizationMode;
//     expect(mode).toBeUndefined();          // <- reported as an UNARMED finding
//
// Verified against this file's own scanFile(): that block returns one finding,
// armed:false. There is no such site in the tree today (0 UNARMED across 593
// files), so this is latent, not live.
//
// It is NOT narrowed on purpose. Requiring the RHS to look like a request or
// header access would re-open the hole gap D exists to close — the whole point
// is that the credential can be routed through a local before the assertion
// sees it, and the shapes that routing takes are not enumerable. The intended
// remedy for a genuine false positive is the waiver this guard already has,
// `// unarmed-absence-ok: <reason>`, which 11 sites use. If you are reading
// this because CI just went red on a config field: the waiver is the answer,
// and the guard is not broken.
function credentialLocals(blockNoComments: string): Set<string> {
  const names = new Set<string>();
  LOCAL_BINDING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCAL_BINDING.exec(blockNoComments)) !== null) {
    if (CREDENTIAL_RECEIVER.test(m[2] ?? '')) names.add(m[1]!);
  }
  return names;
}

/** Every credential-absence assertion in one file, classified. */
export function scanFile(path: string, src: string): Finding[] {
  const out: Finding[] = [];
  const fileArms = ARMED_IN_BODY.test(lexSource(src).code);
  for (const { name, line, body } of testBlocks(src)) {
    const views = lexSource(body);
    const locals = credentialLocals(views.noComments);
    ABSENCE_ASSERTION.lastIndex = 0;
    const asserts = [...views.noComments.matchAll(ABSENCE_ASSERTION)].some((m) => {
      const arg = m[1] ?? '';
      if (CREDENTIAL_RECEIVER.test(arg)) return true;
      return (arg.match(IDENTIFIER) ?? []).some((id) => locals.has(id));
    });
    if (!asserts) continue;
    out.push({
      file: path,
      line,
      test: name,
      armed: ARMED_IN_BODY.test(views.code) || (ENTERS_FRAME.test(views.code) && fileArms),
      waiver: body.match(WAIVER)?.[1]?.trim(),
    });
  }
  return out;
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

function die(msg: string): never {
  console.error(`[check-credential-absence-armed] FAIL: ${msg}`);
  process.exit(1);
}

export async function main(argv: string[]): Promise<void> {
  const reportOnly = argv.includes('--report-only');
  // Seam for this guard's OWN unit test: point it at a fixture tree instead of
  // writing mutant `.test.ts` files into tests/, which sibling guards count.
  const root = argv.find((a) => a.startsWith('--root='))?.slice('--root='.length) ?? 'tests';
  const files = await walk(root).catch(() => [] as string[]);
  if (files.length === 0) die(`walked zero test files under '${root}' — wrong cwd, or the tree moved`);

  const findings: Finding[] = [];
  for (const f of files) findings.push(...scanFile(f, await readFile(f, 'utf8')));

  if (findings.length === 0) {
    die('detected zero credential-absence assertions across ' + files.length +
        ' files. This repo has them; the pattern has rotted.');
  }
  if (findings.length < MIN_DETECTED) {
    die(`detected ${findings.length} credential-absence assertions, below the ` +
        `MIN_DETECTED floor of ${MIN_DETECTED}. Either the pattern rotted, or ` +
        `real cases were deleted — lower the floor in the same commit if so.`);
  }

  const unarmed = findings.filter((f) => !f.armed && !f.waiver);
  const waived = findings.filter((f) => !f.armed && f.waiver);

  console.log(
    `[check-credential-absence-armed] ${files.length} files, ` +
    `${findings.length} credential-absence assertions: ` +
    `${findings.filter((f) => f.armed).length} armed, ${waived.length} waived, ` +
    `${unarmed.length} UNARMED`,
  );
  for (const w of waived) console.log(`  waived  ${w.file}:${w.line}  ${w.test}\n            reason: ${w.waiver}`);

  if (unarmed.length > 0) {
    console.error('\nUNARMED — these assert a credential is absent with nothing to be absent:');
    for (const u of unarmed) console.error(`  ${u.file}:${u.line}  ${u.test}`);
    console.error(
      '\nPut a bearer in the request frame the code under test reads —\n' +
      "  await withRequestContext({ bearerToken: CALLER_JWT, ... }, () => …)\n" +
      'so the assertion fails when the credential IS forwarded. If an empty frame\n' +
      'is genuinely the point, say so inline:\n' +
      '  // unarmed-absence-ok: <why an empty frame is what this test means>',
    );
    if (!reportOnly) process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
