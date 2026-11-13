#!/usr/bin/env bun
// scripts/check-approval-mint-guard.ts
//
// An approval addressed to nobody is not a request — it is a 24-hour timer.
// This guard stops a NEW one from being added.
//
// ── WHY (measured on prod 2026-09-05) ────────────────────────────────────
// 1,482 approvals pending. **925 expire within 5 days** — 86 on 09-09, 839 on
// 09-10. Of those, 274 were NEVER NOTIFIED, and a full triage scored all 274 as
// `insufficient_evidence`: **zero decidable**, because 241 name no approver at
// all (`approver_user_id` NULL, `recipient` "", `approver_source` NULL). They
// are not requests a human ignored; they are rows no human could ever answer.
//
// `domain/engagement/approval-routing.ts` already states the contract, in its
// own doc comment on `resolveApprover`:
//
//     "Returns `approver: null` when nobody qualifies — the caller must fail
//      loud, never write the row."
//
// Measured: of the SEVEN sites inserting into `approvals`, only two honour it.
// The other five never call the resolver and insert a NULL approver. A contract
// five of seven callers ignore is a comment, not a guard.
//
// ⚠️ A FILE-level grep gives a FALSE PASS: `routes/approvals.ts` contains SEVEN
// references to `resolveApprover` and its mint at :872 uses none of them.
//
// ⚠️ The presence of a `throw` is not enough either — `handleCreateApproval`
// throws about a DUPLICATE ("An approval is already pending for this project").
// The refusal must be keyed on the approver being unresolved, which is what
// REFUSAL_RE requires.
//
// This is a RATCHET, not a migration. It does not fix the existing bypasses;
// it stops the next one.
//
// ── WHAT THIS GUARD USED TO GET WRONG (fixed here; read before editing) ───
// Until this change, "is this insert guarded?" was a fixed LOOKBACK WINDOW of
// 130 lines of raw text. That answered the wrong question — *proximity*, not
// *containment* — and it produced a FALSE `guarded`, which on a security guard
// is worse than no guard at all, because it converts an unknown into an
// assurance that gets quoted in review.
//
// MEASURED on this worktree before the fix, with a fixture added under
// `backend/src`: an approval mint with NO refusal of any kind in its own body,
// placed 22 lines below an UNRELATED already-guarded function, was reported
//
//     guarded   backend/src/domain/__repro/repro-mint.ts:28     (exit 0)
//
// The very same two functions, with 200 filler lines pushed between them:
//
//     ERROR: 5 sites insert into `approvals` without refusing ...  (exit 1)
//
// Identical code, opposite verdict, decided purely by line distance. Any new
// unguarded mint written under an existing guarded function passed silently.
//
// The replacement does NOT widen or narrow a window — a distance threshold was
// the defect, not its parameter. It asks the structural question instead: is
// the refusal on the insert's ANCESTOR CHAIN? See `findMintSites` below.
//
// ⛔ Do not reintroduce a line-distance heuristic here. The doc comment this
// replaces argued a window was a "deliberate retreat" from two failed attempts
// at parsing the enclosing declaration by regex. Both of those attempts tried
// to name the enclosing function; this one never needs to — a neighbouring
// scope is a brace block that CLOSES before the insert, so the prefix test
// excludes it without knowing what a function is.
//
// ── AND WHAT THE FIRST CUT OF *THAT* GOT WRONG (fixed here too) ───────────
// The first containment implementation recorded the block path at each line's
// START. A scope that OPENS AND CLOSES ON ONE LINE is invisible to a line-start
// path, so its refusal was attributed to its PARENT — which IS an ancestor of
// the insert. MEASURED on the previous head of this branch, every one of these
// reported `guarded`, at gap 20 AND gap 400 (so it was never the distance):
//
//   register(app) { async function unrelated(ctx) { if (!ctx.approver) {...} }
//                   ... async function mint(db,row) { .insert(approvals) } }
//   const service = { unrelated(ctx) { if (!ctx.approver) throw ... },
//                     async mint(db,row) { .insert(approvals) } }
//   const assertApprover = (c) => { if (!c.approver) throw ... };   (one line)
//   switch (kind) { case "a": { if (!approver) throw ... break; }
//                   case "b": { .insert(approvals) } }
//
// The doc comment that used to sit here claimed "a neighbouring function's body
// is a brace block that CLOSES before the insert, so the prefix test excludes
// it". That was FALSE as written for a body written on one line: nothing in the
// line-start path ever saw it open. The rule is now evaluated at the COLUMN of
// each match, not at the line start, so an intra-line block is entered and
// exited like any other. Still no construct is named.
//
// ⚠️ KNOWN RESIDUAL — the class is UNBRACED CONDITIONAL NESTING, not just a
// `switch` arm. An earlier draft of this note named only the switch arm; that
// was too narrow. The rule credits a refusal whose block path is a PREFIX of
// the insert's, and a conditional that opens NO BRACE adds nothing to that
// path — so the refusal is attributed to the enclosing block, which genuinely
// IS an ancestor of a later insert in that same block. MEASURED 2026-09-08,
// all four read `guarded`:
//
//   if (a) if (!approver) throw ...;            <insert> // nested, unbraced
//   if (a) {} else if (!approver) throw ...;    <insert> // else-if
//   for (const x of xs) if (!approver) throw …; <insert> // loop, unbraced
//   switch (k) { case "a": if (!approver) throw ...; break;
//                case "b": <insert> }                    // unbraced arm
//
// ⚠️ THIS PR INTRODUCES NONE OF THEM. All four were re-measured on the branch
// base AND on both commits of this branch, and read `guarded` at every one of
// those three points. This is a pre-existing limit of brace containment that
// this PR neither creates nor widens — do not read it as a regression.
//
// No brace-containment rule can split these, because there is no brace to
// split on; doing so means naming `if`/`else`/`for`/`case`, which is exactly
// the construct-naming this rule exists to avoid. The honest fix is a real
// parser, not a bigger regex.
//
// BLAST RADIUS TODAY: ZERO. Measured on `backend/src` 2026-09-08, the four
// mint files contain **zero** REFUSAL_RE matches in lexed code. The only raw
// match is `routes/approvals.ts:1048`, which is inside a COMMENT (lexed away
// by `codeOnly`) and in any case sits AFTER the mint at :877, so rule (1)
// would reject it regardless. With no refusal credited anywhere in the tree,
// no site is laundered by any member of this class. That is what makes this a
// documented limit rather than a live hole — but it is load-bearing only while
// it stays zero. ⛔ Do NOT pin this as a test: it is a deliberately unhandled
// shape, and a test asserting the wrong answer only freezes it.
//
// ── THE SECOND AXIS: THE ANSWERABILITY CHOKEPOINT (added 2026-09-26) ──────
// fr#1224 moved the real question one level up. `resolveApprover` answers "is
// there a human named on this row?"; `domain/approvals/one-open-gate.ts ::
// ensureAnswerable` answers the strictly larger "could ANY human have answered
// this row?" — an approver who is a member of the row's tenant, a `requester_id`,
// an `expires_at`, and a `policy_key` that does not name another tenant. It runs
// inside `mintOneOpenGate`, deliberately, because "a route-level check is a check
// the fifth door forgets".
//
// ⛔ MEASURED 2026-09-26: this ratchet could not see that gate at all. A fixture
// that called `resolveApprover`, threw on `approver: null`, and then inserted a
// row with `requester_id`, `expires_at` and `metadata` ALL UNSET was reported
//
//     guarded   backend/src/routes/<fixture>.ts:NN            (exit 0)
//
// — it satisfied the only predicate the ratchet demanded and the census floor
// and offender ceiling both stayed put, because a NEW GUARDED site raises
// `sites.length` (a floor, so more is fine) and leaves `bad.length` at 4. So the
// whole class "a sixth door that refuses a null approver and skips the
// answerability gate" shipped GREEN. That is a FUTURE hole, not a present one:
// re-measured on this branch base, all five live sites are accounted for and
// none of them is such a door. The auditor that first reported a live bypass
// RETRACTED it — the door was its own fixture.
//
// The fix is a SECOND, INDEPENDENT census over the same insert sites, asking
// whether `ensureAnswerable` is on the insert's ancestor chain, with its own
// two-sided ratchet (`MAX_UNANSWERABLE_MINT_SITES`). Two axes and not one
// widened predicate, because the two questions have different populations and
// will be retired on different days: the four legacy direct inserts are expected
// to fold into `mintOneOpenGate`, at which point the answerability count goes to
// zero while the approver count follows its own path.
//
// ⚠️ IT INHERITS THE UNBRACED-CONDITIONAL RESIDUAL documented above, for the
// same reason and in the same direction: `if (x) values = await ensureAnswerable(p);`
// adds no brace, so its call is attributed to the enclosing block and would be
// credited to a later insert there. Nothing in `backend/src` writes that shape
// today, and as with the refusal axis the honest fix is a parser.
//
// ── ⭐ WHAT THIS AXIS CATCHES, AND WHAT IT STILL DOES NOT (2026-09-26) ─────
// `ANSWERABILITY_RE` is a REGEX OVER SOURCE TEXT. It can only ever answer "does
// this file say it binds the gate's result on a path reaching this insert" — never
// "is this row answerable". Six spellings were MEASURED against it. Two are now
// refused ON PURPOSE by the assignment-and-await form and pinned in
// `selfTestFailures`; two more fall out of that same form; TWO REMAIN CREDITED,
// and a reader is entitled to know which.
//
//   CLOSED (pinned by the self-test):
//     (I) void ensureAnswerable(p)            no `await` — refusal never awaited.
//                                             ⭐ THE ACCIDENTAL ONE: nothing about
//                                             it looks wrong, so it is the spelling
//                                             a real developer actually writes.
//     (H) await ensureAnswerable(p)           result discarded, so the row carries
//                                             `p.values` and the gate resolved
//                                             nothing. This guard's own error text
//                                             already warned about it.
//   CLOSED as a side effect of the same form (NOT separately pinned):
//     (N) legacyShim.ensureAnswerable(p)      `\b` used to match after a `.`.
//     (L) p.skipGate || (await ensureAnswerable(p))   and the ternary spelling:
//                                             no `=` immediately before `await`.
//                                             ⚠️ The COMPOUND-ASSIGNMENT spelling
//                                             `values ||= await ensureAnswerable(p)`
//                                             IS still credited — same skippable
//                                             gate, different operator.
//   ⛔ STILL REACHABLE — DO NOT READ THIS AXIS AS COVERING THEM:
//     (J) const v = await ensureAnswerable(p).catch(() => p.values)
//         Binds and awaits, and swallows the refusal. Textually indistinguishable
//         from the correct call; only a parser that reads the call's continuation
//         could tell them apart.
//     (K) a LOCAL no-op function named `ensureAnswerable`, no import from
//         `one-open-gate`. The name matches; nothing gates. This axis does not
//         resolve identifiers to their declarations, so it cannot see the
//         difference — and neither would a wider regex.
//     (M) the RIGHT call with the WRONG arguments — another tenant's id, an empty
//         `values`, or writing `params.values` instead of the values the gate
//         returned. Not a textual property at all; the shape is correct and the
//         semantics are not.
//
// ⇒ A green run on this axis means "no mint site in `backend/src` is MISSING a
// bound gate call". It does NOT mean every row is answerable. The enforcement
// evidence is `fr_approval_answerability_total` at runtime, not this census.
//
// ⛔ Do NOT pin J, K or M as tests. They are deliberately unhandled shapes, and a
// test asserting today's wrong answer only freezes it — same reasoning as the
// unbraced-conditional residual above. If one of them ever appears in the tree,
// the fix is a parser (or a lint rule at the call site), not a bigger regex.
//
// ── AND THE WEAKNESS THAT IS NOT A SPELLING: COUNT vs IDENTITY ────────────
// MEASURED 2026-09-26: a COUNT-PRESERVING SWAP shipped green. Gate one of the four
// existing doors AND add a new ungated door in the same PR, and the unanswerable
// total is still 4 — so both sides of `MAX_UNANSWERABLE_MINT_SITES` stay silent
// about a tree that just gained a door nobody can answer. Every count ratchet in
// this file has that blindness. `KNOWN_UNANSWERABLE_MINT_FILES` closes it on this
// axis by pinning WHICH files may skip the gate; its remaining gap, stated at the
// constant, is a SECOND ungated insert inside an already-listed file, which only
// the count sees. The approver axis is deliberately left on counts alone: any new
// direct insert that skips `ensureAnswerable` is caught here first, and one that
// binds the gate has satisfied the strictly larger question anyway.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BACKEND_SRC = join(import.meta.dir, '..', 'src');

