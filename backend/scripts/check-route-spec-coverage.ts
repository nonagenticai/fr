#!/usr/bin/env bun
// backend/scripts/check-route-spec-coverage.ts
//
// CI guard — a TWO-DIRECTIONAL ratchet between the live route table and the
// hand-maintained OpenAPI document.
//
// WHY THIS EXISTS (fr issue #1245). Nothing asserted that a route registered
// with `router.add(...)` is declared in `src/openapi.ts`. A route went live
// UNDECLARED and was only hand-added to the spec by a later commit — nobody
// noticed in between, because no instrument was looking. MEASURED at the time:
// 4 files reference the spec, 9 parse `router.add`, intersection ZERO. Both
// controls were non-zero, so that zero was a real absence and not a broken
// grep.
//
// THE DRIFT IS ENORMOUS AND PRE-EXISTING — READ THIS BEFORE QUOTING A GREEN RUN
// =============================================================================
// MEASURED on origin/main @ db876dce:
//
//   route table  : 741 `router.add(...)` CALL SITES — 688 in src/server.ts, 34
//                  in src/routes/tools/index.ts, 10 in src/routes/tools/bridge.ts,
//                  9 in src/routes/coding/index.ts. Of those, 740 are JUDGEABLE
//                  sites and 1 is the dynamic-method row described below, so the
//                  guard prints `740 route site(s)`, not 741. Every one of the
//                  741 is accounted for — see `routeAccountingError`.
//   spec         : 50 paths / 67 operations (the guard prints the 67)
//   UNDECLARED   : 674 of the 740 judgeable sites are in NO spec entry — exactly
//                  `GRANDFATHERED_UNDECLARED.size`. The guard prints
//                  `674 pinned as KNOWN-UNDECLARED`; 66 are declared.
//
// ⚠️ Those are the numbers THIS CODE PRINTS. An earlier draft of this header said
// `741 rows` / `675 of 741` while the guard printed 740 / 674 and the pin array
// held 674 entries — a reader reconciling a green run against the header would
// have chased a phantom off-by-one. If you change a count here, run the guard and
// paste what it says.
//   ORPHAN       : 1 spec operation has no `router.add` row (`GET /health` —
//                  see EXEMPT_SPEC_OPERATIONS; it is genuinely live, served
//                  outside the router)
//
// So the spec documents ~9% of the API. Declaring the other 674 is a large,
// deliberate, reviewable piece of work and is NOT what this script does. This
// is a RATCHET: the 674 are
// pinned as GRANDFATHERED, and what fails is MOVEMENT —
//
//   * a NEW route registered without a spec entry               (the #1245 bug)
//   * a spec entry whose route disappeared                      (dead docs)
//   * a grandfathered route that GAINED a spec entry and was not removed from
//     the pin list in the same PR                               (see below)
//
// ⛔ A GREEN RUN HERE DOES NOT MEAN THE API IS DOCUMENTED. It means the
// undocumented set did not grow. Do not let this line rot into reassurance.
//
// THE PIN LIST IS AN EXACT SET, WHICH MAKES THE RATCHET TWO-SIDED
// --------------------------------------------------------------
// `GRANDFATHERED_UNDECLARED` is compared by exact membership, not by a count
// ceiling. Adding a spec entry for a pinned route therefore FAILS this guard
// until the pin is deleted in the same PR. That is deliberate: an unrecorded
// improvement is headroom the next PR quietly refills, and the instrument goes
// silent without anyone deciding that it should.
//
// PATH-PARAMETER NORMALISATION — AND THE MEASUREMENT THAT CHOSE IT
// ================================================================
// The route table writes parameters Express-style (`/api/projects/:id`); the
// spec writes them OpenAPI-style (`/api/projects/{id}`). `normalisePath` maps
// the route spelling ONTO the spec spelling and nothing else:
//
//   1. `:name`  ->  `{name}`     (the parameter NAME IS PRESERVED)
//   2. one trailing `/` stripped, except for the root path `/`
//   3. nothing else — no case folding, no collapsing of `//`, no prefix
//      rewriting. The ingress does not add `/api` (see the repo CLAUDE.md), so
//      neither does this.
//
// ⭐ WHY NAMES ARE PRESERVED, measured rather than assumed. The lenient
// alternative — erase parameter names, compare positionally (`{}`) — was
// implemented and run against this tree side by side with the strict rule:
//
//     spec operations 67 | matched name-exact 66 | matched positionally 66
//     name-only differences: 0
//
// The two rules are INDISTINGUISHABLE on this tree, so the strict one is free:
// it costs zero false positives today and it can still catch a real defect the
// lenient one is blind to — a spec that documents `{projectId}` where the route
// declares `:id` makes every generated client send the wrong parameter name.
// That case is reported as `param-name-mismatch` and has NO grandfather list,
// because the measured population is zero. If that check ever fires, it found
// something new; do not add an allowlist for it without reading the route.
//
// EXEMPTION KEYS ARE SITE-SPECIFIC ON PURPOSE
// ===========================================
// Every pin and every exemption is keyed at `<file>:<fn>:<METHOD> <path>`
// granularity:
//
//   src/server.ts:handleListProjects:GET /api/projects
//   src/openapi.ts:healthCheck:GET /health
//
// NOT on the path alone. A sibling guard in this repo had two DIFFERENT call
// sites sharing one identical expression, so a single allowlist entry exempted
// both — which is precisely the thing its comment claimed to prevent. Keying on
// the registering file AND the handler identifier AND the method AND the path
// means one entry can only ever exempt one registration. If two registrations
// ever produce the same key, `duplicateKeyError` fails the guard as BROKEN
// rather than letting one pin cover two sites.
//
// WHAT THIS GUARD DOES NOT CATCH (accepted blind spots, stated so a green run
// is not over-read)
// ==========================================================================
//   * ROUTES SERVED OUTSIDE THE ROUTER. `src/server.ts` answers `/health`,
//     `/health/live`, `/openapi.json` and `/` with direct `url.pathname ===`
//     comparisons in the fetch handler. Those are invisible to a `router.add`
//     parse, which is why `GET /health` appears as an orphan spec entry and is
//     exempted WITH ITS EVIDENCE rather than deleted from the spec.
//   * SCHEMA CONTENT. This compares the SET of method+path pairs. Two
//     operations can match perfectly here while the documented request body,
//     response schema, status codes and auth are all wrong.
//     `tests/unit/openapi-spec-integrity.test.ts` checks the spec's internal
//     coherence; neither of us compares it to a handler's actual behaviour.
//   * A DYNAMIC METHOD. `src/server.ts:1792` registers the kag `/reviews`
//     byte-passthrough in a `for (const method of [...])` loop, so the method
//     argument is an identifier, not a literal, and its path is the regex
//     `(.*)`. That row cannot be matched to a spec path by any string rule. It
//     is counted, named, and held at MAX_DYNAMIC_METHOD_ROUTES rather than
//     dropped — a route this guard silently discarded would be worse than one
//     it admits it cannot judge.
//     ⚠️ THAT BUCKET COUNTS CALL SITES, NOT ROUTES, and the difference is a
//     factor of five here: `src/server.ts:1791-1793` loops over FIVE methods
//     through ONE `router.add`, so `1 unjudgeable` is ONE SITE carrying FIVE
//     live routes. Nothing static can count them in general (the list may be a
//     variable), so the output says `call site(s)` and says so out loud rather
//     than letting the number be read as a route count.
//   * SCHEMA DRIFT INSIDE A MATCHED PAIR — see the SCHEMA CONTENT bullet above.
//   * TWO-LEVEL DELEGATION. `findDelegatedRouteFiles` (from
//     lib/route-table.ts) follows `register<Name>Routes(router)`
//     exactly ONE level deep, so a route registered by a function that is
//     itself registered by a delegating function never reaches the census.
//   * A COMMENTED-OUT REGISTRATION, IN BOTH DIRECTIONS. Neither the parser nor
//     the counter strips comments (deliberately — see `countAddCallSites`), so
//     `// router.add('GET', '/api/projects', h)` is parsed into a census row and
//     counted in the denominator exactly as if it were live. MEASURED on
//     `src/server.ts:1089`: DELETING the line exits 1 with
//     `[orphan-spec-operation] GET /api/projects` and a census of 739;
//     COMMENTING it OUT exits 0, with the route still among the 66 `declared`
//     while it 404s and the spec still documents it. So (a) the dead-docs
//     direction is defeated by a comment, and (b) the census over-states how
//     many routes are live. Both follow from the one same-text property that
//     keeps a commented-out `router.add` from red-ing the accounting check, and
//     that trade is taken knowingly: a false mismatch on every comment would be
//     worse. ESLint/`tsc` do not see commented code either; the reviewer of the
//     diff that comments a registration is the control here, not this guard.
//
// ⭐ WHAT THE ACCOUNTING CHECK DOES AND DOES NOT REACH
// ==============================================================================
// `parseRouteTable` DROPS a `router.add(` call whose METHOD is not a bare word
// (`req.method`, `HTTP_VERBS[i]`, `_method`) or whose PATH is not a string
// literal (`const P = '/api/x'; router.add('POST', P, h)`). Until 2026-09-27
// neither drop reached ANY bucket: not `sites`, not `dynamicMethod`. MEASURED at
// the time — appending one variable-path registration to `src/server.ts` left the
// printed census total UNCHANGED at 740 and the guard exited 0. A ceiling cannot
// bound what never arrives, and the bullet list above read as exhaustive while
// two whole classes were missing from it.
//
// `routeAccountingError` closes THAT class by ACCOUNTING, not by enumerating: for
// every file the census read, the rows `parseRouteTable` returned must equal the
// `.add(` call sites `countAddCallSites` finds in that same text, PER FILE (a
// total would let one file's over-count mask another's under-count). A drop that
// happens after the pattern matched — any argument spelling, present or future —
// makes the two disagree and fails EXIT_BROKEN_GUARD.
//
// ⚠️ WHAT IT CANNOT REACH, STATED BECAUSE THIS BLOCK PREVIOUSLY CLAIMED
// OTHERWISE. Until 2026-09-27 these lines said a silently discarded route was
// "IMPOSSIBLE" and that the accounting check was "the ONLY reason the bullet list
// above can be trusted as complete". That was FALSE, and false in the direction
// that matters: numerator and denominator were the SAME regex on the SAME text,
// so the invariant was blind to any registration NEITHER of them matched.
// MEASURED on the real `src/server.ts`, each appended then restored — all seven
// resolve through `router.match()`, so all seven are live routes:
//     const alias = router; alias.add(…)   router\n  .add(…)   router['add'](…)
//     router?.add(…)   router . add(…)   router/* c */.add(…)
// and, needing no intent at all, a delegated route file whose router PARAMETER
// is named `r` rather than `router` — which printed `src/routes/…=0/0`, i.e. a
// file read, listed, asserted perfectly accounted for, with a live undeclared
// route inside it.
// The denominator is now RECEIVER-AGNOSTIC (`countAddCallSites`) so all eight
// red, but the honest statement of the guarantee is CONDITIONAL, not absolute:
//   * accounting sees every drop by a call the DENOMINATOR'S pattern matches;
//   * it is blind to a registration that pattern does not match — today that
//     means a receiver-less spelling (`add.call(router, …)`, `Reflect.apply`,
//     a destructured method, a route table built by data) — and it is blind to a
//     commented-out registration in the sense above.
// So the bullet list above is a list of KNOWN blind spots, not a proof that no
// others exist. ⛔ Do not relax the accounting check to make a new registration
// style pass; give the style a NAMED, COUNTED bucket instead, or widen
// `addCallSiteRegex` and re-measure the one-account delta.
//
// A LOWER-CASE METHOD LITERAL IS REFUSED, NOT NORMALISED
// -----------------------------------------------------
// Generalising the parser from GET-only made a `'get'` / `'Get'` literal VISIBLE
// where it was previously filtered out (measured population on this tree: 0).
// That interacts badly: `src/utils/router.ts:26` compares
// `route.method !== method` CASE-SENSITIVELY against Bun's upper-case
// `req.method`, and `Router.add` stores the method verbatim, so such a route is
// DEAD at runtime — while `operationKey` upper-cases and would match it to the
// spec's `get` operation and print it as DECLARED. That is a green line
// asserting a documented route that 404s to every caller. `nonUppercaseMethodError`
// therefore fails it EXIT_BROKEN_GUARD: it cannot be a working route, so admitting
// it can only mislead. ⛔ It is NOT normalised to `GET` — normalising would
// manufacture the false green rather than reveal the runtime defect.
//
// REUSE — there is ONE `router.add` parser in this repo
// ====================================================
// `parseRouteTable` / `findDelegatedRouteFiles` / `listSourceFiles` /
// `BACKEND_DIR` / `ROUTE_TABLE_FILE` / `HANDLER_ROOT` are all imported from
// `lib/route-table.ts`. `parseRouteTable` is that file's
// `router.add` parser, generalised from GET-only to method-aware (its
// `parseGetRoutes` is now a filter over it). Writing a second regex here would
// have been the worse defect: two parsers that disagree about what the route
// table says would BOTH still print OK.

