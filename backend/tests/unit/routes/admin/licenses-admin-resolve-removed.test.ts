// tests/unit/routes/admin/licenses-admin-resolve-removed.test.ts
//
// PROVES `POST /api/admin/licenses/users/resolve` IS GONE, AND GONE THE RIGHT
// WAY. The route had zero production callers once the licenses table's
// `Person` column was removed (commit 25296721) — the frontend page was its
// only caller. `keycloak.resolveUsers` / `keycloak.getUserById` themselves
// are UNTOUCHED: they have 12 other production call sites and keep their own
// coverage elsewhere.
//
// ⛔ WHY THIS DOES NOT ASSERT ON AN HTTP RESPONSE CODE. A 404 from a deleted
// route and a 404/403 from an auth gate in front of a route that still exists
// look IDENTICAL from the outside — hitting the URL and checking the status
// cannot tell them apart. And `server.ts` calls `Bun.serve()` at module load
// with no guard, so importing it here to inspect the live `Router` would bind
// an actual port as a side effect of running this test file — not something a
// unit test may do. So this checks the two things that actually decide
// whether the route is reachable, without ever starting a server:
//
//   1. the HANDLER no longer exists as an export (nothing could call it even
//      if something still tried to register it), and
//   2. `server.ts`'s SOURCE no longer contains the registration call that
//      would wire it up (checked as the literal `router.add('POST',
//      '/api/admin/licenses/users/resolve', ...)` call shape, not a substring
//      match — so a comment that merely mentions the path, as this file's own
//      neighbouring comment now does, cannot make this test pass by accident).
process.env.KEYCLOAK_URL ||= 'http://test-keycloak.invalid';
process.env.KEYCLOAK_REALM ||= 'test-realm';
process.env.KEYCLOAK_CLIENT_ID ||= 'test-client';
process.env.KEYCLOAK_CLIENT_SECRET ||= 'test-secret';

import { describe, test, expect } from 'bun:test';
import * as licensesAdminRoutes from '../../../../src/routes/admin/licenses-admin';

const SERVER_TS_PATH = new URL('../../../../src/server.ts', import.meta.url).pathname;

describe('POST /api/admin/licenses/users/resolve is fully removed', () => {
  test('the handler and its cap constant no longer exist as exports', () => {
    const mod = licensesAdminRoutes as Record<string, unknown>;
    expect('handleResolveUsers' in mod).toBe(false);
    expect(mod.handleResolveUsers).toBeUndefined();
    expect('RESOLVE_USERS_MAX' in mod).toBe(false);
    expect(mod.RESOLVE_USERS_MAX).toBeUndefined();

    // POSITIVE CONTROL: the SIBLING handler that IS still wired (the search
    // typeahead) must still be there — proves this isn't reading an empty or
    // broken module and calling it "removed".
    expect(typeof mod.handleSearchUsers).toBe('function');
  });

  test('server.ts no longer registers the route (checked in the router table, not by requesting it)', async () => {
    const source = await Bun.file(SERVER_TS_PATH).text();

    // The actual registration call shape — NOT a bare substring match on the
    // path, so a doc-comment that names the path (as this codebase now has,
    // explaining the removal) cannot accidentally satisfy this assertion.
    const registrationCall =
      /router\.add\(\s*['"]POST['"]\s*,\s*['"]\/api\/admin\/licenses\/users\/resolve['"]/;
    expect(source).not.toMatch(registrationCall);

    // No import of the (now-nonexistent) handler either, so nothing in this
    // file could even reference it to register it under a different path.
    expect(source).not.toMatch(/\bhandleResolveUsers\b/);

    // POSITIVE CONTROL: the regex shape matches a real registration call, rather than matching
    // nothing by construction. fr-agui P4d-2e: server.ts holds NO router.add row any more (every
    // route is a capability row, deriveRouter refuses a router that already holds one), so the
    // control is the call shape itself — the line server.ts carried until P4d-2d.
    expect(`router.add('POST', '/api/admin/licenses/users/resolve', handleResolveUsers);`).toMatch(registrationCall);
    expect(source).not.toMatch(/router\.add\(/);
  });

  test('the capability registry (deriveRouter) does not register it either; the search sibling IS registered there', async () => {
    // fr-agui P4c part 3: the /api/admin/licenses routes are capability-derived, so
    // the router table is the registry's rows plus server.ts's router.add rows.
    const { CAPABILITIES } = await import('../../../../src/capabilities/registry');
    const rows = CAPABILITIES.map((e) => `${e.cap.http.method} ${e.cap.http.path}`);
    expect(rows).not.toContain('POST /api/admin/licenses/users/resolve');
    expect(rows.filter((r) => r.includes('/api/admin/licenses/users'))).toEqual(['GET /api/admin/licenses/users']);
  });
});