/** A row is written here. */
const INSERT_RE = /\.insert\(approvals\)/;

/**
 * A refusal keyed on THE APPROVER being unresolved. Deliberately narrow: `throw`
 * alone matches every validation in these files and would pass the unguarded
 * sites, which is the whole failure this guard exists to catch.
 */
const REFUSAL_RE =
  /(!\s*\w*\.?approver\b)|(\bapprover\s*===?\s*null)|(approvers\.length\s*===?\s*0)|(!\s*\w*approvers\b)|(\bplanSignoffApprovers\b)/;

/**
 * ...and the CONSEQUENCE that makes that condition a refusal rather than a
 * mention. REFUSAL_RE alone matches only the test, so `if (!approver) {
 * logger.warn(...) }` — a site that notices the problem and writes the row
 * anyway — read `guarded`, as did a bare identifier such as the
 * `planSignoffApprovers` in an import list. Both are the same false assurance
 * this guard exists to remove, so the condition must be followed by code that
 * does not proceed. MEASURED 2026-09-08 before adding this: of the 7
 * REFUSAL_RE matches in `backend/src`, 4 have no `throw`/`return` anywhere near
 * them, and ZERO mint sites change verdict — all 4 are unguarded either way, so
 * this can only ever tighten, never re-classify existing code.
 */
const CONSEQUENCE_RE = /\b(?:throw|return)\b/;