import { KAG_REVIEWS_SPEC_EXEMPT } from '../src/capabilities/kag/reviews-passthrough';
import {
  BACKEND_DIR,
  HANDLER_ROOT,
  ROUTE_TABLE_FILE,
  countAddCallSites,
  findDelegatedRouteFiles,
  listSourceFiles,
  parseRouteTable,
  type MethodRouteEntry,
} from './lib/route-table';
import { openapiSpec } from '../src/capabilities/served-spec';
import { LICENCE_ROUTE_ALLOWLIST } from '../src/lib/licence-route-allowlist';
import { capabilityRouteRows, type CapabilityRouteRow } from '../src/capabilities/derive-router';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const EXIT_OFFENCES = 1;
export const EXIT_BROKEN_GUARD = 2;

/** The file that holds the spec object, for exemption keys and messages. */
export const SPEC_FILE = 'src/capabilities/served-spec.ts';

/** The OpenAPI 3 operation keys. Anything else under a path item (`parameters`,
 * `summary`, `$ref`, …) is not an operation and must not be counted as one. */
export const HTTP_METHODS: ReadonlyArray<string> = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
];

// ───────────────────────────────────────────────────────────────────────────
// The denominator's one exception list
// ───────────────────────────────────────────────────────────────────────────

/**
 * One `.add(`-shaped piece of text that is NOT a route registration.
 *
 * The denominator (`countAddCallSites`) is deliberately receiver-agnostic and
 * therefore deliberately dumb: it counts `.add(` wherever it appears, including
 * in prose. Exactly ONE occurrence in the four route files is not a registration.
 * It is named here rather than subtracted, so that:
 *   - the deduction is VISIBLE in the guard's own output, and
 *   - it ROTS — if the text disappears or appears twice, `counterAccountError`
 *     fails the guard (exit 2) instead of quietly deducting the wrong number.
 *
 * ⛔ This is NOT a place to silence a new registration spelling. It is for text
 * that is not a call at all, or a call that demonstrably cannot register a route
 * (a `Set.add`). Adding an entry is a claim a reviewer can check by reading the
 * named text.
 */
export interface NonRegistrationAddCall {
  /** File, spelled as `filesRead` spells it (relative to the backend root). */
  file: string;
  /**
   * The EXACT text as it appears on disk, long enough to be unique in the file
   * and to contain the `.add(`-shaped fragment it accounts for.
   */
  text: string;
  reason: string;
}

/**
 * MEASURED 2026-09-27 across the four route files: 742 `.add(` occurrences vs
 * 741 `router.add(`. The delta is exactly the one entry below — so widening the
 * denominator cost one documented account and nothing else.
 */
// P4d-2e: EMPTY. The one entry (the prose `Router.add()` in the comment above the kag /reviews
// loop) left with that loop: the passthrough is registry rows now (capabilities/kag/reviews-passthrough.ts).
export const NON_REGISTRATION_ADD_CALLS: ReadonlyArray<NonRegistrationAddCall> = [];

