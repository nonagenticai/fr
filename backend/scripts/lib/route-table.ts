// backend/scripts/lib/route-table.ts
//
// The ONE `router.add` parser in the repo, plus the handler-tree walk, shared
// by check-route-spec-coverage.ts, check-served-spec.ts and
// route-overlap-pairs.ts. Extracted unchanged from a retired guard.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Backend root, derived from THIS FILE — never `process.cwd()`, so invoking
 * from the wrong cwd cannot make a walk find zero files and print a false OK. */
export const BACKEND_DIR = join(import.meta.dir, '..', '..');

/** The single central route table. Every `router.add(...)` in the app is
 * declared here, directly or via a `register*Routes(router)` call that itself
 * calls `router.add` in another file — `findDelegatedRouteFiles` follows
 * those one level deep. */
export const ROUTE_TABLE_FILE = 'src/server.ts';

/** Where handler functions live. */
export const HANDLER_ROOT = 'src/routes';

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

export interface RouteEntry {
  path: string;
  handler: string;
}

/** A route table row with its METHOD retained; each caller narrows. */
export interface MethodRouteEntry extends RouteEntry {
  /** Upper-cased method (`GET`, `POST`, …) when `methodIsLiteral`; otherwise
   * the upper-cased IDENTIFIER TEXT, which is not a method at all. */
  method: string;
  /**
   * The first argument with quotes stripped and its CASING PRESERVED (`method`
   * is upper-cased, which erases the one thing a consumer needs to notice that
   * a route was registered as `'get'`). `src/utils/router.ts:26` compares
   * `route.method !== method` CASE-SENSITIVELY against Bun's upper-case
   * `req.method`, so a lower-case method literal is a route that can never
   * match — see `nonUppercaseMethodError` in check-route-spec-coverage.ts.
   */
  rawMethod: string;
  /**
   * False when the first argument was not a quoted string literal — i.e. a
   * variable. MEASURED: `src/server.ts:1792` registers the kag `/reviews`
   * byte-passthrough inside `for (const method of ['GET','POST',…])`, so the
   * first argument is the identifier `method` and reads as the pseudo-method
   * `METHOD`. A consumer MUST branch on this rather than believe `method`:
   * silently dropping the row loses a real route, and silently trusting it
   * invents one that does not exist.
   */
  methodIsLiteral: boolean;
}

/** `'/api/x'` / `"/api/x"` / backtick -> true. A bare identifier -> false. */
export function isQuotedLiteral(s: string): boolean {
  return (
    s.length >= 2 &&
    ((s[0] === "'" && s[s.length - 1] === "'") ||
      (s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === '`' && s[s.length - 1] === '`'))
  );
}

/**
 * Parse every `router.add('<METHOD>', '<path>', <handler>)` call out of a route
 * table source text (`src/server.ts`, or a delegated `register*Routes` file).
 * Handles both the single-line and the multi-line (prettier-wrapped) call
 * forms, e.g.:
 *
 *   router.add('GET', '/api/reports', handleListReports);
 *   router.add(
 *     'GET',
 *     '/api/assets/streams/:id/notification-channels',
 *     handleListStreamNotificationChannels,
 *   );
 *
 * Only bare-identifier handlers are resolved (`handleFoo`); an inline arrow
 * function or a wrapped call (`withAuth(handleFoo)`) is recorded with
 * `handler` set to that raw text and will fail to resolve to a body later,
 * landing in the `unresolved` bucket rather than crashing the guard.
 *
 * ⚠️ THIS IS THE ONE `router.add` PARSER IN THE REPO. It is exported, and
 * method-agnostic, precisely so a second guard does not grow a second
 * regex that drifts from this one — two parsers disagreeing about what the
 * route table says is a worse failure than either guard missing a route,
 * because both would still print OK. `check-route-spec-coverage.ts` imports
 * it.
 */