/**
 * ⚠️ KNOWN OVER-STRICTNESS of the consequence test — recorded because it will
 * confuse someone writing a FIX, not because it is a hole.
 *
 * MEASURED 2026-09-08: four shapes that DO refuse are nonetheless reported
 * UNGUARDED. All four flipped `guarded` → UNGUARDED when `CONSEQUENCE_RE` was
 * introduced in this branch's second commit:
 *
 *   if (!x.approver) { continue; }            // loop skip: not throw/return
 *   if (!x.approver) { break; }               // loop exit:  not throw/return
 *   if (!x.approver) { failLoud("..."); }     // a helper that throws
 *   if(!a.approver){warn()} if(!a.approver){throw}   // both on ONE line
 *
 * The first three are `CONSEQUENCE_RE` being a two-word allowlist. The fourth
 * is separate and lives in `findMintSites`: `refusalCol` records only the
 * FIRST REFUSAL_RE match per line (`.match(...)?.index`), so a real refusal
 * later on the same line is never examined.
 *
 * ⚠️ EVERY ONE OF THESE ERRS RED — toward flagging valid code, NEVER toward
 * laundering an unguarded mint. That is the safe direction for a security
 * ratchet, and it is why this is documented rather than fixed here. Measured
 * blast radius today is likewise ZERO: no real site changes verdict, because
 * all four mint sites are unguarded under every variant.
 *
 * THE COST WORTH KNOWING: a future fix written with `continue`, `break`, or a
 * throwing helper GOES UNCREDITED. The two-sided ratchet will sit quietly at 4
 * while the code has actually improved, and whoever wrote that fix will think
 * their refusal did not work. It did — this test cannot see it. Widen this
 * deliberately (and re-measure both directions) rather than assuming the
 * ratchet is broken.
 */

/**
 * A CALL to the answerability chokepoint — `one-open-gate.ts :: ensureAnswerable`
 * — WHOSE RESULT IS BOUND. The assignment AND the `await` are both required, and
 * both requirements are load-bearing.
 *
 * ⭐ MEASURED 2026-09-26, and the whole reason this is not simply
 * `\bensureAnswerable\s*\(`: that pattern set `answerable = true` for spellings
 * that guard NOTHING. Demanding the bound-and-awaited form refuses four of them:
 *
 *   (I)  void ensureAnswerable(params);                     // no `await`
 *   (H)  await ensureAnswerable(params);                    // return discarded
 *   (N)  const v = await legacyShim.ensureAnswerable(p);    // `\b` matched after `.`
 *   (L)  const v = p.skipGate || (await ensureAnswerable(p));   // skippable gate
 *
 * (I) is the ACCIDENTAL one — nothing about it looks wrong, a real developer can
 * write it, and the gate's refusal is a rejected promise nobody awaits, so the row
 * is written anyway. (H) is the one this guard's own error text already warns
 * about: `ensureAnswerable` RESOLVES a missing requester and deadline and returns
 * the values to write, so a caller that drops the return value writes
 * `params.values` and mints the defect it just asked about. None of the four
 * contains `= await ensureAnswerable(`.
 *
 * VERIFIED against the tree BEFORE tightening — this is what makes the tightening
 * free rather than a guess: the ONLY call in `backend/src` is
 * `domain/approvals/one-open-gate.ts:532` —
 *
 *     const values = await ensureAnswerable(params);
 *
 * The `=` also subsumes the older reason for demanding a parenthesis: the
 * `export async function ensureAnswerable` DECLARATION and an
 * `import { ensureAnswerable }` specifier match neither the `=` nor the `await`.
 * The negative lookbehind keeps `==`, `===`, `!==`, `>=` and `<=` out, so
 * `if (x === await ensureAnswerable(p))` — an await whose resolved values are
 * likewise discarded — is not credited as a binding either.
 *
 * ⚠️ KNOWN OVER-STRICTNESS — shapes that DO gate and are nonetheless reported
 * ungated. Every one errs RED (the site reads unanswerable, the census rises, CI
 * fails loudly and names the file), which is the safe direction for a ratchet, and
 * every one is trivially reformatted into the canonical shape:
 *
 *   const values =                      // `=` and `await` on separate LINES;
 *     await ensureAnswerable(params);   //   matching is per lexed line
 *   const values = cond ? await ensureAnswerable(p) : p.values;   // conditional
 *   const values = await gate.ensureAnswerable(p);                // via a member
 *
 * The last two are refused ON PURPOSE, not by accident: a gate that runs on only
 * one branch is spelling (L), and `await something.ensureAnswerable(` is not
 * provably the real gate — that is spelling (N). Widening to admit either would
 * re-open the hole this pattern was tightened to close.
 *
 * ⛔ Do NOT widen this to `mintOneOpenGate`. A site that routes through the
 * minter does not contain `.insert(approvals)` at all and is therefore not a
 * site — there is nothing for this pattern to credit. The only code this axis
 * judges is a DIRECT insert, and a direct insert has to reach the gate itself.
 */
const ANSWERABILITY_RE = /(?<![=!<>])=\s*await\s+ensureAnswerable\s*\(/;

export interface MintSite {
  file: string;
  line: number;
  guarded: boolean;
  /**
   * True when a call to `ensureAnswerable` is on this insert's ancestor chain
   * and textually before it — i.e. the row passed the answerability chokepoint
   * before being written. Independent of `guarded`: the approver axis and the
   * answerability axis ask different questions of the same insert.
   */
  answerable: boolean;
  /** True when the file could not be lexed into balanced braces; see `codeOnly`. */
  unlexable: boolean;
}

/**
 * Blank out comments, string/template literals and regex literals, replacing
 * their bytes with spaces so every offset, line number and — critically — every
 * remaining `{`/`}` is real code.
 *
 * This exists ONLY to make brace depth trustworthy. It is deliberately a local
 * ~70-line lexer and not a shared module: there is currently ZERO precedent for one
 * `check-*.ts` importing another, and creating that precedent is a structural
 * decision that does not belong to this fix. If a second guard ever needs this,
 * promote it deliberately — do not let it happen as a side effect.
 *
 * It is not a full parser and does not need to be, because the caller treats an
 * UNBALANCED result as "cannot judge this file" and marks every insert in it
 * UNGUARDED. Every way this lexer can be wrong therefore costs a false
 * POSITIVE (a site flagged that was fine), never a false `guarded`.
 */
export function codeOnly(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blank = (a: number, b: number): void => {
    for (let k = a; k < Math.min(b, n); k += 1) if (out[k] !== '\n') out[k] = ' ';
  };

  /** Last meaningful code char, to tell a regex literal from a division. */
  let prev = '';
  const REGEX_OK_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', 'r']);

  // Skips a `${ ... }` substitution inside a template literal, honouring nested
  // braces, strings and templates. Returns the offset just past the closing `}`.
  const skipSubst = (start: number): number => {
    let depth = 0;
    let j = start; // at '$'
    j += 1; // '{'
    depth = 1;
    j += 1;
    while (j < n && depth > 0) {
      const ch = src[j]!;
      if (ch === '\\') { j += 2; continue; }
      if (ch === '{') { depth += 1; j += 1; continue; }
      if (ch === '}') { depth -= 1; j += 1; continue; }
      if (ch === '"' || ch === "'") { j = skipQuoted(j, ch); continue; }
      if (ch === '`') { j = skipTemplate(j); continue; }
      j += 1;
    }
    return j;
  };

  function skipQuoted(start: number, q: string): number {
    let j = start + 1;
    while (j < n) {
      const ch = src[j]!;
      if (ch === '\\') { j += 2; continue; }
      if (ch === q) return j + 1;
      if (ch === '\n' && q !== '`') return j; // unterminated: bail at EOL
      j += 1;
    }
    return j;
  }

  function skipTemplate(start: number): number {
    let j = start + 1;
    while (j < n) {
      const ch = src[j]!;
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') return j + 1;
      if (ch === '$' && src[j + 1] === '{') { j = skipSubst(j); continue; }
      j += 1;
    }
    return j;
  }

  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];

    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = skipQuoted(i, c);
      blank(i, j);
      i = j;
      prev = 'r';
      continue;
    }
    if (c === '`') {
      const j = skipTemplate(i);
      blank(i, j);
      i = j;
      prev = 'r';
      continue;
    }
    if (c === '/' && REGEX_OK_AFTER.has(prev) && prev !== 'r') {
      // Regex literals cannot span a line; if no closing `/` before EOL this was
      // a division and we leave it alone.
      let j = i + 1;
      let inClass = false;
      let closed = -1;
      while (j < n && src[j] !== '\n') {
        const ch = src[j]!;
        if (ch === '\\') { j += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = j; break; }
        j += 1;
      }
      if (closed >= 0) {
        blank(i, closed + 1);
        i = closed + 1;
        prev = 'r';
        continue;
      }
    }
    if (!/\s/.test(c)) prev = /[A-Za-z0-9_$)\]]/.test(c) ? 'r' : c;
    i += 1;
  }
  return out.join('');
}

