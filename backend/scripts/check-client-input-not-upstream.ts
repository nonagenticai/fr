#!/usr/bin/env bun
// backend/scripts/check-client-input-not-upstream.ts
//
// Guard: fr must not report a CALLER's mistake as an UPSTREAM failure.
//
// The hole this closes
// --------------------
// `IntegrationErrorCode` had no caller-side member. Every member named an
// upstream failure mode, so a route that needed to say "the caller sent
// malformed JSON" reached for the nearest-sounding one, `UPSTREAM_BAD_BODY`,
// which maps to a hard 502. 115 sites used it; 81 were validating the INBOUND
// request. The type made the wrong answer the convenient one.
//
// The status is not cosmetic — three layers key on the 5xx class:
//   * Cloudflare substitutes its own HTML page for origin 5xx bodies, so an API
//     client never sees fr's JSON envelope.
//   * routes/agui.ts classifyError decides permanence from `upstreamStatus`. An
//     UPSTREAM_* error that carries none is advertised `retriable: true`, so
//     agents retry input that can never succeed.
//   * 20 n8n node modules retry on `statusCode >= 500` (MAX_RETRIES 3, delays
//     [1000, 2000, 4000]); five of them call fr directly.
//
// MEASURED in production 2026-08-31, pod fr-79bb8c7465-6chrn:
//     [http] GET /api/assets/artifacts/00000000-...-000000000000 502 14.7ms
// A request with no `project_id`. `readProjectIdOrThrow` threw before
// `emitSpan`, so the whole failure left one access-log line — no code, no
// service, no cause.
//
// TWO RULES
// ---------
// R1 (lexicon). An `UPSTREAM_*` construction whose message is written in the
//    vocabulary of inbound validation is a defect. Waivable inline, with a
//    reason.
//
// R2 (ratchet). An `UPSTREAM_*` construction that sets no `upstreamStatus` is
//    the exact shape that cannot be told apart from a caller error — by a
//    reader, and by `classifyError`. Their number must not GROW. This is a
//    count, not a verdict: many are legitimate (an upstream that answered 200
//    with an unparseable body). It exists so the population shrinks over time
//    and never silently regrows.
//
// R1 alone is not enough: a message lexicon cannot be tightened far enough to
// catch every case without false-positiving on genuine upstream text
// ("Keycloak 201 missing Location header"). R2 alone is not enough: it is a
// count, so a swap — remove one legitimate site, add one client-input site —
// nets to zero. Together they cover each other.
//
// FAIL-CLOSED, deliberately (a fail-open regex in an earlier guard reported
// 5 of 23 and exited 0):
//   * zero source files walked                 -> exit 1
//   * zero IntegrationError constructions seen -> exit 1 (the pattern rotted)
//   * fewer than MIN_SCANNED constructions     -> exit 1 (it rotted PARTIALLY,
//                                                 which a bare zero-check
//                                                 cannot see)

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Vocabulary of INBOUND validation. Every entry is taken from a message that
 * actually existed in this repo at the time of the sweep, not invented.
 *
 * Deliberately NOT included, each for a measured reason:
 *
 *   /missing/, /has no/  — both appear in genuine upstream messages: "Keycloak
 *       201 missing Location header", "reply has no executionId".
 *
 *   /parsed\.error/, /\.issues/  — zod parses BOTH directions. Open PR #895
 *       adds `quality-judges.ts` throwing UPSTREAM_BAD_BODY with
 *       "upstream evaluate response did not match the expected shape
 *       (${parsed.error.issues…})" — a genuine upstream site, and correct.
 *       Including these would have red-lit a peer's correct code.
 *
 * A detector that fires on correct code teaches the next reader to waive rather
 * than to look, which is how a guard becomes decoration. R1 is a REGRESSION
 * guard, not the discovery tool — the 78-site sweep was done by reading each
 * site — so it is tuned for precision, and R2 covers what it declines to guess.
 */
const CLIENT_INPUT_MESSAGE =
  /invalid json|query parameter is required|must be a |multipart|limited to |request body|body\.\w+ (?:is )?required/i;

/** Any code in the upstream family. */
const UPSTREAM_CODE = /^UPSTREAM_/;