/**
 * How many of a file's `.add(` occurrences an explicit account claims are not
 * registrations, plus any reason the claim itself cannot be trusted.
 *
 * Both halves are returned together on purpose: a stale or ambiguous entry must
 * never be able to reduce the denominator, and must never pass silently either.
 */
export function applyNonRegistrationAccounts(
  file: string,
  content: string,
  accounts: ReadonlyArray<NonRegistrationAddCall> = NON_REGISTRATION_ADD_CALLS,
): { deducted: number; errors: string[] } {
  let deducted = 0;
  const errors: string[] = [];
  for (const a of accounts) {
    if (a.file !== file) continue;
    const occurrences = content.split(a.text).length - 1;
    if (occurrences === 0) {
      errors.push(
        `${a.file}: NON_REGISTRATION_ADD_CALLS names text that is NO LONGER IN THE FILE — ` +
          `${JSON.stringify(a.text)}. Delete the entry (the occurrence it accounted for is gone).`,
      );
      continue;
    }
    if (occurrences > 1) {
      errors.push(
        `${a.file}: NON_REGISTRATION_ADD_CALLS text occurs ${occurrences} times, so it cannot ` +
          `say WHICH occurrence it accounts for — ${JSON.stringify(a.text)}. Lengthen it until ` +
          `it is unique.`,
      );
      continue;
    }
    const hits = countAddCallSites(a.text);
    if (hits === 0) {
      errors.push(
        `${a.file}: NON_REGISTRATION_ADD_CALLS text contains no .add( occurrence at all, so it ` +
          `accounts for nothing — ${JSON.stringify(a.text)}. Either it is the wrong snippet or ` +
          `the entry is unnecessary.`,
      );
      continue;
    }
    deducted += hits;
  }
  return { deducted, errors };
}

// ───────────────────────────────────────────────────────────────────────────
// Normalisation
// ───────────────────────────────────────────────────────────────────────────

/**
 * Map a path from EITHER side onto one comparable spelling: Express `:name`
 * becomes OpenAPI `{name}`, and a single trailing slash is dropped (the root
 * `/` survives). See the header for why the parameter name is kept.
 *
 * Idempotent: a path already in spec spelling is returned unchanged.
 */
export function normalisePath(path: string): string {
  const braced = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  if (braced.length > 1 && braced.endsWith('/')) return braced.slice(0, -1);
  return braced;
}

/**
 * The LENIENT spelling — parameter names erased. Used ONLY to tell a genuine
 * absence apart from a parameter-name disagreement, so the two are reported as
 * different findings instead of one undifferentiated red.
 */
export function positionalPath(path: string): string {
  return normalisePath(path).replace(/\{[^}]*\}/g, '{}');
}