/**
 * The CONSEQUENCE of a refusal match: the code that runs when its condition
 * holds. Walked forward from the match with a RELATIVE brace depth, ending at
 * whichever comes first —
 *
 *   • the `}` that closes the block the condition opens (`if (...) { ... }`,
 *     however many lines it spans, and whether or not it is written inline);
 *   • the `;` that ends a braceless consequence (`if (...) throw ...;`);
 *   • a `}` that closes the scope the condition itself sits in — i.e. there was
 *     no consequence at all, which is what a bare identifier mention looks like.
 *
 * Newlines do NOT end it, so a condition wrapped across lines still finds its
 * body. No construct is named: `{`, `}` and `;` are the only tokens read.
 */
function consequenceOf(
  codeLines: ReadonlyArray<string>,
  line: number,
  col: number,
): { text: string; endLine: number; endCol: number } {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  let opened = false;
  const done = (i: number, c: number): { text: string; endLine: number; endCol: number } => {
    parts.push(buf);
    return { text: parts.join('\n'), endLine: i, endCol: c };
  };
  for (let i = line; i < codeLines.length; i += 1) {
    const s = codeLines[i]!;
    for (let c = i === line ? col : 0; c < s.length; c += 1) {
      const ch = s[c]!;
      if (ch === '{') { depth += 1; opened = true; }
      else if (ch === '}') {
        if (depth === 0) return done(i, c); // left the condition's own scope
        depth -= 1;
        if (depth === 0 && opened) { buf += ch; return done(i, c + 1); }
      } else if (ch === ';' && depth === 0) { buf += ch; return done(i, c + 1); }
      buf += ch;
    }
    parts.push(buf);
    buf = '';
  }
  return { text: parts.join('\n'), endLine: codeLines.length, endCol: 0 };
}

/** Is (l, c) at or after (l0, c0) and strictly before (l1, c1)? */
function within(l: number, c: number, l0: number, c0: number, l1: number, c1: number): boolean {
  const before = (a: number, b: number, x: number, y: number): boolean => a < x || (a === x && b < y);
  return !before(l, c, l0, c0) && before(l, c, l1, c1);
}

