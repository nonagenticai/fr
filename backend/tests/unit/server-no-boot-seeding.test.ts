// tests/unit/server-no-boot-seeding.test.ts
//
// REGRESSION GUARD (#1246): the fr backend's BOOT PATH must not call ANY seeding
// function — not in `src/server.ts`, and not in any module `server.ts` pulls in.
//
// WHY A GUARD AND NOT JUST A DELETION. Procedures and prompts are ASSETS with a
// current version, continuously improved by dedicated improvement projects;
// execution projects read whatever the current version is AT DISPATCH TIME.
// There is no "base" or "default" body for a boot path to restore. A boot seeder
// that writes a body from a spec hardcoded in this repo is therefore a SECOND
// AUTHOR competing with the improvement loop, and the body it writes is older
// than the current version BY CONSTRUCTION.
//
// The deleted call was `void seedPromptProceduresOnBoot()`. Measured 2026-09-04
// (`src/scripts/lib/procedure-work-floor.ts`): it reverted converged bodies on
// every boot, procedure versions climbing 794 -> 803, re-blocking every card of
// three `prompt_*` card_types on `procedure_body_missing`. Two mitigations were
// already in the tree before the removal — a staleness check and the WORK-STEP
// FLOOR — and BOTH are blind to the architecture problem, which is authorship,
// not step shape.
//
// ⛔ An env gate is NOT an acceptable substitute and must not be proposed as one:
// the production pod carries no `SEED_PROMPT_PROCEDURES_ON_BOOT` key among its 85
// env vars, so a default-on flag leaves the seeder ON in the one place it matters.
//
// It guards the SOURCE rather than a runtime, for the reason
// `src/scripts/seed-it-procedures-coding-ops.test.ts` gives for the same choice:
// importing `src/server.ts` would START a server (it binds a port and runs the
// boot sequence at module scope), so the only cheap, deterministic observation is
// the text of the boot path itself.
//
// ⚠️ IT SCANS CODE, NOT COMMENTS, AND THAT IS LOAD-BEARING. `server.ts` now
// carries a tombstone that NAMES the deleted function, so a naive grep over the
// raw file would fire on the warning that exists to prevent the regression — a
// guard reddened by its own documentation gets deleted, not obeyed. Comments are
// stripped first, and two floors below prove the stripper neither guts the file
// nor leaves comments behind.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ SCOPE — CORRECTED 2026-09-27, AND THE CORRECTION IS THE POINT OF THIS FILE.
//
// The first version of this guard read `server.ts` AND NOTHING ELSE. An adversary
// defeated it twice with the deleted seeder fully running, and only ONE of the two
// bypasses was a rename:
//
//   (a) A DIFFERENT NAME FAMILY. `void ensurePromptProcedureBodies()` imported
//       from `./scripts/procedure-convergence` in `server.ts` — 4 pass / 0 fail.
//       `ensure|upsert|bootstrap|install|provision|hydrate|restore` all missed the
//       name regex, and the import check only fired on a module path containing
//       `seed`. Fixed by SEEDING below: a seeding VERB followed by an ASSET NOUN,
//       anchored at the identifier's start.
//
//   (b) NO RENAME AT ALL. Two lines prepended to `src/channels/web.ts`, which
//       `server.ts` statically imports:
//         import { runSeedPrompt } from '../scripts/seed-prompt-procedures';
//         void runSeedPrompt({ refreshStale: true });
//       — 4 pass / 0 fail, and the deleted seeder ran on every boot. The name was
//       already in the regex; the guard simply never looked at that file.
//
// (b) is the structural defect and it is what this rewrite fixes: the scan now
// walks the TRANSITIVE STATIC IMPORT CLOSURE of `server.ts` instead of one file.
// Anything that executes because `server.ts` was loaded is in scope, however many
// hops away.
//
// ⚠️ THE CLOSURE SIZE IN THIS HEADER WAS WRONG TWICE, AND THE SECOND TIME IT WAS
// HIDING A HOLE — corrected 2026-09-27. It claimed "330 modules"; the code then
// produced 323, because the specifier regex could not cross a line break (see
// STATIC_SPEC). It now produces 1820: 510 under `src/` plus 1310 reached through
// the `tsconfig.json` path aliases, which are first-party repo code (limit 4).
// Reproduce, do not quote — FLOOR 3 asserts the set, not the number:
//   bun test tests/unit/server-no-boot-seeding.test.ts
//
// ⛔ THE TWO HALVES USE DIFFERENT PREDICATES, DELIBERATELY:
//   * `server.ts` — ANY call at any nesting depth. It IS the boot sequence; a
//     seeding call inside a `try {}` there is a boot-time seed.
//   * every other module in the closure — only a call in SIDE-EFFECT POSITION
//     (module top level: brace depth 0, or a statement starting at column 0).
//     A seeding call inside an exported function body is a CLI or a route doing
//     it on request, which is legitimate and is exactly what
//     `src/scripts/seed-prompt-procedures.ts` remains for. Flagging that would
//     make this guard's claim false in the other direction.
//
// ⚠️ WHAT IS STILL NOT COVERED — read this before trusting the guard:
//   1. A seeding call reached at boot through a FUNCTION the boot path invokes
//      (`server.ts` calls `startWorkers()`, which calls a seeder inside its
//      body). Depth-0 position cannot see that; it needs a call graph.
//   2. A name that matches no verb+noun pair (`applyMigrations`-shaped:
//      `hydrateEverything`, `converge()`). The regex is a heuristic over naming
//      and always will be — see its own header.
//   3. `import type`-only edges are NOT walked (they are erased at runtime, so a
//      module reached only that way never executes). If a real runtime import is
//      ever written as `import type`, that module leaves the closure.
//   4. Third-party `node_modules` packages. ⚠️ THIS USED TO READ "modules outside
//      `src/` (workspace packages, node_modules)", WHICH UNDERSTATED IT AND HAS
//      BEEN FIXED RATHER THAN REWORDED (2026-09-27): the 9 non-wildcard `paths`
//      aliases in `backend/tsconfig.json` (`@fr/service-client-procedures` and 8
//      siblings) are FIRST-PARTY code under `packages/service-clients/`, sitting in
//      `server.ts`'s runtime graph, and they were entirely unscanned. They are now
//      resolved and walked: 8 of the 9 are reachable from `server.ts`
//      (`@fr/service-client-coding` is not) and they contribute 1310 of the 1820
//      closure modules, for ~0.4s. Wildcard aliases (none exist today) and real
//      `node_modules` packages remain out of scope.
//   5. The `server.ts` half reports a seeding call at ANY nesting depth, so a
//      REQUEST-SCOPED seeding call written inside a handler that lives in
//      `server.ts` would red CI with nothing actually wrong. (933 calls are
//      visible in `server.ts`; 0 match SEEDING today.) Narrowing it needs a
//      scope/call-graph distinction between the boot sequence and a handler body,
//      which is not cheap and which would cost the boot-sequence guarantee the
//      `server.ts` half exists to give — so it over-reports DELIBERATELY, in the
//      direction a guard should err. The fix for such a red is to move the handler
//      into `src/routes/`, where route handlers belong anyway.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const BACKEND_DIR = new URL('../../', import.meta.url).pathname;
const SRC_DIR = join(BACKEND_DIR, 'src/');
const SERVER_PATH = join(SRC_DIR, 'server.ts');
const RAW = readFileSync(SERVER_PATH, 'utf8');