/**
 * Opt out, with a reason. An empty reason is not a waiver.
 *
 * The character class after the colon is `[ \t]`, NOT `\s` — deliberately.
 * `\s` matches a newline, so `\s*(\S.*)` walks past a bare marker and adopts
 * the first non-space of the NEXT LINE as the reason. That exact fail-open bug
 * was found in check-credential-absence-armed.ts by mutating it: a marker with
 * its reason deleted still waived, because the following `const req = …` served
 * as the justification. An exemption that accepts a line of code as a rationale
 * is fail-open — the defect class these guards exist to catch.
 */
const WAIVER = /\/\/[ \t]*client-input-code-ok:[ \t]*(\S[^\n]*)/;

/** How far above a construction a waiver comment may sit. */
const WAIVER_LOOKBEHIND_LINES = 4;

/**
 * Floor for pattern rot. A detector that silently stops matching reads exactly
 * like a clean repo. Raise this when the true count rises; lowering it is a
 * decision that belongs in the same commit as the deletions that justify it.
 */
export const MIN_SCANNED = 150;

/**
 * R2's ceiling: UPSTREAM_*-coded constructions whose `upstreamStatus` was not
 * READ FROM A RESPONSE — absent, or hand-written. Lowering it is always welcome
 * and needs no ceremony. RAISING it means a new error was added that a reader
 * cannot attribute and `classifyError` will call retriable — say why in the
 * commit message.
 *
 * MEASURED at 56 when this was set (`bun run` this script and read its census
 * line; do not hand-write the number). Two movements landed together:
 *   -17  the sites decided by tracing their callers, off UPSTREAM_* entirely
 *   +13  hand-written literals that the loosened-then-tightened R2 now counts
 *
 * The headroom is deliberate and is the lesson of the previous value. This was
 * pinned at exactly 60 against a population of exactly 60 — zero slack — in a
 * repo with concurrent PRs, and open PR #895 adds two attributable-by-hand
 * sites. A ratchet with no headroom does not catch regrowth; it just fails the
 * next person's unrelated PR. 65 leaves room for #895's +2 and for ordinary
 * concurrent work, while still catching a real regrowth.
 */
export const MAX_UNATTRIBUTED = 65;

export interface Site {
  file: string;
  line: number;
  code: string;
  message: string;
  /** The literal source text of `upstreamStatus:`, or undefined if absent. */
  upstreamStatusValue?: string;
  waiver?: string;
}

/**
 * Is this `upstreamStatus` READ from a response, rather than written by hand?
 *
 * `res.status` / `upstream.status` / `err.statusCode` can only have come from a
 * real reply. A hard-coded number cannot: the author chose it.
 *
 * This distinction is load-bearing, and it was MISSING from the first version
 * of this guard. R1 exempted on the mere PRESENCE of `upstreamStatus`, which
 * left a third door: a client-input error with a FABRICATED
 * `upstreamStatus: 400` was exempt from R1, uncounted by R2, and still returned
 * 502 — because `httpStatusFor` honours `upstreamStatus` only under
 * `UPSTREAM_BAD_STATUS`. That is not hypothetical: it is exactly the shape this
 * PR found four times in `routes/tools/analytics.ts`, where someone wrote
 * `upstreamStatus: 413` and got a 502. A guard blind to the defect its own
 * sweep uncovered is decoration.
 *
 * Hand-written values stay legitimate in plenty of places (`404` in the bridge
 * sources, `415`, `403`, `201`), so a literal is not itself a finding — it just
 * does not BUY the exemption. Those sites fall back to the lexicon, which does
 * not match them.
 */
/**
 * R2's predicate: does this site fail to attribute its status to a response?
 *
 * Exported and tested DIRECTLY, because the bug this closes was not that
 * `isReadFromResponse` was wrong -- it was correct -- but that R2 did not CALL
 * it. `isReadFromResponse` had its own passing test the whole time while R2
 * filtered on `=== undefined` a few lines away. Testing the helper proved
 * nothing about the rule that mattered, so the rule now has a name and a test
 * of its own.
 */
export function isUnattributed(site: Pick<Site, 'upstreamStatusValue'>): boolean {
  return !isReadFromResponse(site.upstreamStatusValue);
}

