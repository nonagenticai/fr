// tests/unit/scripts/check-route-spec-coverage.test.ts
//
// Unit tests for `scripts/check-route-spec-coverage.ts` — the two-directional
// ratchet between the `router.add` route table and `src/openapi.ts` (fr#1245).
//
// The controls below are the ways this rule can be wrong, and each one is
// written so that it DIES if the guard is neutered:
//
//   POSITIVE ×2      — a route with no spec entry IS flagged, and a spec entry
//                      with no route IS flagged. A one-directional guard passes
//                      one of these and fails the other.
//   NEGATIVE         — a tree where both sides agree is NOT flagged, so the
//                      guard is not simply `return [offence]`.
//   NORMALISATION    — `:id` and `{id}` are the SAME route, and `:id` vs
//                      `{projectId}` is NOT. Getting this wrong in one
//                      direction makes the guard vacuous (everything matches)
//                      and in the other a wall of false positives; both
//                      polarities are asserted.
//   KEY GRANULARITY  — two DIFFERENT registrations never collapse onto one pin
//                      key. This is the defect a sibling guard shipped: two
//                      sites shared one identical expression, so one allowlist
//                      entry exempted both.
//   RATCHET          — a pin that has stopped being an undeclared route FAILS
//                      until it is deleted. Without this the list only ever
//                      grows and the improvement is never recorded.
//   FAIL-CLOSED      — zero routes parsed, or zero spec operations, is an ERROR
//                      and not a pass. A scan of nothing must never print what
//                      a clean scan prints.
//   BASELINE NON-VACUITY — the shipped pin list is a real measurement of this
//                      tree, not an empty array or a set of stale strings.
//   CLI PATH ×2      — the command CI actually runs still executes the scan AND
//                      can still fail. An in-process `main([...])` cannot see
//                      whether `if (import.meta.main)` is wired: mutating it to
//                      `if (false)` makes the CI step print nothing and exit 0
//                      while every in-process control still passes (MEASURED on
//                      a sibling guard: 0 of 544 tests died).
//
// No `mock.module()` (banned repo-wide, CI-guarded by
// `scripts/check-no-test-doubles.ts`): every entry point of the guard takes its
// inputs as arguments, so a synthetic source string and a synthetic spec object
// are all that is needed. The REAL `src/server.ts` and `src/openapi.ts` are
// never mutated by this file.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  EXIT_BROKEN_GUARD,
  EXIT_OFFENCES,
  EXEMPT_ROUTES,
  EXEMPT_SPEC_OPERATIONS,
  GRANDFATHERED_UNDECLARED,
  HTTP_METHODS,
  MAX_DYNAMIC_METHOD_ROUTES,
  NODE_FACING_OPERATIONS,
  NON_REGISTRATION_ADD_CALLS,
  applyNonRegistrationAccounts,
  collectRoutes,
  collectSpecOperations,
  compare,
  counterAccountError,
  duplicateKeyError,
  dynamicMethodError,
  emptyScanError,
  grandfatherDuplicateError,
  nodeFacingOperationKeys,
  nonUppercaseMethodError,
  normalisePath,
  routeAccountingError,
  operationKey,
  parseArgs,
  positionalPath,
  siteKey,
  type FileAccounting,
  type LooseSpec,
  type RouteCensus,
} from '../../../scripts/check-route-spec-coverage';

const BACKEND_DIR = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const GUARD = 'scripts/check-route-spec-coverage.ts';

/** A one-operation spec, shaped like the real object but tiny. */
function spec(...ops: Array<{ path: string; method: string; operationId: string }>): LooseSpec {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of ops) {
    paths[o.path] = {
      ...(paths[o.path] ?? {}),
      [o.method.toLowerCase()]: { operationId: o.operationId, responses: { '200': {} } },
    };
  }
  return { paths };
}

/** Build a census from a synthetic route-table source, no filesystem. */
function census(serverSource: string): RouteCensus {
  return collectRoutes({ serverSource, handlerFiles: [] });
}

/** One expected accounting row. `raw` defaults to `callSites` because nothing is
 * deducted on a synthetic tree (the exception list is off there, by design). */
function acc(
  file: string,
  callSites: number,
  parsedRows: number,
  accountedNonRegistrations = 0,
): FileAccounting {
  return {
    file,
    rawAddCallSites: callSites + accountedNonRegistrations,
    accountedNonRegistrations,
    callSites,
    parsedRows,
  };
}

// ---------------------------------------------------------------------------
// Normalisation — the rule that decides whether this guard is an instrument
// ---------------------------------------------------------------------------

describe('normalisePath maps the route spelling onto the spec spelling', () => {
  test(':name becomes {name}, and the NAME is preserved', () => {
    expect(normalisePath('/api/projects/:id')).toBe('/api/projects/{id}');
    expect(normalisePath('/api/projects/:id/repositories/:repo_id')).toBe(
      '/api/projects/{id}/repositories/{repo_id}',
    );
    // ⛔ NOT collapsed to a placeholder. If this ever returns `{}` the guard
    // stops being able to see a spec that documents the wrong parameter name.
    expect(normalisePath('/api/projects/:projectId')).not.toBe('/api/projects/{id}');
  });

  test('a path already in spec spelling is unchanged — the rule is idempotent', () => {
    const specSpelling = '/api/projects/{id}/status';
    expect(normalisePath(specSpelling)).toBe(specSpelling);
    expect(normalisePath(normalisePath('/api/projects/:id/status'))).toBe(specSpelling);
  });

  test('one trailing slash is dropped, but the root path survives', () => {
    expect(normalisePath('/api/projects/')).toBe('/api/projects');
    expect(normalisePath('/')).toBe('/');
  });

  test('positionalPath is the LENIENT rule, and is only used to tell two findings apart', () => {
    expect(positionalPath('/api/projects/:id')).toBe('/api/projects/{}');
    expect(positionalPath('/api/projects/{projectId}')).toBe('/api/projects/{}');
    // The two rules must NOT be the same function, or the strict comparison is
    // silently lenient and `param-name-mismatch` can never fire.
    expect(normalisePath('/api/projects/{projectId}')).not.toBe(
      normalisePath('/api/projects/{id}'),
    );
  });
});

// ---------------------------------------------------------------------------
// Direction 1: a route with no spec entry (the #1245 defect itself)
// ---------------------------------------------------------------------------