/**
 * Remove `//` and block comments, leaving string/template literals intact.
 *
 * Quote-aware on purpose: `'https://…'` contains `//`, and a stripper that cut
 * there would silently drop the REST of that line from the scan — shrinking what
 * the guard can see, which is the one failure mode a guard must not have.
 * Newlines are preserved so line numbers in a failure message stay usable.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (quote !== null) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Blank out the CONTENTS of every string and template literal, keeping the
 * quotes, every newline and the byte count.
 *
 * Needed only for the brace-depth arithmetic that decides "module top level":
 * `` `${a}` `` and `'}'` both carry braces that are not block braces, and either
 * would push the depth counter off by one for the rest of the file. Length and
 * line breaks are preserved so a reported line number still points at the code.
 */
function maskLiterals(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i] as string;
    if (quote !== null) {
      if (c === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        out += c;
        i += 1;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── The import closure ──────────────────────────────────────────────────────

/**
 * Every module specifier that makes the importing module EXECUTE the target:
 * `import x from './y'`, `import { a } from './y'`, `import './y'`,
 * `export { a } from './y'`, `export * from './y'`, and `import('./y')`.
 *
 * `import type` / `export type` are excluded by the `(?!type\b)`: they are erased
 * by the compiler, so a module reached only that way never runs and cannot seed.
 * Listed as limit 3 in the header.
 *
 * ⛔ THE CLAUSE CLASS MUST TOLERATE NEWLINES, AND IT DID NOT — FIXED 2026-09-27.
 * It read `[^'"`\n;]*?`, which cannot cross a line break, and this repo is
 * prettier-formatted: `server.ts` alone has 79 `import {` lines that put the
 * specifier on a LATER line, and 234 files under `src/` use that form. MEASURED
 * with this file's own `stripComments`/`resolveSpec`, changing only that class:
 * the closure was 323 modules instead of 510 (`src/` only), and 78 of
 * `server.ts`'s 198 direct relative edges were NEVER ATTEMPTED — including
 * `routes/projects`, `routes/webhooks`, `routes/approvals` and
 * `routes/assets/procedures`. Because the edge was never attempted, `unresolved`
 * stayed EMPTY: the hole was SILENT, and a two-line bypass of exactly shape (b)
 * planted in `routes/assets/procedures.ts` passed 8 pass / 0 fail.
 *
 * ⛔ AND THE OBVIOUS WIDENING, `[\s\S]*?`, IS WRONG — measured, not assumed. It is
 * lazy, but it can still cross a STATEMENT boundary, and the `from` branch of the
 * optional group is tried first: for a BARE `import './x';` that branch runs
 * forward to the NEXT `from '…'` anywhere in the file and swallows every bare
 * import in between. Closure 503, LOSING the 9 `agui/actions/*` side-effect
 * imports `server.ts` registers and gaining 2 modules reachable only by
 * `import type`. Excluding `;` and the quote characters bounds the scan to ONE
 * statement while allowing line breaks: 510. FLOOR 3b pins both directions.
 */
const STATIC_SPEC = /(?:^|[\n;])\s*(?:import|export)\s+(?!type\b)(?:[^'"`;]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_SPEC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

type BootModule = { rel: string; code: string; masked: string };

/**
 * The non-wildcard `paths` entries from `backend/tsconfig.json`, alias -> absolute
 * target file. Bun honours these at RUNTIME, so `@fr/service-client-procedures` is
 * an ordinary boot-path edge into `packages/service-clients/procedures/src/`.
 *
 * They are walked because that is FIRST-PARTY REPO CODE, not a third-party
 * package: leaving them out made limit 4 read as "workspace packages" when what it
 * actually excluded was 9 alias roots of code this repo writes and regenerates.
 * Comments are stripped before `JSON.parse` because the file is JSONC.
 */
const TSCONFIG_ALIASES: Map<string, string> = (() => {
  const raw = stripComments(readFileSync(join(BACKEND_DIR, 'tsconfig.json'), 'utf8'));
  const paths = (JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions?.paths ?? {};
  const out = new Map<string, string>();
  for (const [alias, targets] of Object.entries(paths)) {
    const target = targets[0];
    // A wildcard alias would need per-specifier substitution; none exist today and
    // one appearing should widen this, not be silently skipped — FLOOR 3c pins it.
    if (alias.includes('*') || target === undefined) continue;
    out.set(alias, resolve(BACKEND_DIR, target));
  }
  return out;
})();

/** A specifier this guard can follow: a relative path, or a tsconfig path alias. */
function isScannable(spec: string): boolean {
  return spec.startsWith('.') || TSCONFIG_ALIASES.has(spec);
}

/** Resolve a specifier the way Bun does, or `null` if nothing is there. */
function resolveSpec(fromFile: string, spec: string): string | null {
  const base = spec.startsWith('.') ? resolve(dirname(fromFile), spec) : TSCONFIG_ALIASES.get(spec);
  if (base === undefined) return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const closure = new Map<string, BootModule>();
/** Relative specifiers that resolved to no file. Asserted EMPTY — see the floor. */
const unresolved: string[] = [];

function walk(file: string): void {
  if (closure.has(file)) return;
  const code = stripComments(readFileSync(file, 'utf8'));
  closure.set(file, { rel: relative(SRC_DIR, file), code, masked: maskLiterals(code) });
  const specs: string[] = [];
  for (const re of [STATIC_SPEC, DYNAMIC_SPEC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) if (m[1] !== undefined) specs.push(m[1]);
  }
  for (const spec of specs) {
    // A specifier that is neither relative nor a tsconfig alias is a third-party
    // `node_modules` package — out of scope (limit 4).
    if (!isScannable(spec)) continue;
    const target = resolveSpec(file, spec);
    if (target === null) unresolved.push(`${relative(SRC_DIR, file)} -> '${spec}'`);
    else walk(target);
  }
}

walk(SERVER_PATH);

// ── The independent coverage oracle ─────────────────────────────────────────

/**
 * A SECOND edge extractor, written on a DIFFERENT mechanism, used only as FLOOR
 * 3's oracle. `STATIC_SPEC` scans for a statement head and then reaches forward
 * for the specifier through a character class — which is precisely where the
 * newline hole lived. This one instead SPLITS the masked source into `;`-delimited
 * statements and takes the first quoted string out of each import/export
 * statement, so it is newline-immune BY CONSTRUCTION rather than by a character
 * class. Positions in `masked` and `code` coincide (`maskLiterals` preserves
 * length), so the real specifier is read out of `code` at the masked offsets.
 *
 * ⛔ It must stay independent: do not refactor the two to share a regex. Their
 * disagreement IS the floor.
 */
const SEGMENT_SPEC = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\bfrom\s*)?(['"])/;

function oracleEdges(mod: BootModule): string[] {
  const out: string[] = [];
  let start = 0;
  while (start <= mod.masked.length) {
    let end = mod.masked.indexOf(';', start);
    if (end === -1) end = mod.masked.length;
    const seg = mod.masked.slice(start, end);
    const take = (openRel: number, quote: string): void => {
      const open = start + openRel;
      const close = mod.masked.indexOf(quote, open + 1);
      if (close > open && close < end) out.push(mod.code.slice(open + 1, close));
    };
    const stmt = SEGMENT_SPEC.exec(seg);
    if (stmt !== null) take(stmt[0].length - 1, stmt[1] as string);
    // `import('./x')` is not statement-initial, so it needs its own pass.
    for (const dyn of seg.matchAll(/\bimport\s*\(\s*(['"])/g)) {
      take((dyn.index ?? 0) + dyn[0].length - 1, dyn[1] as string);
    }
    start = end + 1;
  }
  return out;
}

/** Modules reachable from `server.ts` using ONLY the oracle's edges. */
const oracleClosure = new Set<string>();
let oracleEdgeCount = 0;

function oracleWalk(file: string): void {
  if (oracleClosure.has(file)) return;
  oracleClosure.add(file);
  const code = stripComments(readFileSync(file, 'utf8'));
  const mod: BootModule = { rel: relative(SRC_DIR, file), code, masked: maskLiterals(code) };
  for (const spec of oracleEdges(mod)) {
    if (!isScannable(spec)) continue;
    oracleEdgeCount += 1;
    const target = resolveSpec(file, spec);
    if (target !== null) oracleWalk(target);
  }
}

oracleWalk(SERVER_PATH);

const SERVER = closure.get(SERVER_PATH) as BootModule;
const CODE = SERVER.code;

/** Identifiers that are followed by `(` but are not a call to a named function. */
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function',
  'class', 'do', 'else', 'yield', 'void', 'in', 'of', 'as', 'import', 'delete', 'case',
]);

type Call = { name: string; line: number; topLevel: boolean };

/**
 * Every `<identifier>(` in a module's masked source, with its 1-based line and
 * whether it sits in SIDE-EFFECT POSITION.
 *
 * A `function foo(` / `class Foo(` DECLARATION is not a call and is excluded —
 * without that, `export async function handlePublishAsset(` at column 0 read as a
 * top-level seeding call and the guard reported 3 phantom offenders (measured).
 *
 * `topLevel` is the UNION of two tests because neither alone is sound:
 *   * brace depth 0 — precise, but a regex literal containing an unmatched `{`
 *     (e.g. `/[{]/`) permanently inflates the counter. 11 of the 1820 closure
 *     modules end on a non-zero depth, measured (all 11 under `src/`:
 *     `lib/keycloak-lookup-metrics.ts`, `integrations/coding/head-sha.ts`,
 *     `services/constraint-check.ts`, `services/artifact-review-callback.ts`,
 *     `routes/tools/_metrics.ts`, `routes/metrics.ts`, `routes/tools/analytics.ts`,
 *     `connectors/s3.ts`, `workers/scheduled-trigger-health.ts`,
 *     `routes/approvals.ts`, `services/mentions/parser.ts`), so depth alone can
 *     MISS. Obtained by summing `{`/`}` over each module's `masked` source.
 *   * the statement starts at column 0 — this repo is prettier-formatted with
 *     2-space indent, so module-level statements begin at column 0 and nested
 *     ones never do. Formatting-dependent, hence not used alone either.
 * A union can over-report, never under-report relative to each half, and
 * over-reporting a SEEDING-shaped name is the direction a guard should err in.
 */
function callsIn(mod: BootModule): Call[] {
  const code = mod.masked;
  const out: Call[] = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(|[{}]/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[0] === '{') {
      depth += 1;
      continue;
    }
    if (m[0] === '}') {
      depth -= 1;
      continue;
    }
    const name = m[1];
    if (name === undefined || NOT_A_CALL.has(name)) continue;
    const before = code.slice(Math.max(0, m.index - 30), m.index);
    if (/\b(?:function|class)\s*\*?\s*$/.test(before)) continue;
    const lineStart = code.lastIndexOf('\n', m.index) + 1;
    const atColumnZero = /^[\w$.[\]]*$/.test(code.slice(lineStart, m.index)) && code[lineStart] !== ' ' && code[lineStart] !== '\t';
    out.push({
      name,
      line: code.slice(0, m.index).split('\n').length,
      topLevel: depth === 0 || atColumnZero,
    });
  }
  return out;
}

/** Every `<identifier>(` in `server.ts`, with its 1-based line number. */
function calls(): Call[] {
  return callsIn(SERVER);
}

/**
 * A call is "seeding" when its identifier reads as one. Deliberately a SHAPE and
 * not a list of the three names that exist today: the defect is the category —
 * fr writing an asset body it does not author — so the next one will have a new
 * name, and a name allowlist would pass it.
 *
 * ⚠️ WIDENED 2026-09-27 because the first shape was too narrow to back that
 * claim: `void ensurePromptProcedureBodies()` in the boot sequence passed it.
 * The shape is now a SEEDING VERB at the start of the identifier followed by an
 * ASSET NOUN anywhere after it, plus the two bare forms the original caught.
 *
 * The verb is ANCHORED on purpose. Unanchored, `gateWriteAsset` (the admin
 * asset-route AUTH GATE) matches on `…WriteAsset` — a false positive on a
 * function whose job is to REFUSE writes. Measured over the full 1820-module
 * closure, the anchored shape has ZERO matches in side-effect position — and, for
 * the same instrument's non-zero control, exactly one match at depth
 * (`seedScanOffset:2775`, a pure arithmetic helper in
 * `workers/deblock-callback-redelivery.ts` that computes a scan OFFSET and
 * writes nothing) — which is why the closure half of this guard is scoped to
 * side-effect position and not to every call. Both counts are unchanged by the
 * closure growing 323 -> 1820, i.e. widening the walk reds nothing that exists.
 *
 * It remains a HEURISTIC OVER NAMING and cannot be otherwise: a seeder called
 * `converge()` or `hydrateEverything()` matches nothing here. Limit 2 in the
 * header.
 */
const SEEDING_VERB = 'seed|reseed|converge|ensure|upsert|bootstrap|install|provision|hydrate|restore|sync|apply|write|publish|materiali[sz]e|backfill|repair|refresh';
const ASSET_NOUN = 'procedure|prompt|asset|step|bodies|body|card_?type';
const SEEDING = new RegExp(
  `^(?:${SEEDING_VERB})[\\w$]*(?:${ASSET_NOUN})|^(?:seed|reseed|runSeed)|SeedOnBoot`,
  'i',
);

describe('boot path — no asset seeding', () => {
  // ── FLOOR 1 (positive control). If the stripper or the extractor breaks, CODE
  // goes empty or `calls()` returns [] and every assertion below passes while
  // checking nothing — the same silent-no-op shape as the defect being pinned.
  // `applyMigrations` is a REAL call in the boot sequence, on the line the
  // deleted seeder used to follow, so finding it proves the instrument works.
  test('extractor finds the real boot calls (floor, so a broken scan cannot pass)', () => {
    const names = calls().map((c) => c.name);
    // The named real call is the floor; no count of boot calls is pinned.
    expect(names).toContain('applyMigrations');
  });

  // ── FLOOR 2 (negative control on the stripper). The tombstone in server.ts
  // names the deleted function in prose. If comments were NOT being stripped,
  // this string would still be present and the real assertion below would be
  // firing on documentation rather than on code.
  test('comments are stripped, so the tombstone cannot red this guard', () => {
    expect(RAW).toContain('NOTHING SEEDS AN ASSET AT BOOT');
    expect(CODE).not.toContain('NOTHING SEEDS AN ASSET AT BOOT');
  });

  // ── FLOOR 3 (EXACT COVERAGE of the closure — what bypass (b) exploited, and
  // what a newline-intolerant specifier class silently un-fixed).
  //
  // ⛔ THIS WAS `expect(closure.size).toBeGreaterThan(200)`, AND THAT FLOOR COULD
  // NOT FAIL. The walker's clause class excluded `\n`, so 78 of `server.ts`'s 198
  // direct relative edges were never attempted and the closure was 323 modules
  // rather than the full walk — and 323 clears a `> 200` bar. A lower bound cannot
  // tell a complete walk from a two-thirds walk, which is the same gate-that-
  // cannot-fail shape this file exists to pin, one level up.
  //
  // So the floor is an EXACT SET EQUALITY against `oracleClosure`, built by an
  // independent extractor (see `SEGMENT_SPEC`). Any edge the walker stops
  // attempting appears here as a module the oracle reached and the walker did not.
  // MEASURED: restoring the old `[^'"`\n;]*?` class leaves 1497 modules missing
  // and reds this test; the `toContain`s below red as well, so the floor is not
  // resting on the equality alone.
  test('the import closure is EXACTLY what is reachable from server.ts (floor)', () => {
    const rel = (f: string): string => relative(SRC_DIR, f);
    const oracleOnly = [...oracleClosure].filter((f) => !closure.has(f)).map(rel).sort();
    const walkerOnly = [...closure.keys()].filter((f) => !oracleClosure.has(f)).map(rel).sort();
    expect(
      oracleOnly.length,
      oracleOnly.length
        ? `\n  ${oracleOnly.slice(0, 20).join('\n  ')}${oracleOnly.length > 20 ? `\n  … +${oracleOnly.length - 20} more` : ''}` +
            `\n  These modules RUN at boot and the guard does not scan them. Fix STATIC_SPEC ` +
            `or resolveSpec; do not delete this assertion and do not allowlist a module.`
        : '',
    ).toBe(0);
    expect(
      walkerOnly.length,
      walkerOnly.length
        ? `\n  ${walkerOnly.slice(0, 20).join('\n  ')}\n  The walker reached modules the oracle cannot see: ` +
            `one of the two extractors is wrong. Neither may be trusted until they agree.`
        : '',
    ).toBe(0);
    // Non-vacuity: both extractors returning nothing would satisfy the equality
    // with a 1-element closure, so name modules that only a real walk reaches.
    const rels = [...closure.values()].map((m) => m.rel);
    expect(rels).toContain('channels/web.ts');              // bypass (b)'s file, 1 hop
    expect(rels).toContain('integrations/requirements.ts');  // 3 hops (routes -> ...)
    // Invisible to the old newline-intolerant class: `server.ts` imports these
    // with the multi-line form.
    expect(rels).toContain('routes/documents.ts');
    expect(rels).toContain('routes/webhooks.ts');
    expect(rels).toContain('routes/approvals.ts');
    // A tsconfig path alias is a first-party edge, not a package boundary (limit 4).
    expect(rels).toContain('../../packages/service-clients/requirements/src/index.ts');
    expect(oracleEdgeCount).toBeGreaterThan(closure.size);
    // ⛔ An unresolvable relative specifier is a HOLE, not a curiosity: that
    // subtree is silently unscanned. Fail loudly and teach `resolveSpec` the
    // new extension rather than deleting this.
    expect(unresolved, unresolved.join('; ')).toEqual([]);
  });

  // ── FLOOR 3b (the specifier regex itself, both directions). The newline hole
  // was invisible from outside: the edge was never ATTEMPTED, so `unresolved`
  // stayed empty and nothing reddened. These cases make the class itself the
  // subject, including the runaway that the obvious `[\s\S]*?` widening causes.
  test('STATIC_SPEC sees multi-line imports, skips import type, and cannot run away', () => {
    const specs = (src: string): string[] => {
      STATIC_SPEC.lastIndex = 0;
      const out: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = STATIC_SPEC.exec(src)) !== null) if (m[1] !== undefined) out.push(m[1]);
      return out;
    };
    // The prettier multi-line form — 234 files under `src/` use it, and the old
    // class could not cross the line break.
    expect(specs("import {\n  a,\n  b,\n} from './x';\n")).toEqual(['./x']);
    expect(specs("export {\n  a,\n} from './x';\n")).toEqual(['./x']);
    // Erased at runtime, so still excluded (limit 3) — on one line and on several.
    expect(specs("import type { T } from './y';\n")).toEqual([]);
    expect(specs("import type {\n  T,\n} from './y';\n")).toEqual([]);
    // The forms that already worked must keep working.
    expect(specs("import { a } from './x';\n")).toEqual(['./x']);
    expect(specs("import './bare';\n")).toEqual(['./bare']);
    // ⛔ The runaway `[\s\S]*?` produces: a bare side-effect import's optional
    // `from` branch reaches the NEXT statement's `from '…'` and swallows the bare
    // specifier. Both orders, because only one of them exposes it.
    expect(specs("import './a';\nimport { z } from './b';\n")).toEqual(['./a', './b']);
    expect(specs("import {\n  a,\n} from './a';\nimport './b';\nimport { c } from './c';\n")).toEqual([
      './a',
      './b',
      './c',
    ]);
  });

  // ── FLOOR 3c (the alias table is populated and points at real first-party
  // files). An empty map would silently restore limit 4's old, wider blindness:
  // `isScannable` would reject every `@fr/*` specifier and the closure would
  // shrink back to `src/` only, with nothing reddening.
  test('tsconfig path aliases are resolved (floor: an empty map is invisible)', () => {
    // Cross-checked against the raw file by COUNTING KEYS rather than by restating
    // today's 9, so adding a 10th alias does not need this test edited — while the
    // filter dropping one, or a WILDCARD alias being skipped, still reds.
    const rawPaths = readFileSync(join(BACKEND_DIR, 'tsconfig.json'), 'utf8');
    const block = rawPaths.slice(rawPaths.indexOf('"paths"'));
    const keyCount = (block.slice(0, block.indexOf('}')).match(/"[^"]+"\s*:/g) ?? []).length - 1;
    expect(TSCONFIG_ALIASES.size).toBe(keyCount);
    const target = TSCONFIG_ALIASES.get('@fr/service-client-requirements');
    expect(target).toBeDefined();
    expect(existsSync(target as string)).toBe(true);
    expect(isScannable('@fr/service-client-requirements')).toBe(true);
    // A real third-party package must still be out of scope (limit 4).
    expect(isScannable('drizzle-orm')).toBe(false);
    expect(resolveSpec(SERVER_PATH, '@fr/service-client-requirements')).toBe(target as string);
  });

  // ── FLOOR 4 (the side-effect-position detector must DISCRIMINATE, both ways).
  // One file, one instrument, two opposite expectations. If `topLevel` were
  // stuck true, the closure assertion would report every nested call and this
  // file would red on the negative half; if stuck false, it would report nothing
  // and the positive half fails. `integrations/workers.ts` is used because it
  // is in the closure and holds both shapes:
  //   top level : `const GraphExecutionSessionSchema = z.object({...})`
  //   nested    : `return listWorkersParamsSchema.parse(raw)` inside a fn
  test('side-effect position discriminates (floor, both directions)', () => {
    const mod = [...closure.values()].find((m) => m.rel === 'integrations/workers.ts') as BootModule;
    const found = callsIn(mod);
    expect(found.filter((c) => c.name === 'object' && c.topLevel).length).toBeGreaterThan(0);
    expect(found.filter((c) => c.name === 'parse').length).toBeGreaterThan(0);
    expect(found.filter((c) => c.name === 'parse' && c.topLevel)).toEqual([]);
  });

  test('server.ts calls no seeding function at boot', () => {
    const offenders = calls().filter((c) => SEEDING.test(c.name));
    const detail = offenders.map((o) => `server.ts:${o.line} ${o.name}(`).join('\n  ');
    expect(
      offenders.length,
      offenders.length
        ? `\n  ${detail}\n  A procedure/prompt is an asset owned by the improvement loop; a boot ` +
            `path that writes its body is a second author asserting a stale snapshot. ` +
            `Remove the call — an env gate is not a fix (prod has no such env key).`
        : '',
    ).toBe(0);
  });

  // ── The fix for bypass (b). `server.ts` is not the boot path; everything it
  // imports is. A seeding call in SIDE-EFFECT POSITION in any of those modules
  // runs on every boot just as surely as one written here.
  test('no module in the boot import closure seeds an asset at module top level', () => {
    const offenders: string[] = [];
    for (const mod of closure.values()) {
      for (const c of callsIn(mod)) {
        if (c.topLevel && SEEDING.test(c.name)) offenders.push(`${mod.rel}:${c.line} ${c.name}(`);
      }
    }
    expect(
      offenders.length,
      offenders.length
        ? `\n  ${offenders.join('\n  ')}\n  These run at boot because server.ts imports the module. ` +
            `Move the call behind an explicit CLI entrypoint or a request-scoped handler; ` +
            `a module that seeds an asset merely by being imported is the #1246 defect ` +
            `one hop further out.`
        : '',
    ).toBe(0);
  });

  // ── Bare side-effect imports carry no call to find, so the specifier itself is
  // the evidence. Applied across the closure, not just to server.ts: bypass (b)'s
  // `import { runSeedPrompt } from '../scripts/seed-prompt-procedures'` sat in
  // `channels/web.ts`, and this check would have caught it there even if the call
  // had been renamed out of SEEDING's reach.
  test('no module in the boot closure imports a seeding module', () => {
    const bad: string[] = [];
    for (const mod of closure.values()) {
      for (const re of [STATIC_SPEC, DYNAMIC_SPEC]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(mod.code)) !== null) {
          const spec = m[1] ?? '';
          if (/(?:^|[/-])(?:seed|reseed)[\w.-]*$/i.test(spec) || /seed-/i.test(spec)) {
            bad.push(`${mod.rel} imports '${spec}'`);
          }
        }
      }
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  // ── FLOOR 5 (negative control on `maskLiterals`). It blanks literal CONTENTS;
  // if it blanked more than that, the depth arithmetic and every scan above would
  // be reading a gutted file. Same shape as FLOOR 2, for the second transform.
  test('maskLiterals keeps the code and only empties literals (floor)', () => {
    expect(SERVER.masked.length).toBe(CODE.length);
    expect(SERVER.masked.split('\n').length).toBe(CODE.split('\n').length);
    expect(SERVER.masked).toContain('applyMigrations(');
    // A literal that exists in the stripped code must be hollow in the masked one.
    // Asserted as booleans so a failure prints the verdict, not all 3.7k lines.
    expect(CODE.includes("'./config'")).toBe(true);
    expect(SERVER.masked.includes("'./config'")).toBe(false);
    // The quotes survive and the contents become spaces of the same width, which
    // is what keeps every reported line number pointing at the right line.
    expect(SERVER.masked.includes(`'${' '.repeat("./config".length)}'`)).toBe(true);
  });
});