/** `GET` + `/api/x/{id}` -> `GET /api/x/{id}`. The comparison key. */
export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalisePath(path)}`;
}

/** `GET` + path -> `GET /api/x/{}`. The lenient comparison key. */
export function positionalKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${positionalPath(path)}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Census: the route table
// ───────────────────────────────────────────────────────────────────────────

export interface RouteSite {
  /** File that called `router.add` — server.ts or a delegated route file. */
  file: string;
  /** Handler argument text as written (`handleListProjects`, or raw text). */
  handler: string;
  method: string;
  /** Normalised path. */
  path: string;
  /** `<file>:<fn>:<METHOD> <path>` — the pin / exemption key. */
  key: string;
}

/**
 * `<file>:<fn>:<METHOD> <path>`. One entry can exempt exactly one site.
 *
 * The handler text is whitespace-collapsed because a prettier-wrapped inline
 * arrow argument spans several lines, and a key containing a newline is
 * unreadable in a pin list and unstable under reformatting. Collapsing
 * whitespace does not lose granularity: the identifier(s) in the expression
 * are what distinguish two sites, not the line breaks between them.
 */
export function siteKey(file: string, handler: string, method: string, path: string): string {
  return `${file}:${handler.replace(/\s+/g, ' ').trim()}:${operationKey(method, path)}`;
}

/**
 * Per-file reconciliation between what the file CONTAINS and what the parser
 * ACCOUNTED FOR. The subject of `routeAccountingError`; kept per file on purpose
 * — a single total would let one file over-counting cancel another file
 * under-counting and the guard would still print OK.
 */
export interface FileAccounting {
  /** Path relative to the backend root, as it appears in messages and pins. */
  file: string;
  /** Every `.add(` occurrence in the text the census read, receiver-agnostic. */
  rawAddCallSites: number;
  /** How many of those an explicit `NON_REGISTRATION_ADD_CALLS` entry claims is
   * not a registration. Reported separately so no deduction is invisible. */
  accountedNonRegistrations: number;
  /** `rawAddCallSites - accountedNonRegistrations` — the denominator. */
  callSites: number;
  /** Rows `parseRouteTable` returned from that same text. */
  parsedRows: number;
}

export interface RouteCensus {
  sites: RouteSite[];
  /** How many of `sites` are capability-derived (no `router.add` text). */
  capabilityDerived?: number;
  /**
   * Rows whose METHOD was an identifier, not a literal — see the header.
   * ⚠️ ONE ENTRY IS ONE CALL SITE, NOT ONE ROUTE: src/server.ts:1791-1793
   * registers five methods through a single `router.add`.
   */
  dynamicMethod: string[];
  /**
   * Literal methods NOT written in upper case. Population 0; kept as its own
   * bucket because such a route is DEAD at runtime — see
   * `nonUppercaseMethodError`.
   */
  nonUppercaseMethodLiterals: string[];
  /** Files the census actually read, echoed so an empty result can name them. */
  filesRead: string[];
  /** One row per file in `filesRead`. See `routeAccountingError`. */
  accounting: FileAccounting[];
  /**
   * Reasons a `NON_REGISTRATION_ADD_CALLS` entry could not be trusted (stale,
   * ambiguous, or accounting for nothing). Fails the guard via
   * `counterAccountError` — an untrustworthy deduction must not silently shrink
   * the denominator.
   */
  counterAccountErrors: string[];
}

/** Read the route table off disk. Overridable so the unit test can drive a
 * synthetic tree without touching the real one. */
export interface CensusSources {
  serverSource?: string;
  /** `{ path (relative to backend), content }` for the delegation lookup. */
  handlerFiles?: ReadonlyArray<{ path: string; content: string }>;
  /**
   * The denominator's exception list. Defaults to `NON_REGISTRATION_ADD_CALLS`
   * when reading the REAL tree and to `[]` when `serverSource` is overridden —
   * the same reasoning the fixture seam uses for pins and exemptions: an entry
   * naming prose in the real `src/server.ts` describes that file, so against a
   * synthetic source it would only ever report itself as stale. Passing it
   * explicitly is how the rot-check is tested.
   */
  nonRegistrationAccounts?: ReadonlyArray<NonRegistrationAddCall>;
  /**
   * fr-agui SPEC §3.4 (a): rows `deriveRouter` registers from the capability
   * registry. They have no `router.add` text, so without this they would vanish
   * from the census. Defaults to the REAL registry when reading the real tree and
   * to `[]` when `serverSource` is overridden (a fixture describes no registry).
   */
  capabilityRows?: ReadonlyArray<CapabilityRouteRow>;
}

export function collectRoutes(sources: CensusSources = {}): RouteCensus {
  const serverSource =
    sources.serverSource ?? readFileSync(join(BACKEND_DIR, ROUTE_TABLE_FILE), 'utf8');
  const handlerFiles =
    sources.handlerFiles ??
    listSourceFiles(join(BACKEND_DIR, HANDLER_ROOT)).map((full) => ({
      path: relative(BACKEND_DIR, full),
      content: readFileSync(full, 'utf8'),
    }));

  const accounts =
    sources.nonRegistrationAccounts ??
    (sources.serverSource === undefined ? NON_REGISTRATION_ADD_CALLS : []);

  const rows: Array<MethodRouteEntry & { file: string }> = [];
  const filesRead: string[] = [];
  const accounting: FileAccounting[] = [];
  const counterAccountErrors: string[] = [];

  /** Parse one file AND record its accounting row in the same place, so the two
   * can never be updated independently and drift apart. */
  const ingest = (file: string, content: string): void => {
    const parsed = parseRouteTable(content);
    rows.push(...parsed.map((r) => ({ ...r, file })));
    filesRead.push(file);
    const rawAddCallSites = countAddCallSites(content);
    const { deducted, errors } = applyNonRegistrationAccounts(file, content, accounts);
    counterAccountErrors.push(...errors);
    accounting.push({
      file,
      rawAddCallSites,
      accountedNonRegistrations: deducted,
      callSites: rawAddCallSites - deducted,
      parsedRows: parsed.length,
    });
  };

  ingest(ROUTE_TABLE_FILE, serverSource);
  for (const delegatedPath of findDelegatedRouteFiles(serverSource, handlerFiles)) {
    const delegated = handlerFiles.find((f) => f.path === delegatedPath);
    if (delegated === undefined) continue;
    ingest(delegatedPath, delegated.content);
  }

  const sites: RouteSite[] = [];
  const capabilityRows =
    sources.capabilityRows ?? (sources.serverSource === undefined ? capabilityRouteRows() : []);
  // Counted in `sites` (they ARE routes) but never in `accounting`: that check
  // compares `.add(` text to parsed rows per file, and a derived row has neither.
  for (const r of capabilityRows) {
    sites.push({
      file: r.file,
      handler: r.capabilityId,
      method: r.method,
      path: normalisePath(r.path),
      key: siteKey(r.file, r.capabilityId, r.method, r.path),
    });
  }
  const dynamicMethod: string[] = [];
  const nonUppercaseMethodLiterals: string[] = [];
  for (const row of rows) {
    if (!row.methodIsLiteral) {
      dynamicMethod.push(`${row.file}:${row.handler}: <dynamic ${row.method}> ${row.path}`);
      continue;
    }
    if (row.rawMethod !== row.rawMethod.toUpperCase()) {
      // NOT normalised away, and NOT dropped: recorded verbatim so
      // nonUppercaseMethodError can name the spelling that is actually on disk.
      nonUppercaseMethodLiterals.push(
        `${row.file}:${row.handler}: '${row.rawMethod}' ${row.path}`,
      );
    }
    sites.push({
      file: row.file,
      handler: row.handler,
      method: row.method,
      path: normalisePath(row.path),
      key: siteKey(row.file, row.handler, row.method, row.path),
    });
  }
  return {
    sites,
    capabilityDerived: capabilityRows.length,
    dynamicMethod,
    nonUppercaseMethodLiterals,
    filesRead,
    accounting,
    counterAccountErrors,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Census: the spec
// ───────────────────────────────────────────────────────────────────────────

export interface SpecOperation {
  method: string;
  /** Normalised path (already OpenAPI spelling; normalisePath is idempotent). */
  path: string;
  /** `operationId` if the spec declares one, else `<anonymous>`. */
  operationId: string;
  /** `src/openapi.ts:<operationId>:<METHOD> <path>` — the exemption key. */
  key: string;
}

/** Deliberately loose: the guard must be able to SEE a malformed spec, so it
 * cannot assume the shape it is reading. Same stance as
 * tests/unit/openapi-spec-integrity.test.ts. */
export type LooseSpec = { paths?: Record<string, Record<string, unknown>> };

export function collectSpecOperations(spec: LooseSpec = openapiSpec as LooseSpec): SpecOperation[] {
  const out: SpecOperation[] = [];
  const paths = spec.paths ?? {};
  for (const rawPath of Object.keys(paths)) {
    const item = paths[rawPath];
    if (item === null || typeof item !== 'object') continue;
    for (const rawMethod of Object.keys(item)) {
      if (!HTTP_METHODS.includes(rawMethod.toLowerCase())) continue;
      const op = (item as Record<string, unknown>)[rawMethod];
      const operationId =
        op !== null && typeof op === 'object' && typeof (op as { operationId?: unknown }).operationId === 'string'
          ? ((op as { operationId: string }).operationId)
          : '<anonymous>';
      const method = rawMethod.toUpperCase();
      const path = normalisePath(rawPath);
      out.push({
        method,
        path,
        operationId,
        key: `${SPEC_FILE}:${operationId}:${operationKey(method, rawPath)}`,
      });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Exemptions
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spec operations that legitimately have NO `router.add` row.
 *
 * NOT a convenience list. Each entry is a route this guard's instrument cannot
 * see, with the evidence on the line next to it. A spec entry for a route that
 * no longer exists belongs in the offence report, not here.
 */
export const EXEMPT_SPEC_OPERATIONS: Readonly<Record<string, string>> = {
  // Served by a direct `url.pathname === '/health'` comparison inside the
  // Bun.serve fetch handler (src/server.ts:3114) — before the router is
  // consulted, deliberately touching no dependency. It IS live; a
  // `router.add` parse simply cannot see it.
  'src/capabilities/served-spec.ts:healthCheck:GET /health': 'src/server.ts:1617 — direct pathname match in the fetch handler, before the router (capabilities/platform/system.ts http.unrouted)',
};

/**
 * Routes that legitimately have NO spec entry.
 *
 * P4d-2e: only the Evidence Review passthrough (below). Before it, EMPTY, and that was the honest state: every undeclared route on main today is
 * in `GRANDFATHERED_UNDECLARED` below — i.e. recorded as DEBT, not blessed as
 * correct. Health/liveness probes would belong here if they were routed; they
 * are not (see EXEMPT_SPEC_OPERATIONS). Adding an entry here asserts "this
 * route must never be documented", which is a much stronger claim than "this
 * route is not documented yet" and needs a reason on the line.
 */
export const EXEMPT_ROUTES: Readonly<Record<string, string>> = Object.fromEntries(
  // fr-agui P4d-2e: the Evidence Review byte passthrough, five registry rows declared
  // `http.specExempt` (capabilities/kag/reviews-passthrough.ts, which states the reason). Listed
  // HERE as well, one key per row, so a new specExempt row is still a reviewed edit of this file.
  (['get', 'post', 'patch', 'put', 'delete'] as const).map((m) => [
    `src/capabilities/kag/reviews-passthrough.ts:kag.reviews_passthrough_${m}:${m.toUpperCase()} /api/assets/kag/reviews(.*)`,
    KAG_REVIEWS_SPEC_EXEMPT,
  ]),
);

/**
 * MEASURED 2026-09-26 on origin/main @ db876dce: the 674 judgeable route sites
 * that have no OpenAPI declaration. Regenerate with
 *
 *     bun run scripts/check-route-spec-coverage.ts --dump
 *
 * ⛔ DO NOT regenerate this to silence a red. A new key appearing here is the
 * #1245 defect shipping again. Regeneration is for the PR that DOCUMENTS
 * routes (keys leave the list) or deliberately renames a handler.
 */
export const GRANDFATHERED_UNDECLARED: ReadonlySet<string> = new Set(
  GRANDFATHERED_UNDECLARED_DATA(),
);

/**
 * ⛔ NODE-FACING ROUTES CAN NEVER BE GRANDFATHERED (fr v4, 2026-10-13).
 *
 * WHY. `GET /api/cards/{cardId}` and `GET /api/approvals/all` were live, on the
 * licence allowlist (so the n8n-nodes-fr conveyor seat calls them), and declared
 * NOWHERE in the spec — yet this guard printed OK for months. Root cause: both
 * predate the guard, so its first `--dump` (5afc7563a, 2026-09-28) pinned them in
 * `GRANDFATHERED_UNDECLARED`, and a pin is an unconditional excuse. The node's
 * typed `cards.getCard` / `approvals.listAllApprovals` ops were therefore built
 * from a hand-copied snapshot (n8n-nodes-fr#16) that fr's spec never carried,
 * which is exactly the drift the spec exists to prevent. Same for the report
 * reads, the report webhook and the card-phase lease.
 *
 * So: the debt list may hold UI-only routes, but a route the n8n node is allowed
 * to reach is the node's contract and must be declared — a pin or an
 * `EXEMPT_ROUTES` entry does not excuse it (`node-facing-undeclared`). Keys are
 * derived from the licence allowlist itself, so a new allowlist entry is covered
 * the moment it is added; there is no second list to keep in sync.
 */
export function nodeFacingOperationKeys(
  allowlist: ReadonlyArray<{ method: string; pattern: string }> = LICENCE_ROUTE_ALLOWLIST,
): ReadonlySet<string> {
  return new Set(allowlist.map((r) => operationKey(r.method, normalisePath(r.pattern))));
}

export const NODE_FACING_OPERATIONS: ReadonlySet<string> = nodeFacingOperationKeys();

// ───────────────────────────────────────────────────────────────────────────
// The comparison
// ───────────────────────────────────────────────────────────────────────────

export type OffenceKind =
  | 'undeclared-route'
  | 'node-facing-undeclared'
  | 'orphan-spec-operation'
  | 'param-name-mismatch'
  | 'stale-grandfather'
  | 'stale-exemption';

export interface Offence {
  kind: OffenceKind;
  /** The site/exemption key the reader has to act on. */
  key: string;
  reason: string;
}

export interface Comparison {
  offences: Offence[];
  /** Route sites matched to a spec operation. */
  matched: number;
  /** Route sites pinned as known-undeclared. */
  grandfathered: number;
}

export function compare(
  census: RouteCensus,
  specOps: ReadonlyArray<SpecOperation>,
  pins: ReadonlySet<string> = GRANDFATHERED_UNDECLARED,
  exemptRoutes: Readonly<Record<string, string>> = EXEMPT_ROUTES,
  exemptSpecOps: Readonly<Record<string, string>> = EXEMPT_SPEC_OPERATIONS,
  nodeFacing: ReadonlySet<string> = NODE_FACING_OPERATIONS,
): Comparison {
  const offences: Offence[] = [];

  const specExact = new Set(specOps.map((o) => operationKey(o.method, o.path)));
  const specPositional = new Map<string, string[]>();
  for (const o of specOps) {
    const k = positionalKey(o.method, o.path);
    specPositional.set(k, [...(specPositional.get(k) ?? []), operationKey(o.method, o.path)]);
  }

  const routeExact = new Set(census.sites.map((s) => operationKey(s.method, s.path)));
  const routePositional = new Map<string, string[]>();
  for (const s of census.sites) {
    const k = positionalKey(s.method, s.path);
    routePositional.set(k, [...(routePositional.get(k) ?? []), operationKey(s.method, s.path)]);
  }

  // Direction 1: route -> spec.
  let matched = 0;
  let grandfathered = 0;
  const usedPins = new Set<string>();
  const usedRouteExemptions = new Set<string>();
  for (const site of census.sites) {
    const exact = operationKey(site.method, site.path);
    if (specExact.has(exact)) {
      matched += 1;
      // ⛔ DELIBERATELY NOT marked as a used pin. A pin for a route that is NOW
      // DECLARED is exactly the stale entry the downward ratchet has to catch —
      // marking it used here would silently absorb the improvement and leave a
      // spare pin the next undeclared route could occupy unnoticed. This line
      // was the bug the unit test caught: the first draft did mark it used, and
      // `documenting a pinned route fails as stale-grandfather` went red.
      continue;
    }
    // Declared, but under a different PARAMETER NAME. A separate, worse finding
    // than "absent": generated clients send the wrong parameter.
    const lenient = specPositional.get(positionalKey(site.method, site.path));
    if (lenient !== undefined && lenient.length > 0) {
      offences.push({
        kind: 'param-name-mismatch',
        key: site.key,
        reason:
          `route declares \`${exact}\` but the spec declares \`${lenient.join('` / `')}\` — ` +
          `same shape, DIFFERENT parameter name. Every generated client will send the ` +
          `spec's name. Fix one side; there is no allowlist for this.`,
      });
      continue;
    }
    // Before the excuses: a pin / exemption is marked USED (so it is not also
    // reported stale), but it never excuses a node-facing route.
    if (nodeFacing.has(exact)) {
      if (site.key in exemptRoutes) usedRouteExemptions.add(site.key);
      if (pins.has(site.key)) usedPins.add(site.key);
      offences.push({
        kind: 'node-facing-undeclared',
        key: site.key,
        reason:
          `\`${exact}\` is on LICENCE_ROUTE_ALLOWLIST (src/lib/licence-route-allowlist.ts) — ` +
          `the n8n-nodes-fr conveyor seat calls it — but ${SPEC_FILE} declares it nowhere. ` +
          `A node-facing route is the node's contract: declare it. Neither ` +
          `GRANDFATHERED_UNDECLARED nor EXEMPT_ROUTES excuses it.`,
      });
      continue;
    }
    if (site.key in exemptRoutes) {
      usedRouteExemptions.add(site.key);
      continue;
    }
    if (pins.has(site.key)) {
      grandfathered += 1;
      usedPins.add(site.key);
      continue;
    }
    offences.push({
      kind: 'undeclared-route',
      key: site.key,
      reason:
        `\`${exact}\` is registered in ${site.file} but declared NOWHERE in ` +
        `${SPEC_FILE}. Add a path item for it (this is fr#1245: a route went live ` +
        `undeclared and only reached the spec in a later commit). Pinning it in ` +
        `GRANDFATHERED_UNDECLARED instead is not an option for a NEW route.`,
    });
  }

  // Direction 2: spec -> route. A spec entry for a route that no longer exists
  // is drift too — it documents an endpoint that 404s.
  const usedSpecExemptions = new Set<string>();
  for (const op of specOps) {
    const exact = operationKey(op.method, op.path);
    if (routeExact.has(exact)) continue;
    if (op.key in exemptSpecOps) {
      usedSpecExemptions.add(op.key);
      continue;
    }
    // A positional-only match is reported from the route side above; reporting
    // it here as well would double-count one defect.
    if ((routePositional.get(positionalKey(op.method, op.path)) ?? []).length > 0) continue;
    offences.push({
      kind: 'orphan-spec-operation',
      key: op.key,
      reason:
        `${SPEC_FILE} declares \`${exact}\` (operationId \`${op.operationId}\`) but NO ` +
        `router.add registers it. Either the route was removed and the spec entry is ` +
        `dead documentation, or it is served outside the router — if the latter, add it ` +
        `to EXEMPT_SPEC_OPERATIONS with the file:line that serves it.`,
    });
  }

  // The lists must not rot. A pin whose route is gone, or whose route is now
  // documented, has to be deleted in the same PR that made it stale — otherwise
  // the freed headroom is silently available to the next undeclared route.
  for (const pin of pins) {
    if (usedPins.has(pin)) continue;
    offences.push({
      kind: 'stale-grandfather',
      key: pin,
      reason:
        `pinned in GRANDFATHERED_UNDECLARED but no longer an undeclared route — it was ` +
        `either documented, renamed, or removed. DELETE this line (regenerate with ` +
        `--dump). An unrecorded reduction is headroom the next PR refills unnoticed.`,
    });
  }
  for (const key of Object.keys(exemptRoutes)) {
    if (usedRouteExemptions.has(key)) continue;
    offences.push({
      kind: 'stale-exemption',
      key,
      reason: `listed in EXEMPT_ROUTES but matched no undeclared route site. Delete it.`,
    });
  }
  for (const key of Object.keys(exemptSpecOps)) {
    if (usedSpecExemptions.has(key)) continue;
    offences.push({
      kind: 'stale-exemption',
      key,
      reason: `listed in EXEMPT_SPEC_OPERATIONS but matched no orphan spec operation. Delete it.`,
    });
  }

  return { offences, matched, grandfathered };
}

