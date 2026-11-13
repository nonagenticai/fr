// tests/unit/routes/rm-owned-writes-retired.test.ts
//
// George 2026-10-13 (v4, D15/R16): after the project request, ONLY the PM (n8n)
// writes a project's requirements_management resources — its phase included.
// fr's write doors onto them are RETIRED, not merely refused: no route is
// registered, so the router finds no match and the server answers its plain
// 404 `{ error: 'Not found' }` (src/server.ts, `if (!match)`). The READS stay.
//
// Measured against the REAL route table (scripts/check-route-spec-coverage.ts
// `collectRoutes`, the same census the licence allowlist test uses), replayed
// through the REAL router class, so a re-registration goes red here.

import { describe, expect, test } from 'bun:test';

import { collectRoutes } from '../../../scripts/check-route-spec-coverage';
import { Router } from '../../../src/utils/router';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import { openapiSpec } from '../../../src/capabilities/served-spec';

const PID = '0199cccc-0000-7000-8000-0000000000aa';
const toColon = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

/** A router holding exactly the registered (method, pattern) rows; the handler names the row. */
function liveRouter(): Router {
  const r = new Router();
  for (const s of collectRoutes().sites) {
    const key = `${s.method} ${toColon(s.path)}`;
    r.add(s.method, toColon(s.path), async () => new Response(key));
  }
  return r;
}

describe('RM-owned project writes are not routes (D15/R16)', () => {
  const router = liveRouter();

  test('PATCH /api/projects/:id/phase has no route (⇒ the server 404); GET /phase stays', () => {
    expect(router.match('PATCH', `/api/projects/${PID}/phase`)).toBeNull();
    const get = router.match('GET', `/api/projects/${PID}/phase`);
    expect(get?.path).toBe('/api/projects/:id/phase');
  });

  test('no licence allowlist row and no OpenAPI operation for the retired phase write', () => {
    expect(LICENCE_ROUTE_ALLOWLIST.filter((r) => r.pattern === '/api/projects/:id/phase')).toEqual([]);
    const paths = openapiSpec.paths as Record<string, Record<string, unknown> | undefined>;
    expect(paths['/api/projects/{id}/phase']?.patch).toBeUndefined();
  });
});

describe('the brief is read-only after create (D15/R16)', () => {
  const router = liveRouter();

  test('PUT /api/projects/:id/brief has no route (⇒ the server 404); the reads stay', () => {
    expect(router.match('PUT', `/api/projects/${PID}/brief`)).toBeNull();
    expect(router.match('GET', `/api/projects/${PID}/brief`)?.path).toBe('/api/projects/:id/brief');
    expect(router.match('GET', `/api/projects/${PID}/brief/versions`)?.path).toBe('/api/projects/:id/brief/versions');
    expect(router.match('GET', `/api/projects/${PID}/brief/versions/2`)?.path).toBe(
      '/api/projects/:id/brief/versions/:version',
    );
  });

  test('no licence allowlist row and no OpenAPI operation for the retired brief write', () => {
    expect(LICENCE_ROUTE_ALLOWLIST.filter((r) => r.method === 'PUT' && r.pattern === '/api/projects/:id/brief')).toEqual([]);
    const paths = openapiSpec.paths as Record<string, Record<string, unknown> | undefined>;
    expect(paths['/api/projects/{id}/brief']?.put).toBeUndefined();
    expect(paths['/api/projects/{id}/brief']?.get).toBeDefined();
  });
});
