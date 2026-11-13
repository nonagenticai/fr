// e2e/lanes/sweep/route-ids.unit.test.ts
//
// These lock in the ONE property that makes the route sweep honest: a route it
// cannot resolve with a REAL measured id is refused, not faked. A fabricated id
// renders the app's 404 page, and a sweep that visits it either banks the route
// as clean or files an app defect that is really an instrument defect.
//
// The negative cases are the important ones. `null` is the contract; any change
// that starts returning a placeholder, a partial path, or an empty segment turns
// the whole sweep's coverage number into fiction.
//
// The coverage + disjointness cases guard the binding TABLE rather than the
// function: a typo'd routeId key is otherwise completely invisible — it simply
// never matches anything the caller discovers from the filesystem, and the route
// is silently never swept.

import { describe, it, expect } from 'vitest';
import { ROUTE_PARAM_SOURCES, UNRESOLVED_ROUTES, resolveRouteUrl } from './route-ids';

// The measured ids, keyed exactly as the binding table names them.
// See route-ids.ts for provenance: live GETs on 2026-09-10, tenant …0003.
const IDS: Record<string, string> = {
  project: '746114f4-1a12-4f18-ba98-79953feec1bb',
  projectForApproval: '26ccf7ec-85b9-4390-86a8-c280758f1c9c',
  approval: '744190c1-f6d4-4f00-ae00-af080f66e089',
  requirement: '01a08aa3-5574-7579-ad75-ca92e20ddf0e',
  principle: '01a08a7e-f21d-7507-99c0-5bd05d7d23a8',
  decision: '01a08aa8-3860-7271-9711-b8fa0da97c18',
  workflow: '04Rn3ynu2fdqHps8',
  card: '1851499682983839660',
  board: '1851499667968231330',
  worker: 'arch_description_quality',
  tenant: '01a03dd9-941a-7300-ad03-f099dcf93864',
  kagEntity: 'ent-8f9790e23d16450ffe30553b1efd91e3',
  projectRequest: '641d4594-0bfc-4a6d-9162-efee81a31d54',
  archElement: '01a089e1-2445-767c-b15b-8157f1dd5907',
  archRelationship: '01a08aa3-a55a-7426-9c15-fbf338ac34bb',
  libraryType: 'workflow',
  assetType: 'requirements',
};

describe('resolveRouteUrl — routes that CAN be swept', () => {
  it('returns a static route unchanged', () => {
    for (const routeId of ['/projects', '/', '/library/workflows', '/admin/tenants']) {
      expect(resolveRouteUrl(routeId, IDS)).toBe(routeId);
    }
  });

  it('substitutes a single param from its bound source', () => {
    expect(resolveRouteUrl('/projects/[id]', IDS)).toBe(
      '/projects/746114f4-1a12-4f18-ba98-79953feec1bb',
    );
    expect(resolveRouteUrl('/workflows/[id]', IDS)).toBe('/workflows/04Rn3ynu2fdqHps8');
  });

  it('substitutes a param that is not spelled [id]', () => {
    expect(resolveRouteUrl('/workers/[name]', IDS)).toBe('/workers/arch_description_quality');
    expect(resolveRouteUrl('/admin/tenants/[nameOrId]', IDS)).toBe(
      '/admin/tenants/01a03dd9-941a-7300-ad03-f099dcf93864',
    );
  });

  it('fills BOTH params of the two-param route, left to right, from the right sources', () => {
    // The only route with two params, and the only place ordering can be wrong
    // while still producing a plausible-looking URL. `projectForApproval` (the
    // project that OWNS the approval) must land in [id]; `approval` in
    // [approvalId]. Swapped, the app answers 200 and renders nothing.
    const url = resolveRouteUrl('/projects/[id]/approve/[approvalId]', IDS);
    expect(url).toBe(
      '/projects/26ccf7ec-85b9-4390-86a8-c280758f1c9c' +
        '/approve/744190c1-f6d4-4f00-ae00-af080f66e089',
    );
    // Stated independently of the literal above, so a copy-paste of a wrong
    // literal cannot make this pass: the ids are distinct and in this order.
    expect(url).not.toBeNull();
    const parts = (url as string).split('/');
    expect(parts[2]).toBe(IDS.projectForApproval);
    expect(parts[4]).toBe(IDS.approval);
    expect(parts[2]).not.toBe(parts[4]);
  });
});