// ───────────────────────────────────────────────────────────────────────────
// Fail-closed checks
// ───────────────────────────────────────────────────────────────────────────

/**
 * ⭐ THE CHECK THAT MAKES EVERY OTHER CEILING IN THIS FILE MEAN ANYTHING.
 *
 * `parseRouteTable` has three `continue` branches — a malformed argument list, a
 * METHOD that is not a bare word, and a PATH that is not a string literal. A row
 * it drops lands in NO bucket: not `sites`, not `dynamicMethod`. So
 * `MAX_DYNAMIC_METHOD_ROUTES` cannot bound it, `compare` cannot report it, and
 * the guard prints `OK` with the route simply absent from the denominator.
 *
 * MEASURED 2026-09-26, before this check existed:
 *
 *     router.add('POST', '/api/probe', h);   -> EXIT 1, 741 route site(s)   (seen)
 *     const P = '/api/probe';
 *     router.add('POST', P, h);              -> EXIT 0, 740 route site(s)   (gone)
 *
 * The fix is ACCOUNTING, not enumeration: the rows returned from a file must
 * equal the `.add(` call sites in that file's text.
 *
 * ⛔ CORRECTED 2026-09-27 — AND THIS IS THE WHOLE REASON THE CHECK IS WORTH
 * ANYTHING. These lines used to say both numbers came from `routerAddCallRegex()`,
 * "the one regex, on the same raw text — so they agree by construction on
 * everything EXCEPT a drop". One regex on one text is precisely what made the
 * invariant blind to a registration that regex never matched, and MEASURED on the
 * real `src/server.ts` seven such spellings all exited 0 with the census
 * unchanged while `router.match()` resolved every one of them (`const alias =
 * router; alias.add(…)`, `router` NEWLINE `.add(…)`, `router['add'](…)`,
 * `router?.add(…)`, `router . add(…)`, `router/* c *\/.add(…)`, and a delegated
 * route file whose router PARAMETER is named `r`). The last one needs no intent
 * at all and printed `=0/0` for a file it had just read.
 *
 * So the DENOMINATOR is now `countAddCallSites` — receiver-agnostic, a strict
 * SUPERSET of the parser's pattern — while the NUMERATOR stays the narrow parser.
 * Every one of those spellings now lands as `callSites > parsedRows`. The
 * asymmetry IS the instrument; do not make them agree again.
 *
 * ⭐ The same-text property that matters is untouched: neither side strips
 * comments or strings, and widening only ADDS matches, so a commented-out
 * `router.add('GET', '/x', h)` is still both counted and parsed and still agrees.
 * What widening does newly count is `.add(` text with some OTHER receiver,
 * including prose. There is exactly one such occurrence in the four route files
 * and it is named in `NON_REGISTRATION_ADD_CALLS`, not subtracted silently.
 *
 * PER FILE, never in total: a total would let `src/server.ts` over-counting by
 * one cancel `src/routes/tools/index.ts` under-counting by one, which is the
 * shape of bug this check exists to see.
 *
 * This is a BROKEN GUARD (exit 2), not an offence (exit 1). A guard that cannot
 * see its own input has not found a policy violation; it has stopped measuring.
 */