describe('a route registered with no spec declaration is an offence', () => {
  const source = `router.add('POST', '/api/widgets/:widgetId', handleCreateWidget);`;

  test('POSITIVE — flagged, and the offence NAMES the route', () => {
    const { offences } = compare(census(source), collectSpecOperations(spec()), new Set(), {}, {});
    const undeclared = offences.filter((o) => o.kind === 'undeclared-route');
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]!.key).toBe(
      'src/server.ts:handleCreateWidget:POST /api/widgets/{widgetId}',
    );
    // A count alone cannot be acted on: the path has to appear in the message.
    expect(undeclared[0]!.reason).toContain('POST /api/widgets/{widgetId}');
  });

  test('NEGATIVE — the SAME route declared in the spec is not flagged, `:x` == `{x}`', () => {
    const ops = collectSpecOperations(
      spec({ path: '/api/widgets/{widgetId}', method: 'post', operationId: 'createWidget' }),
    );
    const result = compare(census(source), ops, new Set(), {}, {});
    expect(result.offences).toEqual([]);
    expect(result.matched).toBe(1);
  });

  test('a PIN suppresses it — and the pin key is site-specific, not path-only', () => {
    const key = 'src/server.ts:handleCreateWidget:POST /api/widgets/{widgetId}';
    const pinned = compare(census(source), collectSpecOperations(spec()), new Set([key]), {}, {});
    expect(pinned.offences).toEqual([]);
    expect(pinned.grandfathered).toBe(1);

    // The path alone must NOT be enough to pin it, or one entry could cover
    // every registration of that path from every file and handler.
    const pathOnly = compare(
      census(source),
      collectSpecOperations(spec()),
      new Set(['POST /api/widgets/{widgetId}']),
      {},
      {},
    );
    expect(pathOnly.offences.some((o) => o.kind === 'undeclared-route')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direction 2: a spec entry with no route
// ---------------------------------------------------------------------------

describe('a spec operation with no registered route is an offence', () => {
  test('POSITIVE — flagged, keyed on the operationId so two ops cannot share one entry', () => {
    const ops = collectSpecOperations(
      spec({ path: '/api/ghosts/{id}', method: 'get', operationId: 'getGhost' }),
    );
    const { offences } = compare(census('// no routes at all\n'), ops, new Set(), {}, {});
    const orphans = offences.filter((o) => o.kind === 'orphan-spec-operation');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.key).toBe('src/capabilities/served-spec.ts:getGhost:GET /api/ghosts/{id}');
  });

  test('an EXEMPT_SPEC_OPERATIONS entry suppresses it — and a STALE one fails', () => {
    const ops = collectSpecOperations(
      spec({ path: '/api/ghosts/{id}', method: 'get', operationId: 'getGhost' }),
    );
    const key = 'src/capabilities/served-spec.ts:getGhost:GET /api/ghosts/{id}';
    expect(
      compare(census('// none\n'), ops, new Set(), {}, { [key]: 'served outside the router' })
        .offences,
    ).toEqual([]);

    // Now the route EXISTS, so the exemption describes nothing. It must be
    // deleted, not left to silently cover a future orphan.
    const stale = compare(
      census(`router.add('GET', '/api/ghosts/:id', handleGetGhost);`),
      ops,
      new Set(),
      {},
      { [key]: 'served outside the router' },
    );
    expect(stale.offences.map((o) => o.kind)).toEqual(['stale-exemption']);
  });

  test('only real HTTP methods count as operations — `parameters` is not one', () => {
    const ops = collectSpecOperations({
      paths: {
        '/api/things': {
          parameters: [{ name: 'q', in: 'query' }],
          summary: 'not an operation',
          get: { operationId: 'listThings', responses: { '200': {} } },
        },
      },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]!.method).toBe('GET');
    expect(HTTP_METHODS).not.toContain('parameters');
  });
});

// ---------------------------------------------------------------------------
// The parameter-name mismatch — the finding the lenient rule cannot see
// ---------------------------------------------------------------------------

describe('a spec that documents a DIFFERENT parameter name is its own finding', () => {
  test('reported as param-name-mismatch, NOT as undeclared/orphan, and not double-counted', () => {
    const ops = collectSpecOperations(
      spec({ path: '/api/projects/{projectId}', method: 'get', operationId: 'getProject' }),
    );
    const { offences } = compare(
      census(`router.add('GET', '/api/projects/:id', handleGetProject);`),
      ops,
      new Set(),
      {},
      {},
    );
    expect(offences.map((o) => o.kind)).toEqual(['param-name-mismatch']);
    expect(offences[0]!.reason).toContain('/api/projects/{id}');
    expect(offences[0]!.reason).toContain('/api/projects/{projectId}');
  });

  test('a PIN cannot suppress it — there is deliberately no allowlist for this class', () => {
    const ops = collectSpecOperations(
      spec({ path: '/api/projects/{projectId}', method: 'get', operationId: 'getProject' }),
    );
    const key = 'src/server.ts:handleGetProject:GET /api/projects/{id}';
    const { offences } = compare(
      census(`router.add('GET', '/api/projects/:id', handleGetProject);`),
      ops,
      new Set([key]),
      { [key]: 'try to exempt it' },
      {},
    );
    expect(offences.some((o) => o.kind === 'param-name-mismatch')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ratchet is two-sided
// ---------------------------------------------------------------------------

describe('a pin that is no longer an undeclared route FAILS until it is deleted', () => {
  test('documenting a pinned route fails as stale-grandfather', () => {
    const source = `router.add('POST', '/api/widgets/:widgetId', handleCreateWidget);`;
    const key = 'src/server.ts:handleCreateWidget:POST /api/widgets/{widgetId}';
    const ops = collectSpecOperations(
      spec({ path: '/api/widgets/{widgetId}', method: 'post', operationId: 'createWidget' }),
    );
    const { offences } = compare(census(source), ops, new Set([key]), {}, {});
    expect(offences.map((o) => o.kind)).toEqual(['stale-grandfather']);
    expect(offences[0]!.key).toBe(key);
  });

  test('a pin whose route was DELETED also fails — the list cannot carry ghosts', () => {
    const key = 'src/server.ts:handleGoneWidget:POST /api/widgets/{widgetId}';
    const { offences } = compare(
      census('// the route was removed\n'),
      collectSpecOperations(spec()),
      new Set([key]),
      {},
      {},
    );
    expect(offences.map((o) => o.kind)).toEqual(['stale-grandfather']);
  });
});

// ---------------------------------------------------------------------------
// Node-facing routes — a pin or an exemption never excuses them (fr v4 2026-10-13)
// ---------------------------------------------------------------------------

describe('a route the n8n node may reach (licence allowlist) can never be grandfathered', () => {
  // The exact shape that hid GET /api/cards/{cardId} and GET /api/approvals/all:
  // registered, licence-allowlisted, declared nowhere, and PINNED. The pre-fix
  // guard returned zero offences for this input (the pin was an unconditional
  // excuse) — run this file against the unfixed checker to see it go red.
  const source = `router.add('GET', '/api/cards/:cardId', handleGetCardAA);`;
  const key = 'src/server.ts:handleGetCardAA:GET /api/cards/{cardId}';
  const nodeFacing = new Set(['GET /api/cards/{cardId}']);

  test('a PINNED node-facing undeclared route is an offence, not debt', () => {
    const { offences, grandfathered } = compare(
      census(source),
      collectSpecOperations(spec()),
      new Set([key]),
      {},
      {},
      nodeFacing,
    );
    expect(offences.map((o) => o.kind)).toEqual(['node-facing-undeclared']);
    expect(offences[0]!.key).toBe(key);
    // ...and the pin is consumed, so it is not ALSO reported stale.
    expect(grandfathered).toBe(0);
  });

  test('an EXEMPT_ROUTES entry does not excuse it either', () => {
    const { offences } = compare(
      census(source),
      collectSpecOperations(spec()),
      new Set(),
      { [key]: 'never document this route — a long enough reason string' },
      {},
      nodeFacing,
    );
    expect(offences.map((o) => o.kind)).toEqual(['node-facing-undeclared']);
  });

  test('declaring it in the spec clears it', () => {
    const { offences, matched } = compare(
      census(source),
      collectSpecOperations(spec({ path: '/api/cards/{cardId}', method: 'get', operationId: 'getCard' })),
      new Set(),
      {},
      {},
      nodeFacing,
    );
    expect(offences).toEqual([]);
    expect(matched).toBe(1);
  });

  test('a pinned route that is NOT node-facing is still ordinary debt', () => {
    const { offences, grandfathered } = compare(
      census(source),
      collectSpecOperations(spec()),
      new Set([key]),
      {},
      {},
      new Set(),
    );
    expect(offences).toEqual([]);
    expect(grandfathered).toBe(1);
  });

  test('the node-facing set is derived from the allowlist pattern spelling (:param → {param})', () => {
    const keys = nodeFacingOperationKeys([
      { method: 'GET', pattern: '/api/cards/:cardId' },
      { method: 'POST', pattern: '/api/webhooks/n8n/report' },
    ]);
    expect([...keys].sort()).toEqual(['GET /api/cards/{cardId}', 'POST /api/webhooks/n8n/report']);
  });

  test('the REAL licence allowlist is non-empty and wholly declared in the real spec', () => {
    // Non-vacuity only: the set equality below is the assertion. No count of the
    // allowlist is pinned — that number moves with every licensed operation.
    expect(NODE_FACING_OPERATIONS.size).toBeGreaterThan(0);
    const declared = new Set(collectSpecOperations().map((o) => operationKey(o.method, o.path)));
    const undeclared = [...NODE_FACING_OPERATIONS].filter((k) => !declared.has(k));
    expect(undeclared).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Key granularity — one entry can never exempt two different things
// ---------------------------------------------------------------------------

describe('two different registrations never collapse onto one key', () => {
  test('same method+path from two files, or two handlers, are two distinct keys', () => {
    const a = siteKey('src/server.ts', 'handleA', 'GET', '/api/x/:id');
    const b = siteKey('src/routes/tools/index.ts', 'handleA', 'GET', '/api/x/:id');
    const c = siteKey('src/server.ts', 'handleB', 'GET', '/api/x/:id');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test('a prettier-wrapped inline arrow key carries no newline and is stable', () => {
    const wrapped = siteKey(
      'src/routes/coding/index.ts',
      '(req: Request, container: string) =>\n    handleGetCodingGraph(req, container)',
      'GET',
      '/api/coding/graphs/:container/augmented',
    );
    expect(wrapped).not.toContain('\n');
    expect(wrapped).toBe(
      siteKey(
        'src/routes/coding/index.ts',
        '(req: Request,   container: string) => handleGetCodingGraph(req, container)',
        'GET',
        '/api/coding/graphs/:container/augmented',
      ),
    );
  });

  test('duplicateKeyError reports a BROKEN GUARD if two sites ever share a key', () => {
    const dup = census(
      `router.add('GET', '/api/x/:id', handleX);\nrouter.add('GET', '/api/x/:id', handleX);`,
    );
    const err = duplicateKeyError(dup);
    expect(err).not.toBeNull();
    expect(err).toContain('src/server.ts:handleX:GET /api/x/{id}');
    // …and the real tree is clean, which is what makes the shipped pins safe.
    expect(duplicateKeyError(collectRoutes())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

describe('a scan of nothing is an ERROR, never a pass', () => {
  test('zero routes parsed fails and names the files it read', () => {
    const err = emptyScanError(census('// nothing here\n'), collectSpecOperations());
    expect(err).not.toBeNull();
    expect(err).toContain('ZERO router.add');
    expect(err).toContain('src/server.ts');
  });

  test('zero spec operations fails — an empty spec would make every route "undeclared"', () => {
    const err = emptyScanError(census(`router.add('GET', '/api/x', handleX);`), []);
    expect(err).not.toBeNull();
    expect(err).toContain('ZERO operations');
  });

  test('the real tree trips NEITHER — so the two controls above are not vacuous', () => {
    expect(emptyScanError(collectRoutes(), collectSpecOperations())).toBeNull();
  });
});

describe('a route whose METHOD is a variable is admitted as unjudgeable, not dropped', () => {
  test('it lands in the dynamic bucket with its site named, and off the site list', () => {
    const c = census(
      `for (const method of ['GET','POST']) {\n  router.add(method, '/api/proxy(.*)', handleProxy);\n}`,
    );
    expect(c.sites).toHaveLength(0);
    expect(c.dynamicMethod).toHaveLength(1);
    expect(c.dynamicMethod[0]).toContain('/api/proxy(.*)');
    expect(c.dynamicMethod[0]).toContain('handleProxy');
  });

  test('the ceiling is two-sided around the measured literal', () => {
    // P4d-2e: the measured literal is 0 (the kag /reviews loop became registry rows), so the two
    // sides are exercised around an explicit ceiling of 1, and the shipped one is pinned at 0.
    expect(MAX_DYNAMIC_METHOD_ROUTES).toBe(0);
    expect(dynamicMethodError({ dynamicMethod: ['x'] } as unknown as RouteCensus)).toContain('above');
    const MAX = 1;
    const at = {
      sites: [],
      dynamicMethod: Array(MAX).fill('x'),
      nonUppercaseMethodLiterals: [],
      filesRead: [],
      accounting: [],
      counterAccountErrors: [],
    };
    expect(dynamicMethodError(at as RouteCensus, MAX)).toBeNull();
    const over = { ...at, dynamicMethod: [...at.dynamicMethod, 'y'] };
    expect(dynamicMethodError(over as RouteCensus, MAX)).toContain('above');
    const under = { ...at, dynamicMethod: at.dynamicMethod.slice(1) };
    expect(dynamicMethodError(under as RouteCensus, MAX)).toContain('fell to');
  });

  test('the real tree holds exactly the measured number', () => {
    expect(collectRoutes().dynamicMethod).toHaveLength(MAX_DYNAMIC_METHOD_ROUTES);
  });
});

// ---------------------------------------------------------------------------
// ⭐ THE CHECK THAT MAKES THE CEILINGS ABOVE MEAN ANYTHING
//
// Every test above this line drives a form `parseRouteTable` can PARSE. The two
// forms it silently DROPS reached no bucket at all, so `dynamicMethodError`
// could not see them and the guard printed OK with the route missing from its
// own denominator. ⚠️ Note what the pre-existing dynamic-method test above uses
// as its variable: the identifier `method` — the ONE spelling that survives the
// `/^[A-Za-z]+$/` filter and therefore the one spelling that could never have
// exposed this. These tests deliberately use `req.method` and a variable PATH.
// ---------------------------------------------------------------------------

describe('a route the parser DROPS fails the guard as BROKEN, not as an offence', () => {
  test('CONTROL: a fully literal registration is accounted for, so the checks below are not vacuous', () => {
    const c = census(`router.add('POST', '/api/literal', handleLiteral);`);
    expect(c.accounting).toEqual([acc('src/server.ts', 1, 1)]);
    expect(routeAccountingError(c)).toBeNull();
  });

  test('a VARIABLE PATH is a discarded route — the class with no ceiling at all', () => {
    const c = census(
      `const P = '/api/variable-path';\nrouter.add('POST', P, handleVariablePath);`,
    );
    // The row is in NO bucket — this is the whole defect, asserted directly.
    expect(c.sites).toHaveLength(0);
    expect(c.dynamicMethod).toHaveLength(0);
    // ... yet the file plainly contains one call site.
    expect(c.accounting).toEqual([acc('src/server.ts', 1, 0)]);
    const err = routeAccountingError(c);
    expect(err).not.toBeNull();
    expect(err).toContain('src/server.ts');
    expect(err).toContain('expected 1 .add(...) call site(s)');
    expect(err).toContain('parser accounted for 0');
    expect(err).toContain('SILENTLY DISCARDED');
  });

  test('a NON-ALPHABETIC non-literal METHOD is a discarded route, not a dynamic-method row', () => {
    // ⛔ `req.method` never reaches the dynamicMethod bucket: /^[A-Za-z]+$/
    // rejects the dot. Rewriting server.ts:1791 as
    // `for (const m of HTTP_VERBS) router.add(m, …)` would likewise have removed
    // five live routes from the census while still printing `1 unjudgeable`.
    for (const expr of ['req.method', 'HTTP_VERBS[i]', 'm2', '_method', 'methodName2']) {
      const c = census(`router.add(${expr}, '/api/dyn', handleDyn);`);
      const parsedAsDynamic = c.dynamicMethod.length + c.sites.length;
      // Only a purely alphabetic identifier survives; the rest vanish.
      const survives = /^[A-Za-z]+$/.test(expr);
      expect(parsedAsDynamic).toBe(survives ? 1 : 0);
      const err = routeAccountingError(c);
      if (survives) {
        expect(err).toBeNull();
      } else {
        expect(err).not.toBeNull();
        expect(err).toContain('parser accounted for 0');
      }
    }
  });

  test('POSITIVE CONTROL for that loop: the alphabetic spelling really is admitted', () => {
    // Same instrument, non-zero result — otherwise the zeros above could be a
    // broken census helper rather than a real drop.
    const c = census(`router.add(verb, '/api/dyn', handleDyn);`);
    expect(c.dynamicMethod).toHaveLength(1);
    expect(routeAccountingError(c)).toBeNull();
  });

  test('accounting is PER FILE, so one file over-counting cannot mask another under-counting', () => {
    // A total would be 2 == 2 and pass. The per-file rows are the claim.
    const c: RouteCensus = {
      sites: [],
      dynamicMethod: [],
      nonUppercaseMethodLiterals: [],
      filesRead: ['a.ts', 'b.ts'],
      accounting: [acc('a.ts', 1, 2), acc('b.ts', 1, 0)],
      counterAccountErrors: [],
    };
    const total = c.accounting.reduce((n, a) => n + a.callSites - a.parsedRows, 0);
    expect(total).toBe(0); // a total-only check would see nothing
    const err = routeAccountingError(c);
    expect(err).not.toBeNull();
    expect(err).toContain('a.ts');
    expect(err).toContain('invented rows');
    expect(err).toContain('b.ts');
    expect(err).toContain('SILENTLY DISCARDED');
  });

  test('a commented-out or stringified router.add cannot create a false mismatch', () => {
    // Neither the counter nor the parser strips comments, deliberately — so a
    // commented call is counted AND parsed, and the two still agree. A counter
    // that stripped comments would red this tree forever.
    const c = census(
      `// router.add('GET', '/api/commented', handleCommented);\n` +
        `router.add('GET', '/api/real', handleReal);`,
    );
    expect(c.accounting[0]!.callSites).toBe(2);
    expect(c.accounting[0]!.parsedRows).toBe(2);
    expect(routeAccountingError(c)).toBeNull();
  });

  test('the REAL tree accounts for every call site — the control that makes a red meaningful', () => {
    const c = collectRoutes();
    expect(routeAccountingError(c)).toBeNull();
    // fr-agui P4d-2d: src/server.ts is the ONLY registering file left (routes/tools/index.ts and routes/coding/index.ts
    // registered their last rows until P4d-2d declared them; the delegated-file census is pinned by its own tests).
    expect(c.accounting.map((a) => a.file)).toEqual(['src/server.ts']);
    for (const a of c.accounting) expect(a.callSites).toBe(a.parsedRows);
    // P4d-2e: every route is a registry row (deriveRouter refuses a router that already
    // holds one), so the literal `router.add` count is ZERO. That zero is an invariant,
    // not a size: a non-zero count is always a defect, never a number to bump.
    const callSites = c.accounting.reduce((n, a) => n + a.callSites, 0);
    expect(callSites).toBe(0);
    // The census table is now the capability-derived rows; the derived equality is the
    // assertion (no floor, no count of the route surface).
    expect(c.sites.length).toBe(c.capabilityDerived!);
  });
});

// ---------------------------------------------------------------------------
// ⭐ THE BYPASS THAT IS UPSTREAM OF THE PARSER — the one accounting could not see
//
// Until 2026-09-27 numerator and denominator were the SAME regex (`router.add(`)
// on the same text. That makes a commented-out call harmless, and it makes the
// invariant STRUCTURALLY BLIND to a registration neither side matches. MEASURED
// on the real `src/server.ts`, each appended then restored — every one of these
// resolves through `router.match()`, so every one is a LIVE route:
//
//   router.add('POST', '/api/probe', h)        -> EXIT 1, route named  (CONTROL)
//   const alias = router; alias.add(…)         -> EXIT 0, census 740
//   router NEWLINE .add(…)                     -> EXIT 0, census 740
//   router['add'](…)                           -> EXIT 0, census 740
//   router?.add(…)                             -> EXIT 0, census 740
//   router . add(…) / router/* c */.add(…)     -> EXIT 0
//
// and, needing no intent whatsoever, a delegated route file whose router
// PARAMETER is named `r`: the guard READ the file, LISTED it in filesRead, and
// printed `…=0/0` — perfect accounting over a live undeclared route.
//
// The denominator is now receiver-agnostic. ⛔ None of the 47 tests before this
// PR wrote the call any way but `router.add(`, which is exactly why the class
// survived a 32-test suite and an audit.
// ---------------------------------------------------------------------------

describe('a registration whose RECEIVER is not spelled `router` fails as BROKEN', () => {
  const REAL = `router.add('GET', '/api/real-literal', handleReal);\n`;

  const spellings: Array<[label: string, code: string]> = [
    ['an alias variable', `const aliasRouter = router;\naliasRouter.add('POST', '/api/audit-alias-probe', h);`],
    ['a computed member', `router['add']('POST', '/api/audit-bracket-probe', h);`],
    ['a line break before .add', `router\n  .add('POST', '/api/audit-newline-probe', h);`],
    ['an optional chain', `router?.add('POST', '/api/audit-optional-probe', h);`],
    ['spaces around the dot', `router . add('POST', '/api/audit-spaced-probe', h);`],
    ['a comment inside the member expression', `router/* c */.add('POST', '/api/audit-comment-probe', h);`],
  ];

  for (const [label, code] of spellings) {
    test(`${label} is a MISMATCH, not an invisible pass`, () => {
      const c = census(REAL + code);
      // NON-VACUITY: the narrow parser pattern genuinely does not match this
      // spelling — so the red below comes from the WIDENED denominator and not
      // from some unrelated parse failure.
      expect((code.match(/router\.add\s*\(/g) ?? []).length).toBe(0);
      expect(c.sites).toHaveLength(1); // only the literal control route parsed
      expect(c.dynamicMethod).toHaveLength(0);
      expect(c.accounting).toEqual([acc('src/server.ts', 2, 1)]);
      const err = routeAccountingError(c);
      expect(err).not.toBeNull();
      expect(err).toContain('expected 2 .add(...) call site(s)');
      expect(err).toContain('parser accounted for 1');
      expect(err).toContain('SILENTLY DISCARDED');
      // The remedy for THIS class, named in the message.
      expect(err).toContain('THE RECEIVER IS NOT SPELLED');
    });
  }

  test('POSITIVE CONTROL: the plain `router.add(` spelling of the same route is accounted for', () => {
    // Same instrument, opposite result — otherwise the six reds above could be a
    // denominator that reds on everything.
    const c = census(REAL + `router.add('POST', '/api/audit-alias-probe', h);`);
    expect(c.accounting).toEqual([acc('src/server.ts', 2, 2)]);
    expect(routeAccountingError(c)).toBeNull();
  });

  test('⭐ a DELEGATED route file whose parameter is named `r` is a MISMATCH (it printed 0/0)', () => {
    const DELEGATED = 'src/routes/auditprobe/index.ts';
    const serverSource = REAL + `registerAuditProbeRoutes(router);\n`;
    const subject = collectRoutes({
      serverSource,
      handlerFiles: [
        {
          path: DELEGATED,
          content:
            `export function registerAuditProbeRoutes(r: Router): void {\n` +
            `  r.add('GET', '/api/audit-delegated-probe', handleProbe);\n` +
            `}\n`,
        },
      ],
    });
    // The file IS found and read — that is what made the old `0/0` so bad.
    expect(subject.filesRead).toContain(DELEGATED);
    const row = subject.accounting.find((a) => a.file === DELEGATED);
    expect(row).toEqual(acc(DELEGATED, 1, 0));
    const err = routeAccountingError(subject);
    expect(err).not.toBeNull();
    expect(err).toContain(DELEGATED);
    expect(err).toContain('parser accounted for 0');
    expect(err).toContain('DELEGATED route file whose router parameter is named');
  });

  test('POSITIVE CONTROL: the SAME delegated file with the parameter named `router` passes', () => {
    // The three delegated files on this tree all happen to write `router`, and
    // nothing anywhere enforces that. This control proves the test above is
    // measuring the PARAMETER NAME and not the delegation machinery.
    const DELEGATED = 'src/routes/auditprobe/index.ts';
    const control = collectRoutes({
      serverSource: REAL + `registerAuditProbeRoutes(router);\n`,
      handlerFiles: [
        {
          path: DELEGATED,
          content:
            `export function registerAuditProbeRoutes(router: Router): void {\n` +
            `  router.add('GET', '/api/audit-delegated-probe', handleProbe);\n` +
            `}\n`,
        },
      ],
    });
    expect(control.filesRead).toContain(DELEGATED);
    expect(control.accounting.find((a) => a.file === DELEGATED)).toEqual(acc(DELEGATED, 1, 1));
    expect(routeAccountingError(control)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The denominator's one exception list, and its rot-check
// ---------------------------------------------------------------------------

describe('NON_REGISTRATION_ADD_CALLS deducts VISIBLY and rots when its text moves', () => {
  const PROSE = "`(.*)` survives Router.add()'s";
  // The entry the list shipped until P4d-2e (the prose above the kag /reviews loop), kept as the
  // FIXTURE the rot-check mechanics below are exercised with.
  const FIXTURE_ACCOUNTS = [{ file: 'src/server.ts', text: PROSE, reason: 'PROSE, not a call (fixture)' }];

  test('the shipped list is EMPTY: P4d-2e removed the loop its one entry described', () => {
    // A measurement of this tree: src/server.ts holds no `.add(` at all any more.
    expect(NON_REGISTRATION_ADD_CALLS).toEqual([]);
  });

  test('POSITIVE CONTROL: present exactly once and containing .add( -> deducts 1, no error', () => {
    const r = applyNonRegistrationAccounts(
      'src/server.ts',
      `// a comment that says ${PROSE} escaping\nrouter.add('GET', '/api/x', h);`,
      FIXTURE_ACCOUNTS,
    );
    expect(r).toEqual({ deducted: 1, errors: [] });
  });

  test('text that is GONE is a stale entry, not a silent zero deduction', () => {
    const r = applyNonRegistrationAccounts('src/server.ts', `router.add('GET', '/api/x', h);`, FIXTURE_ACCOUNTS);
    expect(r.deducted).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('NO LONGER IN THE FILE');
  });

  test('text that occurs TWICE cannot say which occurrence it accounts for', () => {
    const r = applyNonRegistrationAccounts('src/server.ts', `${PROSE}\n${PROSE}\n`, FIXTURE_ACCOUNTS);
    expect(r.deducted).toBe(0);
    expect(r.errors[0]).toContain('occurs 2 times');
  });

  test('an entry whose text holds no .add( at all accounts for nothing', () => {
    const r = applyNonRegistrationAccounts(
      'src/server.ts',
      'the quick brown fox',
      [{ file: 'src/server.ts', text: 'quick brown', reason: 'deliberately wrong snippet' }],
    );
    expect(r.deducted).toBe(0);
    expect(r.errors[0]).toContain('accounts for nothing');
  });

  test('a stale entry fails the guard as BROKEN, and the deduction cannot shrink the denominator', () => {
    const c = collectRoutes({
      serverSource: `router.add('GET', '/api/x', h);`,
      handlerFiles: [],
      nonRegistrationAccounts: FIXTURE_ACCOUNTS,
    });
    expect(c.counterAccountErrors).toHaveLength(1);
    const err = counterAccountError(c);
    expect(err).not.toBeNull();
    expect(err).toContain('cannot be');
    expect(err).toContain('NO LONGER IN THE FILE');
    // NOT deducted: an untrustworthy entry must never reduce the count.
    expect(c.accounting[0]!.accountedNonRegistrations).toBe(0);
    expect(c.accounting[0]!.callSites).toBe(1);
    // ⛔ AND it must travel through the ONE fail-closed gate main() actually
    // consults. A second `if` in main() for this would be an unreachable branch:
    // the exception list is OFF in fixture mode, so no CLI test could kill it.
    const viaTheGate = routeAccountingError(c);
    expect(viaTheGate).not.toBeNull();
    expect(viaTheGate).toContain('NO LONGER IN THE FILE');
  });

  test('the REAL tree: the list is clean and deducts nothing (P4d-2e: no `.add(` left in src/server.ts)', () => {
    const c = collectRoutes();
    expect(counterAccountError(c)).toBeNull();
    const server = c.accounting.find((a) => a.file === 'src/server.ts');
    expect(server!.accountedNonRegistrations).toBe(0);
    expect(server!.rawAddCallSites).toBe(0);
    expect(server!.callSites).toBe(server!.parsedRows);
    // Non-zero, same instrument: a synthetic tree turns the list OFF entirely.
    expect(census(`router.add('GET', '/api/x', h);`).counterAccountErrors).toHaveLength(0);
  });

  test('⚠️ THE COST, PINNED: a commented-out NON-`router` .add( now reds, and the remedy is an entry', () => {
    // Stated so it is a known trade and not a surprise. Widening the denominator
    // buys the seven live bypasses at the price of counting `.add(` text that is
    // not a registration — prose, a `Set.add`, a commented-out alias call. The
    // remedy is ONE reviewable entry, never narrowing the denominator back.
    const c = census(
      `router.add('GET', '/api/real', handleReal);\n` +
        `// aliasRouter.add('GET', '/api/commented-alias', handleX);\n`,
    );
    expect(c.accounting).toEqual([acc('src/server.ts', 2, 1)]);
    expect(routeAccountingError(c)).toContain('SILENTLY DISCARDED');
    // ... and the entry fixes it, visibly, with the deduction reported.
    const accounted = collectRoutes({
      serverSource:
        `router.add('GET', '/api/real', handleReal);\n` +
        `// aliasRouter.add('GET', '/api/commented-alias', handleX);\n`,
      handlerFiles: [],
      nonRegistrationAccounts: [
        {
          file: 'src/server.ts',
          text: "// aliasRouter.add('GET', '/api/commented-alias', handleX);",
          reason: 'commented out, therefore registers nothing',
        },
      ],
    });
    expect(accounted.accounting).toEqual([acc('src/server.ts', 1, 1, 1)]);
    expect(routeAccountingError(accounted)).toBeNull();
  });

  test('⭐ a commented-out `router.add` stays harmless — the same-text property survived the widening', () => {
    // The widening only ADDS matches, so a `router.add` inside a comment is still
    // BOTH counted and parsed and the two still agree. Narrowing or comment-
    // stripping either side would break this.
    const c = census(
      `// router.add('GET', '/api/commented', handleCommented);\n` +
        `router.add('GET', '/api/real', handleReal);`,
    );
    expect(c.accounting).toEqual([acc('src/server.ts', 2, 2)]);
    expect(routeAccountingError(c)).toBeNull();
  });

  test('a synthetic source turns the exception list OFF, the way pins and exemptions are off', () => {
    // Otherwise every fixture and every synthetic test in this file would red
    // with "text no longer in the file" — an entry describes the REAL server.ts.
    const c = census(`router.add('GET', '/api/x', h);`);
    expect(c.counterAccountErrors).toEqual([]);
    expect(c.accounting[0]!.accountedNonRegistrations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ⚠️ AN ACCEPTED BLIND SPOT, PINNED SO IT CANNOT BE FORGOTTEN OR OVER-CLAIMED
//
// Neither the parser nor the denominator strips comments — that is what keeps a
// commented-out `router.add` from red-ing the accounting check forever. The price
// is that COMMENTING OUT a declared registration defeats the dead-docs direction:
// MEASURED on `src/server.ts:1089`, DELETING the line exits 1 with
// `[orphan-spec-operation] GET /api/projects` and a census of 739, while
// COMMENTING IT OUT exits 0 with the route still among the 66 `declared`.
//
// This test pins that behaviour rather than asserting it is good. ⛔ If it ever
// goes RED because the parser became comment-aware, that is an IMPROVEMENT — but
// the "COMMENTED-OUT REGISTRATION" bullet in the guard's header must be deleted in
// the same change, and `countAddCallSites`'s same-text guarantee re-measured.
// ---------------------------------------------------------------------------

describe('a COMMENTED-OUT registration is invisible as dead — the blind spot, pinned', () => {
  const OP = { path: '/api/blind-spot', method: 'get', operationId: 'getBlindSpot' };

  test('CONTROL: DELETING the registration makes the spec operation an orphan', () => {
    const { offences } = compare(census(''), collectSpecOperations(spec(OP)), new Set(), {}, {});
    expect(offences.map((o) => o.kind)).toContain('orphan-spec-operation');
    expect(offences.some((o) => o.key.endsWith('GET /api/blind-spot'))).toBe(true);
  });

  test('SUBJECT: COMMENTING it out leaves the spec operation looking DECLARED', () => {
    const c = census(`// router.add('GET', '/api/blind-spot', handleBlindSpot);`);
    const { offences, matched } = compare(
      c,
      collectSpecOperations(spec(OP)),
      new Set(),
      {},
      {},
    );
    // The commented line is parsed into a census row and matched to the spec.
    expect(c.sites).toHaveLength(1);
    expect(matched).toBe(1);
    expect(offences).toHaveLength(0);
    // ... and the accounting check agrees, because both sides saw the comment.
    expect(routeAccountingError(c)).toBeNull();
  });
});

describe('a method literal that is not UPPER CASE is a dead route, so the guard refuses to judge it', () => {
  test("router.add('get', …) is reported, not silently normalised to GET", () => {
    // src/utils/router.ts:26 compares route.method !== method case-sensitively
    // against the upper-case req.method, so this row matches no request. Left
    // alone, operationKey would upper-case it and MATCH it to the spec's `get`
    // operation: a green line for a route that 404s.
    const c = census(`router.add('get', '/api/lower', handleLower);`);
    expect(c.nonUppercaseMethodLiterals).toHaveLength(1);
    expect(c.nonUppercaseMethodLiterals[0]).toContain("'get'");
    expect(c.nonUppercaseMethodLiterals[0]).toContain('/api/lower');
    // Still accounted for — refusing to judge must not mean discarding.
    expect(routeAccountingError(c)).toBeNull();
    const err = nonUppercaseMethodError(c);
    expect(err).not.toBeNull();
    expect(err).toContain('NOT UPPER CASE');
    expect(err).toContain('src/utils/router.ts:26');
  });

  test('mixed case is caught too, and UPPER CASE is not', () => {
    expect(nonUppercaseMethodError(census(`router.add('Get', '/api/x', h);`))).not.toBeNull();
    expect(nonUppercaseMethodError(census(`router.add('GET', '/api/x', h);`))).toBeNull();
  });

  test('the REAL tree has none — so the checks above are not describing main', () => {
    const c = collectRoutes();
    expect(c.nonUppercaseMethodLiterals).toEqual([]);
    // Positive control on the same field: the instrument CAN populate it.
    expect(census(`router.add('get', '/api/x', h);`).nonUppercaseMethodLiterals).toHaveLength(1);
  });
});

describe('the pin list is consumed as a Set, which dedupes silently', () => {
  test('a duplicated entry fails the guard as BROKEN and names the duplicate', () => {
    const err = grandfatherDuplicateError(['a:b:GET /x', 'c:d:GET /y', 'a:b:GET /x']);
    expect(err).not.toBeNull();
    expect(err).toContain('3 entr');
    expect(err).toContain('only\n2 distinct');
    expect(err).toContain('a:b:GET /x');
  });

  test('the SHIPPED list is clean: array length equals set size', () => {
    expect(grandfatherDuplicateError()).toBeNull();
    // The assertion stated directly, not only via the helper.
    const dumped = [...GRANDFATHERED_UNDECLARED];
    expect(dumped.length).toBe(GRANDFATHERED_UNDECLARED.size);
    // ⛔ DO NOT re-add an absolute `.toBe(<n>)` here. This test's invariant is
    // DEDUPE, and an absolute pin count reds it for a reason that has nothing to
    // do with its name: #1267 removed 4 verification routes, their 4 stale pins
    // were correctly DELETED, and a `.toBe(674)` then failed a test called
    // "array length equals set size" — sending the reader to a dedupe bug that
    // did not exist. Magnitude is already covered, and better, twice over:
    // `> 500` below, and `every pinned route ACTUALLY EXISTS in the tree today`,
    // which compares against the LIVE route table (a foreign denominator) and is
    // what catches a pin whose route was removed.
  });
});

// ---------------------------------------------------------------------------
// The shipped baseline is a measurement, not a blank cheque
// ---------------------------------------------------------------------------

describe('the shipped pin list and exemptions describe THIS tree', () => {
  test('the pin list is EMPTY (P4d-2e), and any entry is shaped like a real site key', () => {
    // A guard whose baseline is `[]` or whose keys are unparseable would pass
    // every other test in this file.
    // 455 after fr-agui P4a2, 397 after P4a3, 288 after P4b part 3, 243 after P4c part 1, 200 after P4c part 2, 149 after
    // P4c part 3; the spec drain lowers it unit by unit.
    // (LEGACY_UNDECLARED is GRANDFATHERED_UNDECLARED), so this floor only guards the empty / unparseable
    // list (lowered 100 → 50 by P4d-2b, which left 99; 50 → 20 by P4d-2c, which left 39; 20 → 5 by P4d-2d, which left 8).
    // P4d-2e: the drain is COMPLETE — the pin list is exactly empty (two-sided: a new pin is a
    // new undeclared route, which compare() refuses anyway). Its shape check stays for any future entry.
    expect(GRANDFATHERED_UNDECLARED.size).toBe(0);
    for (const key of GRANDFATHERED_UNDECLARED) {
      expect(key).toMatch(/^src\/[^:]+\.ts:.+:[A-Z]+ \//);
      expect(key).not.toContain('\n');
    }
  });

  test('every pinned route is a route that ACTUALLY EXISTS in the tree today', () => {
    const live = new Set(collectRoutes().sites.map((s) => s.key));
    const ghosts = [...GRANDFATHERED_UNDECLARED].filter((k) => !live.has(k));
    expect(ghosts).toEqual([]);
  });

  test('the exemption list is not a silent second pin list', () => {
    // Each exemption must carry a REASON string with evidence, not an empty
    // marker — an exemption with no reason is an exemption nobody can review.
    for (const [key, reason] of Object.entries(EXEMPT_SPEC_OPERATIONS)) {
      expect(key).toMatch(/^src\/capabilities\/served-spec\.ts:.+:[A-Z]+ \//);
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).toMatch(/src\/[^\s]+:\d+/); // a file:line, not a vibe
    }
    // P4d-2e: EXEMPT_ROUTES (routes with no operation) is exactly the specExempt
    // passthrough rows, each with the declaration's reason. The per-entry shape
    // loop below is the assertion; no count — a new passthrough route must not
    // red this test.
    for (const [key, reason] of Object.entries(EXEMPT_ROUTES)) {
      expect(key).toMatch(/^src\/capabilities\/kag\/reviews-passthrough\.ts:kag\.reviews_passthrough_[a-z]+:[A-Z]+ \/api\/assets\/kag\/reviews\(\.\*\)$/);
      expect(reason).toContain('passthrough');
    }
  });

  test('the real tree is clean under the shipped lists — the guard is green on main', () => {
    const { offences } = compare(collectRoutes(), collectSpecOperations());
    expect(offences).toEqual([]);
  });
});

describe('operationKey', () => {
  test('upper-cases the method and normalises the path in one step', () => {
    expect(operationKey('get', '/api/x/:id/')).toBe('GET /api/x/{id}');
  });
});

describe('parseArgs', () => {
  test('recognises --dump and the fixture seam, and defaults to neither', () => {
    expect(parseArgs([])).toEqual({ dump: false });
    expect(parseArgs(['--dump']).dump).toBe(true);
    expect(parseArgs(['--route-table-file=/tmp/x.ts']).routeTableFile).toBe('/tmp/x.ts');
  });
});

// ---------------------------------------------------------------------------
// The CI invocation path — the one thing no in-process call can see
// ---------------------------------------------------------------------------

describe('the CI invocation path', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'route-spec-guard-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runCli(...args: string[]): { exitCode: number; out: string } {
    const proc = Bun.spawnSync(['bun', 'run', GUARD, ...args], { cwd: BACKEND_DIR });
    return {
      exitCode: proc.exitCode,
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  }

  test('⛔ the real CLI still runs under `bun run` — import.meta.main is live', () => {
    // ⛔ Do NOT reduce this to `expect(exitCode).toBe(0)`: a guard whose
    // entrypoint was mutated to `if (false)` also exits 0, printing nothing.
    // The OK marker AND its denominator are what kill that mutant.
    const { exitCode, out } = runCli();
    expect(out).toContain('[check-route-spec-coverage] OK:');
    const sites = Number(out.match(/OK: (\d+) route site\(s\) parsed/)?.[1]);
    expect(sites).toBe(collectRoutes().sites.length);
    const ops = Number(out.match(/vs (\d+) operation\(s\)/)?.[1]);
    expect(ops).toBe(collectSpecOperations().length);
    expect(exitCode).toBe(0);
  });

  test('the same entrypoint FAILS non-zero on an undeclared route, through the process boundary', async () => {
    // The other polarity, through the real program rather than a function call.
    const fixture = join(dir, 'fixture-server.ts');
    await writeFile(
      fixture,
      `router.add('POST', '/api/definitely-not-in-the-spec/:widgetId', handleFixtureRoute);\n`,
      'utf8',
    );
    const { exitCode, out } = runCli(`--route-table-file=${fixture}`);
    expect(exitCode).toBe(EXIT_OFFENCES);
    expect(out).toContain('[check-route-spec-coverage] FAIL:');
    expect(out).toContain('undeclared-route');
    expect(out).toContain('POST /api/definitely-not-in-the-spec/{widgetId}');
    // A fixture run must be unmistakable in a log.
    expect(out).toContain('FIXTURE RUN');
    expect(out).not.toContain('] OK:');
  });

  test('⛔ a VARIABLE PATH exits 2 through the real process boundary, naming file and counts', async () => {
    // MEASURED before this check existed: appending this exact shape to the real
    // src/server.ts left the printed total UNCHANGED at 740 and exited 0.
    const fixture = join(dir, 'variable-path-server.ts');
    await writeFile(
      fixture,
      `router.add('GET', '/api/real-literal', handleReal);\n` +
        `const P = '/api/audit-variable-probe';\n` +
        `router.add('POST', P, handleVariablePath);\n`,
      'utf8',
    );
    const { exitCode, out } = runCli(`--route-table-file=${fixture}`);
    expect(exitCode).toBe(EXIT_BROKEN_GUARD);
    expect(out).toContain('SILENTLY DISCARDED');
    expect(out).toContain('expected 2 .add(...) call site(s)');
    expect(out).toContain('parser accounted for 1');
    expect(out).toContain('src/server.ts'); // the file the census attributes it to
    expect(out).not.toContain('] OK:');
  });

  test('⛔ a NON-ALPHABETIC non-literal METHOD exits 2 too — req.method, not `method`', async () => {
    // The spelling the pre-existing dynamic-method test could not have caught.
    const fixture = join(dir, 'req-method-server.ts');
    await writeFile(
      fixture,
      `router.add('GET', '/api/real-literal', handleReal);\n` +
        `router.add(req.method, '/api/audit-dynmethod-probe', handleDyn);\n`,
      'utf8',
    );
    const { exitCode, out } = runCli(`--route-table-file=${fixture}`);
    expect(exitCode).toBe(EXIT_BROKEN_GUARD);
    expect(out).toContain('SILENTLY DISCARDED');
    expect(out).toContain('expected 2 .add(...) call site(s)');
    expect(out).toContain('parser accounted for 1');
    expect(out).not.toContain('] OK:');
  });

  test('⛔ an ALIAS receiver exits 2 through the real process boundary', async () => {
    // MEASURED before the denominator was widened: appending this exact shape to
    // the real src/server.ts exited 0, census unchanged at 740, under the printed
    // line `all 741 router.add(...) call site(s) accounted for` — while
    // router.match('POST', '/api/audit-alias-probe') resolved it.
    const fixture = join(dir, 'alias-receiver-server.ts');
    await writeFile(
      fixture,
      `router.add('GET', '/api/real-literal', handleReal);\n` +
        `const auditRouter = router;\n` +
        `auditRouter.add('POST', '/api/audit-alias-probe', handleAliasProbe);\n`,
      'utf8',
    );
    const { exitCode, out } = runCli(`--route-table-file=${fixture}`);
    expect(exitCode).toBe(EXIT_BROKEN_GUARD);
    expect(out).toContain('SILENTLY DISCARDED');
    expect(out).toContain('expected 2 .add(...) call site(s)');
    expect(out).toContain('parser accounted for 1');
    expect(out).toContain('THE RECEIVER IS NOT SPELLED');
    expect(out).not.toContain('] OK:');
  });

  test('⛔ a COMPUTED member `router[\'add\'](…)` exits 2 through the real process boundary', async () => {
    const fixture = join(dir, 'computed-member-server.ts');
    await writeFile(
      fixture,
      `router.add('GET', '/api/real-literal', handleReal);\n` +
        `router['add']('POST', '/api/audit-bracket-probe', handleBracketProbe);\n`,
      'utf8',
    );
    const { exitCode, out } = runCli(`--route-table-file=${fixture}`);
    expect(exitCode).toBe(EXIT_BROKEN_GUARD);
    expect(out).toContain('SILENTLY DISCARDED');
    expect(out).toContain('expected 2 .add(...) call site(s)');
    expect(out).toContain('parser accounted for 1');
    expect(out).not.toContain('] OK:');
  });

  test('⭐ --dump over a LOSSY fixture exits 2 and prints NO pin list', async () => {
    // The ⭐ claim in main() is that the accounting check runs BEFORE --dump, so a
    // baseline can never be regenerated from a parse that dropped rows.
    // ⛔ MEASURED: mutating that branch to `if (accounting !== null && !opts.dump)`
    // left the suite at 47 pass / 0 fail. This test is the only thing that dies:
    // rc flips 2 -> 0 and the pin list prints from the lossy parse.
    const fixture = join(dir, 'dump-lossy-server.ts');
    await writeFile(
      fixture,
      `router.add('GET', '/api/real-literal', handleReal);\n` +
        `const P = '/api/audit-dump-probe';\n` +
        `router.add('POST', P, handleVariablePath);\n`,
      'utf8',
    );
    const { exitCode, out } = runCli('--dump', `--route-table-file=${fixture}`);
    expect(exitCode).toBe(EXIT_BROKEN_GUARD);
    expect(out).toContain('SILENTLY DISCARDED');
    // ⛔ The pin list must not have been written at all — a partial dump a human
    // pastes back is worse than no dump.
    expect(out).not.toContain('function GRANDFATHERED_UNDECLARED_DATA()');
    expect(out).not.toContain('  return [');
  });

  test('POSITIVE CONTROL: --dump over a CLEAN fixture still emits the pin list and exits 0', async () => {
    // Same flag, same seam, opposite result — otherwise the test above could be
    // passing because --dump is broken outright.
    const fixture = join(dir, 'dump-clean-server.ts');
    await writeFile(
      fixture,
      `router.add('POST', '/api/audit-dump-clean-probe', handleDumpClean);\n`,
      'utf8',
    );
    const { exitCode, out } = runCli('--dump', `--route-table-file=${fixture}`);
    expect(exitCode).toBe(0);
    expect(out).toContain('function GRANDFATHERED_UNDECLARED_DATA()');
    expect(out).toContain('POST /api/audit-dump-clean-probe');
    expect(out).not.toContain('SILENTLY DISCARDED');
  });

  test('the OK line deducts NOTHING once the exception list is empty (P4d-2e), and says the denominator is receiver-agnostic', () => {
    // Until P4d-2e this asserted the one deduction was SHOWN as arithmetic (`src/server.ts N-1=M`). The list is
    // empty now (NON_REGISTRATION_ADD_CALLS above), so a green run must carry no deduction note at all — a
    // deduction appearing here would be an entry nobody reviewed. The arithmetic itself stays pinned by the
    // fixture-driven applyNonRegistrationAccounts tests above.
    const { out, exitCode } = runCli();
    expect(exitCode).toBe(0);
    expect(out).not.toContain('DEDUCTED as NOT a registration');
    expect(out).toContain('RECEIVER-AGNOSTIC');
  });

  test('the OK line says CALL SITES out loud, so 1 unjudgeable cannot be read as 1 route', () => {
    const { out } = runCli();
    expect(out).toContain('unjudgeable CALL SITE(s)');
    expect(out).toContain('NOT ROUTES');
    expect(out).toContain('registered FIVE through one router.add');
    // The accounting denominator is printed, per file, on a green run too.
    expect(out).toMatch(/all \d+ \.add\(\.\.\.\) call site\(s\) accounted for/);
    // ⚠️ Same correction as the deduction test above: this pinned `src/server.ts=692/692`
    // and would red on the next route added anywhere. The property that matters is that
    // the per-file accounting is PRINTED and BALANCES — expected equals accounted — which
    // is exactly what would break if the parser silently dropped a row. Pin the balance.
    const perFile = out.match(/src\/server\.ts=(\d+)\/(\d+)/);
    expect(perFile).not.toBeNull();
    expect(Number(perFile![1])).toBe(Number(perFile![2]));
    // P4d-2e: server.ts registers nothing itself (0/0); the table is the capability-derived rows.
    expect(Number(perFile![1])).toBe(0);
    const derived = out.match(/plus (\d+) capability-derived route\(s\)/);
    // Derived: the printed count must be the census's own count. No floor.
    expect(Number(derived?.[1])).toBe(collectRoutes().capabilityDerived!);
  });

  test('the broken-guard exit code is distinct from the offence code', () => {
    // Two different codes so a caller can tell "found something" from
    // "could not look" — the distinction the fail-closed branches rely on.
    expect(EXIT_BROKEN_GUARD).not.toBe(EXIT_OFFENCES);
  });
});