describe('resolveRouteUrl — routes that must be REFUSED, never faked', () => {
  it('returns null for an unknown routeId', () => {
    for (const routeId of ['/nope/[id]', '/projects/[id]/invented-tab', '/[id]']) {
      expect(resolveRouteUrl(routeId, IDS)).toBeNull();
    }
  });

  it('ANTI-FAKE-ID: a known route with an empty ids map resolves to null, not a placeholder', () => {
    // This is the assertion the whole module exists for. With no measured id
    // available the only honest answer is "not swept". A placeholder, an empty
    // segment, or a partial path would be visited, 404, and be recorded as an
    // app defect that does not exist.
    for (const routeId of Object.keys(ROUTE_PARAM_SOURCES)) {
      expect(resolveRouteUrl(routeId, {})).toBeNull();
    }
  });

  it('returns null when only SOME of a multi-param route has an id', () => {
    // Never a partial substitution: half-filled would leave a literal
    // "[approvalId]" in the path and get swept as a real URL.
    const route = '/projects/[id]/approve/[approvalId]';
    expect(resolveRouteUrl(route, { projectForApproval: IDS.projectForApproval })).toBeNull();
    expect(resolveRouteUrl(route, { approval: IDS.approval })).toBeNull();
  });

  it('treats an empty-string id as missing', () => {
    // An empty value would collapse the segment and produce `/projects/` —
    // a DIFFERENT, existing route that would sweep green.
    expect(resolveRouteUrl('/projects/[id]', { project: '' })).toBeNull();
  });

  it('does not resolve a route named after an Object.prototype member', () => {
    // Bare bracket access on an object literal returns a truthy value for these,
    // which would sail past a `?? null` guard.
    for (const routeId of ['constructor', 'toString', '__proto__', 'valueOf']) {
      expect(resolveRouteUrl(`${routeId}/[id]`, IDS)).toBeNull();
    }
  });

  it('every UNRESOLVED_ROUTES entry resolves to null and carries a stated reason', () => {
    for (const [routeId, why] of Object.entries(UNRESOLVED_ROUTES)) {
      expect(resolveRouteUrl(routeId, IDS)).toBeNull();
      expect(why.length).toBeGreaterThan(20);
    }
  });
});

describe('resolveRouteUrl — encoding', () => {
  it('percent-encodes a value and introduces no extra path segment', () => {
    // One measured id is a name, not a uuid, so a `/` or a space in a value is
    // reachable. Unencoded, `a b/c` would silently become two segments and hit
    // a different route entirely.
    const url = resolveRouteUrl('/workers/[name]', { worker: 'a b/c' });
    expect(url).toBe('/workers/a%20b%2Fc');
    expect((url as string).split('/')).toHaveLength(3);
    expect(url).not.toContain(' ');
  });

  it('leaves an already-safe id byte-identical', () => {
    expect(resolveRouteUrl('/workers/[name]', IDS)).toBe('/workers/arch_description_quality');
  });
});

describe('the binding table itself', () => {
  it('COVERAGE: every key is parameterised and resolves with a fully populated id map', () => {
    // A typo'd key is otherwise invisible — it never matches a routeId the
    // caller discovered from the filesystem, so the route is silently skipped
    // and the sweep still reports pass.
    const keys = Object.keys(ROUTE_PARAM_SOURCES);
    expect(keys.length).toBeGreaterThan(0);

    // Build the id map from the table's OWN source keys, so a binding naming a
    // source nobody can supply fails here rather than at sweep time.
    const everySource: Record<string, string> = {};
    for (const sources of Object.values(ROUTE_PARAM_SOURCES)) {
      for (const key of sources) everySource[key] = IDS[key] ?? '';
    }

    for (const routeId of keys) {
      expect(routeId, `${routeId} has no [param] and does not belong here`).toContain('[');
      expect(routeId.startsWith('/'), `${routeId} must be an absolute routeId`).toBe(true);
      // Layout groups are stripped by the caller before lookup; a `(group)` here
      // could never match.
      expect(routeId, `${routeId} still carries a layout group`).not.toContain('(');

      const url = resolveRouteUrl(routeId, everySource);
      expect(url, `${routeId} did not resolve with every source populated`).not.toBeNull();
      expect(url).not.toContain('[');
      expect(url).not.toContain('//');
    }
  });

  it('COVERAGE: every source key named by a binding has a measured id', () => {
    for (const [routeId, sources] of Object.entries(ROUTE_PARAM_SOURCES)) {
      expect(sources.length, `${routeId} has an empty binding`).toBeGreaterThan(0);
      expect(
        sources.length,
        `${routeId} binds fewer sources than it has params`,
      ).toBeGreaterThanOrEqual(routeId.match(/\[[^\]]+\]/g)?.length ?? 0);
      for (const key of sources) {
        expect(IDS[key], `${routeId} names source "${key}", which has no measured id`).toBeTruthy();
      }
    }
  });

  it('DISJOINT: no routeId is both resolvable and unresolved', () => {
    const resolvable = Object.keys(ROUTE_PARAM_SOURCES);
    const unresolved = Object.keys(UNRESOLVED_ROUTES);
    const both = resolvable.filter((r) => unresolved.includes(r));
    expect(both, `routes claimed in both maps: ${both.join(', ')}`).toEqual([]);
    // And both maps are non-trivial, so an empty one cannot make this vacuous.
    expect(resolvable.length).toBeGreaterThan(0);
    expect(unresolved.length).toBeGreaterThan(0);
  });

  it('DISJOINT: every unresolved key is parameterised and layout-group-free too', () => {
    for (const routeId of Object.keys(UNRESOLVED_ROUTES)) {
      expect(routeId).toContain('[');
      expect(routeId).not.toContain('(');
      expect(routeId.startsWith('/')).toBe(true);
    }
  });
});