export function parseRouteTable(serverSource: string): MethodRouteEntry[] {
  const routes: MethodRouteEntry[] = [];
  const re = routerAddCallRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(serverSource)) !== null) {
    const argsStart = m.index + m[0].length;
    const args = splitTopLevelArgs(serverSource, argsStart);
    if (args === null || args.parts.length < 3) continue;
    const rawMethod = args.parts[0]!.trim();
    const method = stripQuotes(rawMethod);
    if (!/^[A-Za-z]+$/.test(method)) continue; // neither a literal nor an identifier — cannot report either way
    const path = stripQuotes(args.parts[1]!.trim());
    const handler = args.parts[2]!.trim();
    if (!path.startsWith('/')) continue; // not a real path literal — skip rather than misreport
    routes.push({
      method: method.toUpperCase(),
      rawMethod: method,
      path,
      handler,
      methodIsLiteral: isQuotedLiteral(rawMethod),
    });
  }
  return routes;
}

/**
 * The regex the PARSER scans with: a `router.add(` call site spelled exactly
 * that way. A fresh object each call because it is `/g` and therefore carries
 * `lastIndex`.
 *
 * ⛔ THIS IS THE NUMERATOR'S PATTERN, NOT THE DENOMINATOR'S, AND THAT
 * ASYMMETRY IS THE POINT. Until 2026-09-27 `countRouterAddCalls` counted with
 * this same regex, on the reasoning that two different regexes would measure the
 * regexes rather than the drops. That reasoning was refuted by measurement: a
 * numerator and a denominator computed from ONE pattern can only ever see a drop
 * that happens AFTER the match — it is structurally blind to a registration the
 * pattern itself never matches. MEASURED on the real `src/server.ts`, each
 * appended then restored:
 *
 *     router.add('POST', '/api/probe', h)          -> EXIT 1, route named
 *     const alias = router; alias.add('POST', …)   -> EXIT 0, census unchanged
 *     router\n  .add('POST', …)                    -> EXIT 0, census unchanged
 *     router['add']('POST', …)                     -> EXIT 0, census unchanged
 *     router?.add('POST', …)                       -> EXIT 0, census unchanged
 *
 * All of those are LIVE routes (`router.match()` resolves every one). So the
 * denominator now uses {@link addCallSiteRegex}, which is RECEIVER-AGNOSTIC and
 * a strict SUPERSET of this pattern, and the comparison in
 * `routeAccountingError` (check-route-spec-coverage.ts) turns each of those
 * spellings into `callSites > parsedRows` — exit 2.
 *
 * ⛔ Do NOT widen this one to match. The parser staying narrow is what makes
 * the mismatch visible; widening it would make the parser guess at which
 * `.add(` is a route registration, and the two numbers would agree again.
 */