export function routeAccountingError(census: RouteCensus): string | null {
  // An untrustworthy deduction makes the denominator itself unreliable, so it is
  // reported through THIS function rather than a branch of its own in main().
  const accountErr = counterAccountError(census);
  const bad = census.accounting.filter((a) => a.callSites !== a.parsedRows);
  if (accountErr === null && bad.length === 0) return null;
  if (bad.length === 0) return accountErr;
  const prefix = accountErr === null ? '' : `${accountErr}\n\nAND:\n\n`;
  const lines = bad.map((a) => {
    const delta = a.callSites - a.parsedRows;
    const verdict =
      delta > 0
        ? `${delta} route(s) SILENTLY DISCARDED by the parser`
        : `${-delta} MORE row(s) than call sites — the parser invented rows`;
    const accounted =
      a.accountedNonRegistrations > 0
        ? ` (${a.rawAddCallSites} .add( occurrence(s) minus ${a.accountedNonRegistrations} accounted as NOT a registration)`
        : '';
    return `  ${a.file}: expected ${a.callSites} .add(...) call site(s)${accounted}, parser accounted for ${a.parsedRows} — ${verdict}`;
  });
  return (
    prefix +
    `ERROR: the router.add(...) parse did not account for every .add( call site, so\n` +
    `A ROUTE WAS SILENTLY DISCARDED. It is in no bucket, therefore no ceiling and no\n` +
    `offence report can ever mention it, and this guard would otherwise keep\n` +
    `printing OK with the route missing from its own denominator:\n\n` +
    lines.join('\n') +
    `\n\nCounted PER FILE, so one file's over-count cannot mask another's under-count.\n` +
    `There are TWO ways to land here, and they need opposite fixes:\n\n` +
    `1. THE RECEIVER IS NOT SPELLED \`router\`. parseRouteTable() only matches\n` +
    `   \`router.add(\`, while the denominator counts any \`.add(\`. So an alias\n` +
    `   (\`const r = router; r.add(...)\`), a computed call (\`router['add'](...)\`),\n` +
    `   an optional chain (\`router?.add(...)\`), a line break before \`.add\`, or a\n` +
    `   DELEGATED route file whose router parameter is named something other than\n` +
    `   \`router\` all register live routes this guard cannot read. Rename the\n` +
    `   receiver/parameter to \`router\` and spell the call \`router.add(\`.\n` +
    `2. THE ARGUMENTS ARE NOT LITERALS. parseRouteTable() drops a call whose\n` +
    `   METHOD is not a bare word (req.method, HTTP_VERBS[i]) or whose PATH is not\n` +
    `   a string literal (const P = '/api/x'; router.add('POST', P, h)). Either\n` +
    `   register with a literal method and literal path, or extend parseRouteTable\n` +
    `   so the form lands in a NAMED, COUNTED bucket the way dynamic-method rows do.\n\n` +
    `If the \`.add(\` this names is genuinely not a route registration at all (a\n` +
    `Set.add, or prose in a comment), add ONE entry to NON_REGISTRATION_ADD_CALLS\n` +
    `naming the exact text and why. ⛔ Do NOT widen or delete this check, and do NOT\n` +
    `narrow the denominator back to \`router.add(\` — that is the exact blindness\n` +
    `that let fr#1245 ship twice.`
  );
}

/**
 * A deduction from the denominator that cannot be trusted is worse than no
 * deduction: it shrinks the number the whole accounting check compares against,
 * silently, by an amount nobody can re-derive from the file.
 *
 * So every `NON_REGISTRATION_ADD_CALLS` entry has to still be findable, findable
 * exactly ONCE, and actually contain the `.add(`-shaped text it claims. Any of
 * those failing is EXIT_BROKEN_GUARD — the same rot-check discipline the pin list
 * gets from `stale-grandfather`.
 *
 * ⚠️ Reached through `routeAccountingError`, not through a branch of its own in
 * `main()`. Deleting a stale entry's text outright leaves raw == parsed, so the
 * arithmetic alone cannot see it; EDITING the text leaves raw one too high and the
 * arithmetic catches it anyway. Only the dead-entry case needs this check.
 */
export function counterAccountError(census: RouteCensus): string | null {
  if (census.counterAccountErrors.length === 0) return null;
  return (
    `ERROR: the denominator's exception list (NON_REGISTRATION_ADD_CALLS) cannot be\n` +
    `trusted, so the \`.add(\` count it feeds is not a measurement of this tree:\n\n` +
    census.counterAccountErrors.map((e) => `  ${e}`).join('\n') +
    `\n\nAn entry exists to make ONE named, reviewable, NON-registration \`.add(\`\n` +
    `occurrence visible in the output instead of subtracting it silently. An entry\n` +
    `whose text has moved or multiplied no longer names anything, and would deduct\n` +
    `the wrong number from the denominator every future run.`
  );
}