/** `a` is an ancestor path of `b`: every block open at `a` is still open at `b`. */
function isAncestorPath(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  if (a.length > b.length) return false;
  for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Classify every `.insert(approvals)` in one file.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────
 * An insert is GUARDED iff a REFUSAL_RE match appears
 *
 *   (1) textually BEFORE it — a refusal after the write cannot prevent it;
 *   (2) inside a brace block that is STILL OPEN at the insert (its block path is
 *       a prefix of the insert's);
 *   (3) not at module scope — a refusal must be inside some body to ever run;
 *   (4) with a CONSEQUENCE that does not proceed (`throw`/`return`) — a
 *       condition that merely logs is not a refusal; and
 *   (5) with the insert NOT inside that consequence — a write inside
 *       `if (!approver) { ... }` runs precisely when nobody can be addressed.
 *
 * (2) is the whole fix. A neighbouring scope is a block that closes before the
 * insert, so its path is NOT a prefix and its refusal cannot launder an
 * unguarded mint — at ANY distance, which is why there is no distance here.
 * A refusal in an `if (...)` HEADER is on the insert's path (its `{` opens
 * AFTER the condition); a refusal buried in a sibling `if` BODY is not.
 *
 * ⭐ "BEFORE" AND "PATH" ARE MEASURED AT THE COLUMN OF THE MATCH, NOT AT THE
 * START OF ITS LINE. This is not a detail: a line-start path cannot see a scope
 * that opens and closes within one line, so `{ if (!x.approver) throw ... }`
 * written inline was credited to the PARENT scope — an ancestor of the insert —
 * and laundered it. Walking the braces THROUGH each line enters and exits an
 * intra-line block like any other, and it is also what makes the legitimate
 * one-liner still work: in `if (!ctx.approver) { throw ... }` the condition sits
 * before that block's `{`, so it is on the insert's path, while a whole body
 * inlined after a `{` is not.
 *
 * REFUSAL_RE is matched against the LEXED line, so a comment or a string that
 * merely mentions `!approver` no longer counts as a refusal either.
 *
 * FAIL-CLOSED: if the file does not lex to balanced braces, brace depth is not
 * trustworthy, so every insert in it is reported UNGUARDED and flagged.
 *
 * ── AND THE SECOND, INDEPENDENT VERDICT ──────────────────────────────────
 * `answerable` applies rules (1), (2) and (3) — before it, on its ancestor chain,
 * not at module scope — to `ANSWERABILITY_RE` instead. Rules (4) and (5) are
 * deliberately absent: they exist to tell a refusal from a mention, and a gate
 * CALL is neither. The two verdicts are reported and ratcheted separately
 * because they have different populations and different retirement dates.
 */
export function findMintSites(files: ReadonlyArray<{ path: string; content: string }>): MintSite[] {
  const sites: MintSite[] = [];
  for (const { path, content } of files) {
    const codeLines = codeOnly(content).split('\n');

    // WHERE on each line the insert and the first refusal actually sit. Column,
    // not just line: a block can open and close between two columns.
    const insertCol = codeLines.map((l) => l.match(INSERT_RE)?.index ?? -1);
    const refusalCol = codeLines.map((l) => l.match(REFUSAL_RE)?.index ?? -1);
    const gateCol = codeLines.map((l) => l.match(ANSWERABILITY_RE)?.index ?? -1);

    // Block path open AT those columns, snapshotted while walking the braces
    // through every line rather than only at line starts.
    const insertPath: Array<number[] | null> = codeLines.map(() => null);
    const refusalPath: Array<number[] | null> = codeLines.map(() => null);
    const gatePath: Array<number[] | null> = codeLines.map(() => null);

    const stack: number[] = [];
    let seq = 0;
    let balanced = true;
    for (let i = 0; i < codeLines.length; i += 1) {
      const line = codeLines[i]!;
      for (let c = 0; c <= line.length; c += 1) {
        if (c === insertCol[i]) insertPath[i] = stack.slice();
        if (c === refusalCol[i]) refusalPath[i] = stack.slice();
        if (c === gateCol[i]) gatePath[i] = stack.slice();
        const ch = line[c];
        if (ch === '{') { seq += 1; stack.push(seq); }
        else if (ch === '}') { if (stack.length === 0) balanced = false; else stack.pop(); }
      }
    }
    if (stack.length !== 0) balanced = false;

    for (let i = 0; i < codeLines.length; i += 1) {
      if (insertCol[i]! < 0) continue;
      let guarded = false;
      if (balanced) {
        const here = insertPath[i] ?? [];
        for (let j = 0; j <= i && !guarded; j += 1) {
          if (refusalCol[j]! < 0) continue;
          if (j === i && refusalCol[j]! >= insertCol[i]!) continue; // not before it
          const there = refusalPath[j] ?? [];
          if (there.length === 0) continue; // module scope: never a refusal that runs
          if (!isAncestorPath(there, here)) continue;
          const cons = consequenceOf(codeLines, j, refusalCol[j]!);
          if (!CONSEQUENCE_RE.test(cons.text)) continue; // a condition that notices, then proceeds
          // ...and a refusal cannot guard a write that IS its consequence: an
          // insert inside `if (!approver) { ... }` runs exactly when there is
          // no approver.
          if (within(i, insertCol[i]!, j, refusalCol[j]!, cons.endLine, cons.endCol)) continue;
          guarded = true;
        }
      }

      // ── THE SECOND AXIS ──────────────────────────────────────────────────
      // Same containment rule — before it, on its ancestor chain, not at module
      // scope — and deliberately WITHOUT the consequence test. A refusal needs a
      // consequence because a condition that merely logs is not a refusal; a gate
      // CALL is not a condition, and its consequence is the throw inside
      // `ensureAnswerable` itself, which is not in this file to inspect. Adding a
      // `throw`/`return` requirement here would demand a shape the correct code
      // does not have (`const values = await ensureAnswerable(params);`).
      //
      // FAIL-CLOSED the same way: an unlexable file answers `false`.
      let answerable = false;
      if (balanced) {
        const here = insertPath[i] ?? [];
        for (let j = 0; j <= i && !answerable; j += 1) {
          if (gateCol[j]! < 0) continue;
          if (j === i && gateCol[j]! >= insertCol[i]!) continue; // not before it
          const there = gatePath[j] ?? [];
          // Module scope is the DECLARATION or an import, never a call that runs
          // on this insert's path.
          if (there.length === 0) continue;
          if (!isAncestorPath(there, here)) continue;
          answerable = true;
        }
      }

      sites.push({ file: path, line: i + 1, guarded, answerable, unlexable: !balanced });
    }
  }
  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/**
 * THE RATCHET — TWO-SIDED, on offenders FOUND.
 *
 * MEASURED on this worktree 2026-09-08 with the containment rule above: 4 mint
 * sites, ALL FOUR unguarded, 0 guarded.
 *
 * ⚠️ RE-MEASURED 2026-09-26: FIVE sites now, of which these same four are unguarded
 * and `routes/project-request-lifecycle.ts:693` is guarded. The ceiling below is
 * still 4 and still correct; the list is the list of OFFENDERS, not of sites.
 *
 *   backend/src/domain/approvals/one-open-gate.ts
 *   backend/src/domain/bridge/submit.ts
 *   backend/src/domain/engagement/action-approvals.ts
 *   backend/src/routes/approvals.ts
 *
 * ⛔ MORE than this fails: another row that will sit unread until it expires.
 * ⛔ FEWER than this ALSO fails, demanding the literal be lowered in the SAME
 *    PR. A one-sided ceiling that equals its own population is not a ratchet at
 *    all: it passes whether the code improves, stagnates, or regresses in any
 *    way that keeps the count at 4 — and the headroom a fix frees gets quietly
 *    refilled by the next PR with nobody seeing it.
 *
 * WHAT LEGITIMATELY CHANGES IT: routing one of the four through
 * `resolveApprover` and refusing on `approver: null` (lower it by one), or
 * deleting/merging a mint site (lower it, and lower MIN_MINT_SITES with it).
 * ⛔ What must NEVER change it: the scanner losing sight of a site. If the count
 * drops and no PR removed or fixed a mint, INSERT_RE or the lexer went blind —
 * fix the detector, do not lower the literal.
 */
export const MAX_UNGUARDED_MINT_SITES = 4;

/**
 * FLOOR ON THE CENSUS ITSELF, independent of the offender count above.
 *
 * The offender ratchet is blind to one failure: once sites start becoming
 * guarded, a walker or matcher that silently stops seeing them leaves the
 * offender count untouched while the population collapses. `sites.length === 0`
 * catches TOTAL blindness only; this catches PARTIAL blindness.
 *
 * ⚠️ CORRECTED 2026-09-26 — this literal read 4 while the tree held FIVE inserts:
 * `routes/project-request-lifecycle.ts:693` arrived after the 2026-09-08 census and
 * nobody raised the floor. A floor ONE BELOW its own population is not a floor. A
 * mint site could have been deleted, or the walker gone blind on one file, and both
 * this guard AND its test stayed green — the test asserts
 * `toBeGreaterThanOrEqual(MIN_MINT_SITES)`, which 5 ≥ 4 satisfied with a spare site
 * of slack. MEASURED live 2026-09-26: 5 inserts into `approvals` across
 * `backend/src`. The literal is 5 and the slack is gone.
 *
 * It stays a ONE-SIDED floor on purpose. Upward drift is a different question and
 * has its own detectors: a sixth insert that skips the gate is caught by
 * `MAX_UNANSWERABLE_MINT_SITES` and named by `KNOWN_UNANSWERABLE_MINT_FILES`; a
 * sixth insert that binds `ensureAnswerable`'s result is the shape this guard wants
 * and is deliberately not an error.
 *
 * WHAT LEGITIMATELY CHANGES IT: a mint site genuinely deleted, or several
 * routed through one shared helper — as fr#1000 did, taking 7 to 4 by moving
 * four callers behind `mintOneOpenGate`. Both are deliberate edits to this
 * literal in the same PR. A drop with no such change in the diff is the
 * detector going blind.
 */
export const MIN_MINT_SITES = 5;

/**
 * THE ANSWERABILITY RATCHET — TWO-SIDED, on the same sites, different question.
 *
 * MEASURED on this worktree 2026-09-26: 5 mint sites, of which FOUR never reach
 * `ensureAnswerable`, and exactly ONE does —
 *
 *   backend/src/domain/approvals/one-open-gate.ts       ← the chokepoint itself
 *   backend/src/domain/bridge/submit.ts                 (direct)
 *   backend/src/domain/engagement/action-approvals.ts   (direct)
 *   backend/src/routes/approvals.ts                     (direct)
 *   backend/src/routes/project-request-lifecycle.ts     (direct)
 *
 * ⛔ MORE than 4 fails: a NEW door writing an approval row nobody can answer —
 * which is precisely the class that passed green before this axis existed,
 * because a new site that refuses a null approver reads `guarded` and moves
 * neither the census floor nor the offender ceiling.
 * ⛔ FEWER than 4 ALSO fails, for the reason the sibling ratchet above states at
 * length: a one-sided ceiling equal to its own population passes whether the code
 * improves, stagnates, or regresses, and the headroom a fix frees gets refilled
 * by the next PR with nobody seeing it.
 *
 * WHAT LEGITIMATELY CHANGES IT: routing one of the four direct inserts through
 * `mintOneOpenGate` (which deletes the insert entirely — lower this AND
 * `MIN_MINT_SITES` AND probably `MAX_UNGUARDED_MINT_SITES`), or calling
 * `ensureAnswerable` at a direct site before its write (lower this one alone).
 * ⛔ What must NEVER change it: `ANSWERABILITY_RE` or the lexer losing sight of a
 * call. If the count drops and no PR touched a mint path, fix the detector.
 *
 * ⚠️ THIS IS NOT A CEILING ON UNANSWERABLE ROWS IN PROD. It counts insert SITES
 * that skip the gate, in code. What the gate actually refuses — and whether
 * `FR_APPROVAL_ANSWERABILITY_MODE=enforce` may be flipped — is only readable from
 * `fr_approval_answerability_total` (lib/approval-answerability-metrics.ts).
 */
export const MAX_UNANSWERABLE_MINT_SITES = 4;

/**
 * THE IDENTITY SET BEHIND THAT COUNT — the thing a count cannot pin.
 *
 * ⭐ MEASURED 2026-09-26: A COUNT-PRESERVING SWAP SHIPS GREEN. Route one of the
 * four direct inserts through the gate AND add one new ungated door in the same
 * PR: the total is still 4, so BOTH sides of `MAX_UNANSWERABLE_MINT_SITES` stay
 * silent and the guard reports "unchanged" about a tree that just gained a door
 * whose rows nobody can answer. Every count ratchet in this file shares that
 * blindness; this closes it on the answerability axis by pinning WHICH files are
 * permitted to skip the gate. An unanswerable site in any other file FAILS, at any
 * count.
 *
 * FILES, not `file:line`. Line numbers churn for unrelated reasons — the gate's own
 * insert moved 532 → 541 inside this very PR — and a pin that reddens on an
 * unrelated edit gets "fixed" by whoever is unblocking CI, which is how a ratchet
 * dies. THE COST OF FILE GRANULARITY, stated so it is not discovered later: a
 * SECOND ungated insert added to an already-listed file is invisible HERE. It is
 * caught by the count ceiling instead, because it takes the total to 5.
 *
 * WHAT LEGITIMATELY CHANGES IT: exactly what changes the count — routing one of
 * these four through `mintOneOpenGate`, or binding `ensureAnswerable`'s result at
 * the site. Remove the entry in the SAME PR that lowers
 * `MAX_UNANSWERABLE_MINT_SITES`; the two are kept in lockstep by the self-test.
 *
 * ⛔ What must NEVER change it: a new door. Adding a file here is admitting a new
 * approval nobody can answer — the exact defect this guard exists to stop.
 */
export const KNOWN_UNANSWERABLE_MINT_FILES: ReadonlyArray<string> = [
  'backend/src/domain/bridge/submit.ts',
  'backend/src/domain/engagement/action-approvals.ts',
  'backend/src/routes/approvals.ts',
  'backend/src/routes/project-request-lifecycle.ts',
];

const short = (f: string): string => f.replace(/^.*\/backend\//, 'backend/');

export function unguardedError(sites: MintSite[]): string | null {
  const bad = sites.filter((s) => !s.guarded);
  const unlexable = sites.filter((s) => s.unlexable);

  if (unlexable.length > 0) {
    return (
      `ERROR: ${unlexable.length} mint site(s) sit in files that do not lex to\n` +
      `balanced braces, so containment could not be judged. Reported UNGUARDED by\n` +
      `design — this guard never answers "guarded" from an untrustworthy parse.\n\n` +
      unlexable.map((s) => `  ${short(s.file)}:${s.line}`).join('\n') +
      `\n\nFix \`codeOnly\` in this script for whatever construct it mis-lexes.\n`
    );
  }

  if (sites.length < MIN_MINT_SITES) {
    return (
      `ERROR: the scan found only ${sites.length} insert(s) into \`approvals\`, below the\n` +
      `census floor of ${MIN_MINT_SITES}. Either a mint site was genuinely removed — in which\n` +
      `case lower MIN_MINT_SITES (and MAX_UNGUARDED_MINT_SITES) in this same PR — or\n` +
      `INSERT_RE / the walker has gone blind and this guard is now reporting a\n` +
      `property it can no longer see.\n`
    );
  }

  if (bad.length > MAX_UNGUARDED_MINT_SITES) {
    return (
      `ERROR: ${bad.length} sites insert into \`approvals\` without refusing when no\n` +
      `approver can be resolved, above the ceiling of ${MAX_UNGUARDED_MINT_SITES}.\n\n` +
      bad.map((s) => `  ${short(s.file)}:${s.line}`).join('\n') +
      `\n\nCall \`resolveApprover\` (domain/engagement/approval-routing.ts) and throw when\n` +
      `it returns \`approver: null\`. Its own doc comment states the contract:\n` +
      `"the caller must fail loud, never write the row".\n`
    );
  }

  if (bad.length < MAX_UNGUARDED_MINT_SITES) {
    return (
      `ERROR: only ${bad.length} unguarded mint site(s) found, BELOW the ratchet floor of\n` +
      `${MAX_UNGUARDED_MINT_SITES}. This is not a failure of the code — it is the ratchet asking to be\n` +
      `tightened. Lower MAX_UNGUARDED_MINT_SITES to ${bad.length} in this same PR, so the headroom\n` +
      `you just freed cannot be silently refilled by the next one.\n\n` +
      `⚠️ If no PR fixed a mint site, the detector went blind instead — fix it, do\n` +
      `not lower the literal.\n`
    );
  }

  // ── THE SECOND AXIS, reported separately so the message names the right fix ──
  const unanswerable = sites.filter((s) => !s.answerable);

  if (unanswerable.length > MAX_UNANSWERABLE_MINT_SITES) {
    return (
      `ERROR: ${unanswerable.length} sites insert into \`approvals\` WITHOUT passing through the\n` +
      `answerability chokepoint, above the ceiling of ${MAX_UNANSWERABLE_MINT_SITES}.\n\n` +
      unanswerable.map((s) => `  ${short(s.file)}:${s.line}`).join('\n') +
      `\n\nRefusing a null approver is NOT this gate. \`domain/approvals/one-open-gate.ts ::\n` +
      `ensureAnswerable\` additionally requires the approver to be a member of the row's\n` +
      `TENANT, and a \`requester_id\`, an \`expires_at\` and a \`policy_key\` that does not name\n` +
      `another tenant — a row can name a reachable approver and still be answerable by\n` +
      `nobody.\n\n` +
      `Route the new path through \`mintOneOpenGate\` (which removes the insert, and the\n` +
      `site, entirely) rather than calling the gate by hand at a sixth door. If you must\n` +
      `insert directly, \`await ensureAnswerable({ tenantId, cardId, values })\` and write\n` +
      `THE VALUES IT RETURNS — it resolves a missing requester and deadline, so writing\n` +
      `\`params.values\` instead discards the resolution and mints the defect anyway.\n`
    );
  }

  if (unanswerable.length < MAX_UNANSWERABLE_MINT_SITES) {
    return (
      `ERROR: only ${unanswerable.length} mint site(s) skip the answerability gate, BELOW the ratchet\n` +
      `floor of ${MAX_UNANSWERABLE_MINT_SITES}. Not a failure of the code — the ratchet asking to be tightened.\n` +
      `Lower MAX_UNANSWERABLE_MINT_SITES to ${unanswerable.length} in this same PR, so the headroom you just\n` +
      `freed cannot be silently refilled by the next one.\n\n` +
      `⚠️ If no PR routed a mint through the gate, ANSWERABILITY_RE or the lexer went\n` +
      `blind instead — fix it, do not lower the literal.\n\n` +
      `⚠️ Drop the fixed site from KNOWN_UNANSWERABLE_MINT_FILES in the same edit, or the\n` +
      `allowlist keeps a door open that the code has already closed.\n`
    );
  }

  // ── AND THE IDENTITY SET, because the count above cannot see a SWAP ────────
  const allowed = new Set(KNOWN_UNANSWERABLE_MINT_FILES);
  const strangers = unanswerable.filter((s) => !allowed.has(short(s.file)));
  if (strangers.length > 0) {
    return (
      `ERROR: ${strangers.length} site(s) skip the answerability chokepoint from a file that is NOT\n` +
      `in KNOWN_UNANSWERABLE_MINT_FILES.\n\n` +
      strangers.map((s) => `  ${short(s.file)}:${s.line}`).join('\n') +
      `\n\nThe count alone cannot catch this: gating one existing door and adding one new\n` +
      `ungated door in the same PR leaves the total at ${MAX_UNANSWERABLE_MINT_SITES}, and both sides of the\n` +
      `count ratchet stay silent. Route this path through \`mintOneOpenGate\`, or bind the\n` +
      `gate's result — \`const values = await ensureAnswerable({ tenantId, cardId, values })\`\n` +
      `— and write THE VALUES IT RETURNS.\n\n` +
      `⛔ Do NOT add the file to the allowlist to make this pass. That admits a new\n` +
      `approval row nobody can answer, which is the defect this guard exists to stop.\n`
    );
  }

  return null;
}

/**
 * ANTI-VACUITY SELF-TEST — run before any verdict is printed.
 *
 * The defect this script was rewritten for was a classifier that answered
 * "guarded" about an unguarded insert. A guard that can only ever say "guarded"
 * still prints OK forever. So prove, on every run, that the classifier can
 * produce BOTH answers, and specifically that it produces UNGUARDED for the
 * exact shape that used to launder: an unguarded mint below a guarded neighbour.
 */
export function selfTestFailures(): string[] {
  const fails: string[] = [];
  const at = (content: string) => findMintSites([{ path: '/selftest/backend/src/x.ts', content }])[0];

  const guarded = at(
    [
      'async function mint(db, ctx) {',
      '  const routing = await resolveApprover({ tenantId });',
      '  if (!routing.approver) {',
      '    throw new ValidationError("No reachable human approver");',
      '  }',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!guarded || guarded.guarded !== true) {
    fails.push('classifier cannot recognise a genuine in-scope refusal (would flag everything)');
  }

  const neighbour = at(
    [
      'async function unrelated(ctx) {',
      '  if (!ctx.approver) {',
      '    throw new Error("no approver");',
      '  }',
      '}',
      'async function mint(db, row) {',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!neighbour || neighbour.guarded !== false) {
    fails.push(
      'classifier reports GUARDED for an unguarded mint below an unrelated guarded ' +
        'function — the exact false assurance this guard was rewritten to remove',
    );
  }

  // ⭐ The `neighbour` fixture above writes the neighbour's braces on SEPARATE
  // LINES, which is congruent with the blind spot the line-start path had: it
  // could not have caught an inlined body, so it could not detect that this
  // self-test was insensitive to one. These two cover that shape.
  const inlineNeighbour = at(
    [
      'export function register(app) {',
      '  async function unrelated(ctx) { if (!ctx.approver) { throw new Error("no approver"); } }',
      '  async function mint(db, row) {',
      '    await db.insert(approvals).values(row);',
      '  }',
      '}',
    ].join('\n'),
  );
  if (!inlineNeighbour || inlineNeighbour.guarded !== false) {
    fails.push(
      'classifier reports GUARDED for a mint beside a neighbour whose whole body is on ONE ' +
        'LINE — a scope that opens and closes between two columns, so a line-start path ' +
        'credits its refusal to the PARENT scope, which IS an ancestor of the insert',
    );
  }

  const switchArm = at(
    [
      'async function mint(db, row, kind) {',
      '  switch (kind) {',
      '    case "a": { if (!approver) { throw new Error("no approver"); } break; }',
      '    case "b": {',
      '      await db.insert(approvals).values(row);',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  );
  if (!switchArm || switchArm.guarded !== false) {
    fails.push(
      'classifier reports GUARDED for an insert in a DIFFERENT switch arm from the refusal',
    );
  }

  // ⛔ ANTI-OVERCORRECTION. The cheap way to pass the two above is to distrust
  // every refusal sharing a line with a brace. That would silently reclassify
  // real guards as offenders, so pin the inlined refusal that DOES guard: its
  // condition sits before that block's `{`, hence on the insert's own path.
  const inlineGuard = at(
    [
      'async function mint(db, ctx, row) {',
      '  if (!ctx.approver) { throw new ValidationError("No reachable human approver"); }',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!inlineGuard || inlineGuard.guarded !== true) {
    fails.push(
      'classifier no longer recognises a genuine refusal written on ONE LINE — the same-line ' +
        'fix must exclude an inlined BODY, not every inlined refusal',
    );
  }

  // A condition that NOTICES the missing approver and writes the row anyway.
  // REFUSAL_RE matches the test, never the consequence, so this used to read
  // `guarded` — the inherited half of the same false assurance.
  const logsOnly = at(
    [
      'async function mint(db, ctx, row) {',
      '  if (!ctx.approver) {',
      '    logger.warn("no approver; sending to nobody");',
      '  }',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!logsOnly || logsOnly.guarded !== false) {
    fails.push('classifier accepts a condition whose consequence only LOGS, and still writes the row');
  }

  const sibling = at(
    [
      'async function mint(db, row) {',
      '  if (existing) {',
      '    throw new ValidationError("An approval is already pending for this project");',
      '  }',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!sibling || sibling.guarded !== false) {
    fails.push('classifier accepts a refusal that is not keyed on the approver');
  }

  // ── THE ANSWERABILITY AXIS — both answers, on every run ────────────────────
  // ⭐ THE FIXTURE THAT USED TO PASS. Measured 2026-09-26: this exact shape —
  // `resolveApprover`, a throw on null, then an insert with `requester_id`,
  // `expires_at` and `metadata` all unset — printed `guarded ... exit 0`. It is
  // pinned as GUARDED-BUT-UNANSWERABLE because that pairing is the whole point:
  // if a future edit makes `answerable` fall out of `guarded`, the axis has
  // collapsed back into the one it was added to complement.
  const approverOnly = at(
    [
      'async function mintSixthDoor(db, ctx, row) {',
      '  const routing = await resolveApprover({ tenantId: ctx.tenantId });',
      '  if (!routing.approver) {',
      '    throw new ValidationError("No reachable human approver");',
      '  }',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!approverOnly || approverOnly.guarded !== true || approverOnly.answerable !== false) {
    fails.push(
      'classifier no longer separates the two axes: a site that refuses a null approver and ' +
        'NEVER calls `ensureAnswerable` must read guarded=true AND answerable=false — the ' +
        'exact fixture that passed this ratchet green before the answerability axis existed',
    );
  }

  const gated = at(
    [
      'async function mint(db, params) {',
      '  const values = await ensureAnswerable(params);',
      '  for (let attempt = 0; attempt < 2; attempt += 1) {',
      '    const [row] = await db.insert(approvals).values(values).returning();',
      '    if (row) return row;',
      '  }',
      '}',
    ].join('\n'),
  );
  if (!gated || gated.answerable !== true) {
    fails.push(
      'classifier cannot recognise the REAL chokepoint — `ensureAnswerable` awaited in the ' +
        "function body with the insert nested one block deeper (mintOneOpenGate's own shape); " +
        'it would report every site unanswerable and the floor could never be lowered',
    );
  }

  // The mirror of the `neighbour` case on this axis: a gate call in a scope that
  // CLOSES before the insert cannot launder it, at any distance.
  const gateNeighbour = at(
    [
      'export function register(app) {',
      '  async function other(params) { const v = await ensureAnswerable(params); return v; }',
      '  async function mint(db, row) {',
      '    await db.insert(approvals).values(row);',
      '  }',
      '}',
    ].join('\n'),
  );
  if (!gateNeighbour || gateNeighbour.answerable !== false) {
    fails.push(
      'classifier credits an `ensureAnswerable` call from a NEIGHBOURING scope — the same ' +
        'false assurance the containment rule removed on the refusal axis',
    );
  }

  // ...and the gate call must be BEFORE the write. Calling it afterwards leaves
  // the unanswerable row in place and merely fails the response.
  const gateAfter = at(
    [
      'async function mint(db, params, row) {',
      '  await db.insert(approvals).values(row);',
      '  await ensureAnswerable(params);',
      '}',
    ].join('\n'),
  );
  if (!gateAfter || gateAfter.answerable !== false) {
    fails.push(
      'classifier credits an `ensureAnswerable` call that runs AFTER the insert — a gate ' +
        'downstream of the write cannot prevent it',
    );
  }

  // ⛔ ANTI-OVERCORRECTION on this axis: the gate's own DECLARATION sits at module
  // scope. `one-open-gate.ts` both declares the gate and holds a mint site, so if
  // a declaration counted, that file would self-certify. (Since 2026-09-26 both the
  // declaration and an `import { ensureAnswerable }` specifier are ALSO excluded one
  // step earlier, by the pattern demanding `= await` — so the module-scope rule is
  // pinned separately by `gateModuleScopeBound` below, which the pattern DOES match.)
  const gateDeclarationOnly = at(
    [
      'import { ensureAnswerable } from "../approvals/one-open-gate";',
      'export async function ensureAnswerable(params) { return params.values; }',
      'async function mint(db, row) {',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!gateDeclarationOnly || gateDeclarationOnly.answerable !== false) {
    fails.push(
      "classifier credits the module-scope DECLARATION of `ensureAnswerable` as if it were a " +
        "call on the insert's path — which would let the gate's own file self-certify",
    );
  }

  // ── THE SPELLINGS THAT USED TO BE CREDITED AND MUST NOT BE ────────────────
  // MEASURED 2026-09-26 against `\bensureAnswerable\s*\(`: each of these read
  // answerable=true while guarding nothing. They are pinned here because they are
  // now DELIBERATELY REFUSED — unlike the residual shapes listed in the header,
  // which are unhandled and must not be pinned.

  // ⭐ (I) THE ACCIDENTAL ONE: no `await`. The gate's refusal is a rejected promise
  // nobody waits for, so the insert below it runs regardless.
  const gateVoid = at(
    [
      'async function mint(db, params, row) {',
      '  void ensureAnswerable(params);',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!gateVoid || gateVoid.answerable !== false) {
    fails.push(
      'classifier credits `void ensureAnswerable(params)` — a call whose refusal is never ' +
        'awaited, so the row is written anyway; the accidental spelling a real developer writes',
    );
  }

  // (H) awaited but DISCARDED. `ensureAnswerable` resolves a missing requester and
  // deadline; a caller that drops the return value writes `params.values` and mints
  // the defect it just asked about — which this guard's own error text warns about.
  const gateDiscarded = at(
    [
      'async function mint(db, params, row) {',
      '  await ensureAnswerable(params);',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!gateDiscarded || gateDiscarded.answerable !== false) {
    fails.push(
      'classifier credits an `await ensureAnswerable(params)` whose RESULT IS DISCARDED — the ' +
        'row then carries `params.values`, unresolved, and the gate changed nothing',
    );
  }

  // ⛔ ANTI-OVERCORRECTION on the tightened pattern: a DESTRUCTURING bind is the
  // same correct shape as `const values = await ...` and must stay credited, or the
  // next legitimate refactor of the chokepoint silently reads unanswerable.
  const gateDestructured = at(
    [
      'async function mint(db, params) {',
      '  const { values, resolved } = await ensureAnswerable(params);',
      '  await db.insert(approvals).values(values);',
      '}',
    ].join('\n'),
  );
  if (!gateDestructured || gateDestructured.answerable !== true) {
    fails.push(
      'classifier refuses a DESTRUCTURING bind of the gate result — `const { values } = await ' +
        'ensureAnswerable(params)` gates exactly as well as a plain assignment',
    );
  }

  // Rule (3) on the tightened pattern: a bound call at MODULE scope (top-level
  // await) is on no insert's ancestor chain and must not credit one.
  const gateModuleScopeBound = at(
    [
      'const seeded = await ensureAnswerable(bootParams);',
      'async function mint(db, row) {',
      '  await db.insert(approvals).values(row);',
      '}',
    ].join('\n'),
  );
  if (!gateModuleScopeBound || gateModuleScopeBound.answerable !== false) {
    fails.push(
      'classifier credits a MODULE-SCOPE bound `ensureAnswerable` call as if it ran on the ' +
        "insert's path — a top-level await gates nothing inside a function body",
    );
  }

  // The allowlist and the ceiling describe the SAME population from two sides. If
  // they disagree, one was edited and the other forgotten, and the identity check
  // either passes a door or blocks a fix.
  if (KNOWN_UNANSWERABLE_MINT_FILES.length !== MAX_UNANSWERABLE_MINT_SITES) {
    fails.push(
      `KNOWN_UNANSWERABLE_MINT_FILES lists ${KNOWN_UNANSWERABLE_MINT_FILES.length} file(s) but ` +
        `MAX_UNANSWERABLE_MINT_SITES is ${MAX_UNANSWERABLE_MINT_SITES} — the identity set and the ` +
        'count must be lowered in the same edit',
    );
  }

  return fails;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === 'node_modules' || e === '__tests__') continue;
      walk(p, out);
    } else if (e.endsWith('.ts') && !e.includes('.test.')) {
      out.push(p);
    }
  }
  return out;
}

function main(): void {
  const selfFails = selfTestFailures();
  if (selfFails.length > 0) {
    console.error('ERROR: this guard failed its own classifier self-test:\n');
    for (const f of selfFails) console.error(`  - ${f}`);
    console.error('\nIts verdict below would have been meaningless, so none was produced.');
    process.exit(3);
  }

  const files = walk(BACKEND_SRC).map((p) => ({ path: p, content: readFileSync(p, 'utf8') }));
  const sites = findMintSites(files);
  if (sites.length === 0) {
    console.error('ERROR: found ZERO inserts into `approvals` — the scan proved nothing.');
    process.exit(2);
  }
  const err = unguardedError(sites);
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const bad = sites.filter((s) => !s.guarded).length;
  const ungated = sites.filter((s) => !s.answerable).length;
  console.log(
    `OK: ${sites.length} approval mint site(s) (floor ${MIN_MINT_SITES}) — ${sites.length - bad} refuse ` +
      `an unresolvable approver, ${bad} do not (ratchet pinned at ${MAX_UNGUARDED_MINT_SITES}); ` +
      `${sites.length - ungated} pass the answerability chokepoint, ${ungated} do not ` +
      `(ratchet pinned at ${MAX_UNANSWERABLE_MINT_SITES}).`,
  );
  for (const s of sites) {
    console.log(
      `  ${s.guarded ? 'guarded  ' : 'UNGUARDED'} ` +
        `${s.answerable ? 'answerability-gated' : 'NO-ANSWERABILITY-GATE'} ` +
        `${short(s.file)}:${s.line}`,
    );
  }
}

if (import.meta.main) main();