export function routerAddCallRegex(): RegExp {
  return /router\.add\s*\(/g;
}

/**
 * THE DENOMINATOR'S PATTERN — receiver-agnostic. Any `.add(` (however spaced,
 * however the receiver is spelled, optional-chained or not) plus the computed
 * form `['add'](`.
 *
 * ⭐ It is a strict SUPERSET of {@link routerAddCallRegex}: every `router.add(`
 * match contains a `.add(` match at the same place, so widening the denominator
 * can never LOWER it below the narrow count, only raise it. That is what makes
 * `callSites >= parsedRows` still hold and makes every new spelling a red rather
 * than an arithmetic accident.
 *
 * ⚠️ The cost, stated plainly: this counts every `.add(` in a route file,
 * including `someSet.add(x)` and prose in a comment. That is DELIBERATE and
 * fail-closed — the denominator must not judge whether a call looks like a route
 * registration, because judging is exactly how `router.add('POST', P, h)` (a
 * variable path) escaped for months. Occurrences that genuinely are not
 * registrations are named one at a time in `NON_REGISTRATION_ADD_CALLS`
 * (check-route-spec-coverage.ts), which rots if the text it names disappears.
 */
export function addCallSiteRegex(): RegExp {
  return /(\.\s*add\s*\(|\[\s*['"]add['"]\s*\]\s*\()/g;
}

/**
 * How many `.add(` CALL SITES a route-table source contains — the denominator
 * `parseRouteTable` has to account for. Receiver-agnostic on purpose; see
 * {@link addCallSiteRegex}.
 *
 * ⚠️ COMMENTS AND STRINGS ARE NOT STRIPPED, and they must not be: neither is
 * stripped before `parseRouteTable`'s own scan either, so a commented-out
 * `router.add('GET', '/x', h)` is parsed into a row AND counted here, and the
 * two numbers still agree. That same-text property is why a commented-out
 * `router.add` is harmless, and it survives the widening intact — widening adds
 * matches, it never removes the `router.add` ones. Stripping comments here and
 * not there would invent a permanent false mismatch.
 * (MEASURED 2026-09-27 on this tree: 742 `.add(` occurrences across the four
 * route files versus 741 `router.add(`. The single difference is prose — the
 * words `Router.add()` inside the comment at `src/server.ts:1789` — and it is
 * accounted for by name, not subtracted silently.)
 */
export function countAddCallSites(source: string): number {
  const re = addCallSiteRegex();
  let n = 0;
  while (re.exec(source) !== null) n += 1;
  return n;
}

/** `'/api/x'` / `"/api/x"` -> `/api/x`. Returns the input unchanged if it is
 * not a simple quoted string literal (e.g. a template literal with `${}`). */
function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s[0] === "'" && s[s.length - 1] === "'") ||
      (s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === '`' && s[s.length - 1] === '`'))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * From `startIndex` (just past an opening `(`), split the call's argument
 * list on top-level commas — depth-aware over `()[]{}`, and string/template
 * literal aware so a comma or brace inside a string never confuses depth.
 * Returns null if the parens never balance within the source (malformed).
 */
function splitTopLevelArgs(
  source: string,
  startIndex: number,
): { parts: string[]; endIndex: number } | null {
  const parts: string[] = [];
  let current = '';
  let depth = 0; // depth 0 here means "inside the outer call's parens"
  let inString: '"' | "'" | '`' | null = null;
  let i = startIndex;
  for (; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1] ?? '';
    if (inString !== null) {
      current += ch;
      if (ch === inString && source[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      // line comment — skip to end of line, contributes nothing
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) {
        parts.push(current);
        return { parts, endIndex: i + 1 };
      }
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  return null; // never closed
}

function isTestFile(path: string): boolean {
  return TEST_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** Recursively list non-test `.ts`/`.tsx` under `dir`. Exported so a second
 * guard can enumerate the same handler tree without re-implementing the walk
 * (and, in particular, without accidentally including `.test.ts` files). */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !isTestFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `src/server.ts` does not declare every route directly: three files
 * (`routes/tools/index.ts`, `routes/coding/index.ts`, `routes/tools/bridge.ts`
 * as of this writing — 19 GET routes between them) export a
 * `register<Name>Routes(router)` function that server.ts calls, and THAT
 * function's own `router.add(...)` calls are invisible to a scan of
 * server.ts alone. Find every `register<Name>Routes(router)` CALL (not just
 * the import) in server.ts, then look up which file among `files` exports a
 * same-named function, so those routes get the same treatment instead of
 * silently vanishing from the census (a worse failure than `unresolved`: an
 * `unresolved` entry is still rot-checked, a route this misses is never
 * checked at all).
 */
export function findDelegatedRouteFiles(
  serverSource: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): string[] {
  const callRe = /\bregister(\w+)Routes\s*\(\s*router\s*\)/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(serverSource)) !== null) names.add(`register${m[1]}Routes`);
  if (names.size === 0) return [];

  const found: string[] = [];
  for (const { path, content } of files) {
    for (const name of names) {
      if (new RegExp(`export\\s+function\\s+${name}\\s*\\(`).test(content)) {
        found.push(path);
        break;
      }
    }
  }
  return found;
}