/**
 * A method literal that is not upper case is a route that CANNOT RUN, and this
 * guard would otherwise report it as documented.
 *
 * `src/utils/router.ts:26` is `if (route.method !== method) continue;` — a
 * case-sensitive comparison against `req.method`, which Bun hands over
 * upper-cased. `Router.add` stores the method verbatim (router.ts:11-21, no
 * `toUpperCase`). So `router.add('get', '/api/x', h)` registers a row that never
 * matches any request: DEAD at runtime.
 *
 * ⚠️ AND THE INTERACTION IS THE WHOLE POINT. `operationKey` upper-cases, so this
 * guard would cheerfully match that dead row to the spec's `get` operation and
 * count it as DECLARED — a green line asserting a documented route that returns
 * 404 to every caller. Normalising the casing silently would MANUFACTURE that
 * false green, which is why this fails instead.
 *
 * EXIT_BROKEN_GUARD, not an offence: the finding is not "your spec disagrees",
 * it is "this registration is not a route, so I cannot judge it as one". Measured
 * population on this tree: 0 (every literal on main is upper case), so there is
 * no allowlist. If it ever fires, fix the registration; do not exempt it.
 */
export function nonUppercaseMethodError(census: RouteCensus): string | null {
  if (census.nonUppercaseMethodLiterals.length === 0) return null;
  return (
    `ERROR: ${census.nonUppercaseMethodLiterals.length} router.add(...) row(s) pass a method literal that is\n` +
    `NOT UPPER CASE:\n\n` +
    census.nonUppercaseMethodLiterals.map((d) => `  ${d}`).join('\n') +
    `\n\nsrc/utils/router.ts:26 compares route.method !== method case-sensitively\n` +
    `against the upper-case req.method, and Router.add stores the method verbatim,\n` +
    `so that route is DEAD — it matches no request. This guard upper-cases for\n` +
    `comparison, so left alone it would match the dead row to the spec operation\n` +
    `and print it as DECLARED: a false green for a route that 404s. Write the\n` +
    `method in upper case. ⛔ Do not "fix" this by normalising the casing here —\n` +
    `that hides a runtime defect behind a passing guard.`
  );
}

/**
 * The pin list is written as an ARRAY and consumed as a SET, and `new Set()`
 * dedupes without a word. Two identical lines would make `GRANDFATHERED_UNDECLARED`
 * smaller than the text a reviewer counted, so a `--dump` diff and the effective
 * pin set would disagree about how much debt is pinned.
 *
 * Clean on this tree: 674 lines, 674 distinct. EXIT_BROKEN_GUARD, because the
 * baseline this whole ratchet is measured against would be misdescribed.
 */
export function grandfatherDuplicateError(
  list: ReadonlyArray<string> = GRANDFATHERED_UNDECLARED_DATA(),
): string | null {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const k of list) {
    if (seen.has(k)) dups.push(k);
    else seen.add(k);
  }
  if (list.length === seen.size && dups.length === 0) return null;
  return (
    `ERROR: GRANDFATHERED_UNDECLARED_DATA() has ${list.length} entr(ies) but only\n` +
    `${seen.size} distinct — new Set() silently dropped ${list.length - seen.size}, so the effective pin\n` +
    `set is SMALLER than the list a reviewer reads:\n\n` +
    [...new Set(dups)].map((k) => `  ${k}`).join('\n') +
    `\n\nDelete the duplicate line(s). Regenerate with --dump rather than hand-editing.`
  );
}

/**
 * A scan of nothing must never print the same line as a clean scan. Both sides
 * have to be non-empty for any comparison between them to mean anything: zero
 * routes and zero spec operations would "agree" perfectly.
 */
export function emptyScanError(census: RouteCensus, specOps: ReadonlyArray<SpecOperation>): string | null {
  if (census.sites.length === 0) {
    return (
      `ERROR: parsed ZERO router.add(...) rows from ${census.filesRead.join(', ')}\n` +
      `under ${BACKEND_DIR}. fr registers hundreds. Finding none means the route\n` +
      `table moved, the parser rotted, or this ran from the wrong tree — never\n` +
      `that the app has no routes. Refusing to compare nothing against the spec.`
    );
  }
  if (specOps.length === 0) {
    return (
      `ERROR: found ZERO operations in ${SPEC_FILE}. The spec declares dozens.\n` +
      `An empty spec would make every route "undeclared" and every direction of\n` +
      `this comparison meaningless. Refusing to report either way.`
    );
  }
  return null;
}

/**
 * Two registrations must never share one key, or one pin would exempt both —
 * the exact defect the site-specific keys exist to prevent. This is a BROKEN
 * GUARD, not a finding: the instrument cannot tell the two sites apart.
 */
export function duplicateKeyError(census: RouteCensus): string | null {
  const counts = new Map<string, number>();
  for (const s of census.sites) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  const dups = [...counts.entries()].filter(([, n]) => n > 1);
  if (dups.length === 0) return null;
  return (
    `ERROR: ${dups.length} route site key(s) are not unique, so ONE pin or exemption\n` +
    `would cover MORE THAN ONE registration — the failure this key shape exists to\n` +
    `prevent:\n\n` +
    dups.map(([k, n]) => `  ${k}   (x${n})`).join('\n') +
    `\n\nWiden siteKey() (e.g. include the source line) rather than accepting a key\n` +
    `that cannot distinguish two sites.`
  );
}

/**
 * The dynamic-method bucket is held at an EXACT count, two-sided, for the same
 * reason any two-sided ratchet refuses an unrecorded reduction: a row this
 * guard cannot judge is debt, and both growing it and shrinking it are events
 * that should appear in a diff.
 *
 * MEASURED 2026-09-26: exactly 1 — the kag `/reviews` passthrough loop at
 * src/server.ts:1792.
 *
 * ⚠️ THIS COUNTS CALL SITES, NOT ROUTES. That one site loops over FIVE methods
 * (src/server.ts:1791-1793), so the ceiling `1` bounds one `router.add` call, not
 * one route. Raising it by 1 can admit an unbounded number of real routes; the
 * output says `call site(s)` for exactly that reason.
 */
export const MAX_DYNAMIC_METHOD_ROUTES = 0;