export function isReadFromResponse(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^[A-Za-z_$][\w$]*(?:\?)?\.[\w$.?]*status(?:Code)?$/i.test(value);
}

/**
 * Every `new IntegrationError({...})` in a file, with its object literal read
 * by brace balancing rather than by regex — a nested `upstreamBody: { … }` ends
 * a lazy `\{[\s\S]*?\}` match early and silently hides the fields after it.
 */
export function scanFile(path: string, src: string): Site[] {
  const out: Site[] = [];
  const NEW = /new IntegrationError\s*\(\s*\{/g;
  for (const m of src.matchAll(NEW)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue; // unbalanced: not ours to interpret
    const lit = src.slice(open, close + 1);
    const code = lit.match(/\bcode:\s*'([A-Za-z_]+)'/)?.[1];
    if (!code) continue;
    // The message EXPRESSION, not just a literal — many sites build it from
    // `parsed.error.issues.map(...)`, which is itself the strongest signal that
    // the thing being validated was the caller's own body.
    const message = lit.match(/\bmessage:\s*([\s\S]*?)(?:,\n|\n\s*\})/)?.[1] ?? '';
    // A waiver may sit inside the literal, or on one of the few lines directly
    // above the construction (the usual place for a `//` comment). Bounded to
    // WAIVER_LOOKBEHIND_LINES so a waiver cannot silently cover an unrelated
    // construction further down the file.
    const preceding = src.slice(0, m.index!).split('\n').slice(-WAIVER_LOOKBEHIND_LINES).join('\n');
    const waiver =
      lit.match(WAIVER)?.[1]?.trim() ?? [...preceding.matchAll(new RegExp(WAIVER, 'g'))].pop()?.[1]?.trim();
    out.push({
      file: path,
      line: src.slice(0, m.index!).split('\n').length,
      code,
      message: message.replace(/\s+/g, ' ').trim(),
      upstreamStatusValue: lit.match(/\bupstreamStatus:\s*([^,\n]+)/)?.[1]?.trim(),
      waiver,
    });
  }
  return out;
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

function die(msg: string): never {
  console.error(`[check-client-input-not-upstream] FAIL: ${msg}`);
  process.exit(1);
}

/**
 * BOTH RULES, over a list of sites. Exported because it IS the rule -- and
 * because this file has now twice proved that testing a rule's HELPER proves
 * nothing about the rule:
 *
 *   1. `isReadFromResponse` was correct and had a passing test the whole time,
 *      while R2 a few lines away in main() filtered on
 *      `upstreamStatusValue === undefined` and so exempted every hand-written
 *      literal. services/read-models/_lib.ts walked through it with a
 *      fabricated `upstreamStatus: 400`.
 *   2. The fix for (1) extracted `isUnattributed` and tested THAT. An
 *      adversarial audit then measured that reverting main()'s filter back to
 *      `=== undefined` still left every test green -- the identical shape, one
 *      level up. main() had zero coverage both times.
 *
 * So the counting lives HERE, main() does none of its own, and the tests drive
 * this function. A rule that nothing executes is not a rule.
 *
 * R1 (misfiled)      an UPSTREAM_* code whose message is written in the
 *                    vocabulary of inbound validation and whose status was not
 *                    read from a response. Waivable inline, with a reason.
 * R2 (unattributed)  an UPSTREAM_* code whose status was not read from a
 *                    response -- absent, or hand-written. A population that must
 *                    not grow. A hand-written literal is not itself a FINDING
 *                    (404/415/403/201 are legitimate); it just no longer buys
 *                    silence.
 */
export function censusFor(sites: Site[]): {
  upstream: Site[];
  suspect: Site[];
  misfiled: Site[];
  waived: Site[];
  unattributed: Site[];
  /** The subset of `unattributed` that carries a hand-written literal. Display
   *  only -- these are NOT findings (404/415/403/201 are legitimate). Named so
   *  a reader can check each really describes an upstream. */
  handWritten: Site[];
} {
  const upstream = sites.filter((s) => UPSTREAM_CODE.test(s.code));
  const suspect = upstream.filter(
    (s) => CLIENT_INPUT_MESSAGE.test(s.message) && !isReadFromResponse(s.upstreamStatusValue),
  );
  const unattributed = upstream.filter(isUnattributed);
  return {
    upstream,
    suspect,
    misfiled: suspect.filter((s) => !s.waiver),
    waived: suspect.filter((s) => s.waiver),
    unattributed,
    handWritten: unattributed.filter((s) => s.upstreamStatusValue !== undefined),
  };
}

export async function main(argv: string[]): Promise<void> {
  const reportOnly = argv.includes('--report-only');
  const files = await walk('src');
  if (files.length === 0) die('walked zero source files — wrong cwd, or the tree moved');

  const sites: Site[] = [];
  for (const f of files) sites.push(...scanFile(f, await readFile(f, 'utf8')));

  if (sites.length === 0) {
    die(`detected zero IntegrationError constructions across ${files.length} ` +
        'files. This repo has over a hundred; the pattern has rotted.');
  }
  if (sites.length < MIN_SCANNED) {
    die(`scanned ${sites.length} IntegrationError constructions, below the ` +
        `MIN_SCANNED floor of ${MIN_SCANNED}. Either the pattern rotted, or ` +
        'real sites were deleted — lower the floor in the same commit if so.');
  }

  // main() does NO filtering of its own — see censusFor.
  const { upstream, misfiled, waived, unattributed, handWritten } = censusFor(sites);

  console.log(
    `[check-client-input-not-upstream] ${files.length} files, ${sites.length} ` +
    `IntegrationError constructions, ${upstream.length} UPSTREAM_*: ` +
    `${misfiled.length} MISFILED, ${waived.length} waived, ` +
    `${unattributed.length} unattributed (ceiling ${MAX_UNATTRIBUTED})`,
  );
  // Name the hand-written ones. They are NOT findings — 404 in the bridge
  // sources, 415 on an unsupported upload, 403, 201 are all real — but until
  // R2 counted them they were invisible, and invisibility is what let
  // services/read-models/_lib.ts sit for months with an invented
  // `upstreamStatus: 400` on a caller's bad querystring. Counting without
  // naming would only half-fix that, and a rule that FAILED on them would
  // false-positive on all six measured today. So: listed, not judged.
  if (handWritten.length > 0) {
    console.log(
      `  ${handWritten.length} of those carry a HAND-WRITTEN upstreamStatus ` +
      `(counted, not failed — check that each really describes an upstream):`,
    );
    for (const s of handWritten) {
      console.log(`    ${s.file}:${s.line}  ${s.code}  upstreamStatus: ${s.upstreamStatusValue}`);
    }
  }

  for (const w of waived) {
    console.log(`  waived  ${w.file}:${w.line}  ${w.code}\n            reason: ${w.waiver}`);
  }

  let failed = false;

  if (misfiled.length > 0) {
    failed = true;
    console.error('\nMISFILED — an UPSTREAM_* code on a message about the CALLER\'s input:');
    for (const s of misfiled) console.error(`  ${s.file}:${s.line}  ${s.code}  ${s.message.slice(0, 90)}`);
    console.error(
      "\nUse a caller-side code, so the caller gets a 4xx it can act on:\n" +
      "  code: 'BAD_REQUEST'        -> 400\n" +
      "  code: 'PAYLOAD_TOO_LARGE'  -> 413\n" +
      'and drop `service` — no upstream was contacted. If the value really did\n' +
      'come off an upstream RESPONSE, say so inline:\n' +
      '  // client-input-code-ok: <why this value is upstream-sourced>',
    );
  }

  if (unattributed.length > MAX_UNATTRIBUTED) {
    failed = true;
    console.error(
      `\nUNATTRIBUTED — ${unattributed.length} UPSTREAM_* constructions name no ` +
      `\`upstreamStatus\`, above the ceiling of ${MAX_UNATTRIBUTED}:`,
    );
    for (const s of unattributed) console.error(`  ${s.file}:${s.line}  ${s.code}`);
    console.error(
      '\nAn UPSTREAM_* error with no upstream status cannot be told apart from a\n' +
      'caller error — not by a reader, and not by `classifyError`, which calls it\n' +
      'retriable. Set `upstreamStatus` from the response, or use a caller-side\n' +
      'code if no upstream was contacted. Raising the ceiling needs a reason in\n' +
      'the commit message.',
    );
  }

  if (failed && !reportOnly) process.exit(1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