export function dynamicMethodError(census: RouteCensus, max: number = MAX_DYNAMIC_METHOD_ROUTES): string | null {
  const n = census.dynamicMethod.length;
  if (n === max) return null;
  const listed = census.dynamicMethod.map((d) => `  ${d}`).join('\n');
  if (n > max) {
    return (
      `ERROR: ${n} router.add(...) CALL SITE(s) register a NON-LITERAL method, above\n` +
      `MAX_DYNAMIC_METHOD_ROUTES (${max}). This guard cannot match them to a spec\n` +
      `path, so each is at least one route nothing checks — and one site can be\n` +
      `SEVERAL routes (server.ts:1791-1793 is five), so this count is a FLOOR:\n\n${listed}\n\n` +
      `Register the methods explicitly (one router.add per method) instead.`
    );
  }
  return (
    `ERROR: dynamic-method call sites fell to ${n} — lower MAX_DYNAMIC_METHOD_ROUTES\n` +
    `to ${n} in this SAME PR. An unrecorded reduction leaves headroom the next\n` +
    `change quietly refills, and this bucket goes silent.`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

export interface CliOptions {
  dump: boolean;
  /**
   * FIXTURE SEAM — `--route-table-file=<path>`.
   *
   * Reads the route table from `<path>` instead of `src/server.ts`, and in that
   * mode applies NO pin list, NO exemptions and NO dynamic-method ratchet,
   * because none of those describe a fixture. It exists for exactly one reason:
   * so the FAILING polarity can be proven through the REAL process boundary.
   * An in-process `main([...])` returning EXIT_OFFENCES proves the function,
   * not the program — mutating `if (import.meta.main)` to `if (false)` makes the
   * CI step print nothing and exit 0 while every in-process control still
   * passes (MEASURED on a sibling guard: 0 of 544 tests died).
   *
   * Every fixture run prints a FIXTURE banner, so its output can never be
   * mistaken for a real one in a log.
   */
  routeTableFile?: string;
}

export function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  const opts: CliOptions = { dump: argv.includes('--dump') };
  for (const arg of argv) {
    const m = arg.match(/^--route-table-file=(.+)$/);
    if (m?.[1]) opts.routeTableFile = m[1];
  }
  return opts;
}

export function main(argv: ReadonlyArray<string> = []): number {
  const opts = parseArgs(argv);
  const fixture = opts.routeTableFile !== undefined;
  const census = fixture
    ? collectRoutes({ serverSource: readFileSync(opts.routeTableFile!, 'utf8') })
    : collectRoutes();
  const specOps = collectSpecOperations();
  if (fixture) {
    console.error(
      `[check-route-spec-coverage] FIXTURE RUN against ${opts.routeTableFile} — ` +
        `pins, exemptions, the dynamic-method ratchet and the denominator's exception ` +
        `list are OFF. Never a real verdict.`,
    );
  }

  // FIRST, and in this order: can the guard see its whole input at all? Every
  // check below is a comparison, and a comparison over a census that lost a row
  // is a measurement of the wrong population. Applies in FIXTURE mode too — a
  // fixture whose rows were dropped proves nothing either.
  // ⛔ ONE gate, not two. `routeAccountingError` also reports an untrustworthy
  // NON_REGISTRATION_ADD_CALLS entry, deliberately: a second `if` here would be a
  // fail-closed branch that NO test can reach through the process boundary (the
  // exception list is OFF in fixture mode, by design), i.e. exactly the shape of
  // gap the --dump ordering had. Folding it in means the branch that carries it is
  // the one the alias / bracket / variable-path / --dump CLI tests already kill.
  const accounting = routeAccountingError(census);
  if (accounting !== null) {
    console.error(`[check-route-spec-coverage] FAIL: ${accounting}`);
    return EXIT_BROKEN_GUARD;
  }
  const badMethodCase = nonUppercaseMethodError(census);
  if (badMethodCase !== null) {
    console.error(`[check-route-spec-coverage] FAIL: ${badMethodCase}`);
    return EXIT_BROKEN_GUARD;
  }
  const pinDupes = grandfatherDuplicateError();
  if (pinDupes !== null) {
    console.error(`[check-route-spec-coverage] FAIL: ${pinDupes}`);
    return EXIT_BROKEN_GUARD;
  }

  if (opts.dump) {
    // Generation mode: reprint GRANDFATHERED_UNDECLARED_DATA. Not run in CI.
    // ⚠️ Deliberately AFTER the accounting/method-case checks above: a baseline
    // regenerated from a parse that dropped rows would pin the wrong population,
    // and every later run would be measured against it.
    // ⭐ THE ORDERING IS A CLAIM, SO IT HAS A TEST. Mutating the accounting branch
    // to `if (accounting !== null && !opts.dump)` leaves the whole suite green
    // (MEASURED: 47 pass / 0 fail) while `--dump` over a lossy fixture flips
    // rc=2 -> rc=0 and prints a pin list built from a parse that dropped rows.
    // `--dump over a lossy fixture` in the CLI describe block is that mutant's
    // killer; do not delete it.
    const { offences } = compare(census, specOps, new Set());
    const keys = offences
      .filter((o) => o.kind === 'undeclared-route')
      .map((o) => o.key)
      .sort((a, b) => a.localeCompare(b));
    console.log('function GRANDFATHERED_UNDECLARED_DATA(): string[] {');
    console.log('  return [');
    for (const k of keys) console.log(`    ${JSON.stringify(k)},`);
    console.log('  ];');
    console.log('}');
    return 0;
  }

  const empty = emptyScanError(census, specOps);
  if (empty !== null) {
    console.error(`[check-route-spec-coverage] FAIL: ${empty}`);
    return EXIT_BROKEN_GUARD;
  }
  const dupes = duplicateKeyError(census);
  if (dupes !== null) {
    console.error(`[check-route-spec-coverage] FAIL: ${dupes}`);
    return EXIT_BROKEN_GUARD;
  }

  const { offences, matched, grandfathered } = fixture
    ? compare(census, specOps, new Set(), {}, {})
    : compare(census, specOps);

  const dynamic = fixture ? null : dynamicMethodError(census);
  if (dynamic !== null) {
    console.error(`[check-route-spec-coverage] FAIL: ${dynamic}`);
    return EXIT_OFFENCES;
  }

  if (offences.length > 0) {
    console.error('[check-route-spec-coverage] FAIL: route table and OpenAPI spec disagree:\n');
    for (const o of offences) {
      console.error(`  [${o.kind}] ${o.key}`);
      console.error(`      -> ${o.reason}\n`);
    }
    console.error(
      `${offences.length} offence(s). Census: ${census.sites.length} route CALL SITE(s) in ` +
        `${census.filesRead.join(', ')}, ${specOps.length} spec operation(s) in ${SPEC_FILE}.`,
    );
    return EXIT_OFFENCES;
  }

  const pct = ((matched / census.sites.length) * 100).toFixed(1);
  const callSites = census.accounting.reduce((n, a) => n + a.callSites, 0);
  // Every deduction from the denominator is named OUT LOUD here. A silent
  // `- 1` is what would make the number above unverifiable from the files.
  const deductions = census.accounting.filter((a) => a.accountedNonRegistrations > 0);
  const accountedNote =
    deductions.length === 0
      ? ''
      : `\n  ⚠️ ${deductions.reduce((n, a) => n + a.accountedNonRegistrations, 0)} \`.add(\` occurrence(s) ` +
        `DEDUCTED as NOT a registration, per NON_REGISTRATION_ADD_CALLS: ` +
        `${deductions.map((a) => `${a.file} ${a.rawAddCallSites}-${a.accountedNonRegistrations}=${a.callSites}`).join(', ')}` +
        ` — ${NON_REGISTRATION_ADD_CALLS.filter((a) => deductions.some((d) => d.file === a.file))
          .map((a) => JSON.stringify(a.text))
          .join(', ')}.`;
  console.log(
    `[check-route-spec-coverage] OK: ${census.sites.length} route site(s) parsed from ` +
      `${census.filesRead.join(', ')} vs ${specOps.length} operation(s) in ${SPEC_FILE}.\n` +
      `  ${matched} declared, ${grandfathered} pinned as KNOWN-UNDECLARED, ` +
      `${Object.keys(EXEMPT_ROUTES).length} exempt, ` +
      `${census.dynamicMethod.length} unjudgeable CALL SITE(s) (dynamic method).\n` +
      `  all ${callSites} .add(...) call site(s) accounted for across ` +
      `${census.accounting.length} file(s): ` +
      `${census.accounting.map((a) => `${a.file}=${a.parsedRows}/${a.callSites}`).join(', ')}` +
      `, plus ${census.capabilityDerived ?? 0} capability-derived route(s) (src/capabilities/registry.ts, no router.add text).\n` +
      `  ⚠️ The denominator is RECEIVER-AGNOSTIC (any \`.add(\`), not \`router.add(\`: a route\n` +
      `  registered through an alias, \`router['add']\`, a line break, or a delegated file whose\n` +
      `  parameter is not named \`router\` is a MISMATCH here, not an invisible pass.${accountedNote}\n` +
      `  ⚠️ EVERY COUNT ON THESE LINES IS CALL SITES, NOT ROUTES. One dynamic-method ` +
      `site can register SEVERAL routes — the kag /reviews loop registered FIVE through ` +
      `one router.add until P4d-2e made them registry rows — so "${census.dynamicMethod.length} unjudgeable" is ` +
      `${census.dynamicMethod.length} site(s), not ${census.dynamicMethod.length} route(s).\n` +
      `  ⚠️ Only ${pct}% of route sites are documented. A green run here means the ` +
      `undocumented set did not GROW — it does not mean the API is documented.`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

// ───────────────────────────────────────────────────────────────────────────
// GENERATED DATA — `bun run scripts/check-route-spec-coverage.ts --dump`
// Kept at the bottom, after every function a reader needs, to keep
// GRANDFATHERED out of the reading path.
// ───────────────────────────────────────────────────────────────────────────

function GRANDFATHERED_UNDECLARED_DATA(): string[] {
  return [
  ];
}
