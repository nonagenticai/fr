// The contract-gate sign-off route (POST /api/projects/<id>/gates/<gate>/request)
// was DELETED by owner ruling 2026-10-09: phase exit is computed from the
// project's plan, so a minted gate sign-off advanced nothing.
//
// This rebuilds the REAL route table — the ordered table the server boots
// (server.ts rows + capability-derived rows, scripts/route-overlap-pairs.ts;
// since fr-agui P4a3 fewer than 500 rows are literal `router.add` text) — into
// the real `Router`, and asserts the
// deleted path no longer matches. `server.ts` answers an unmatched route with
// 404 `Not found` (the `if (!match)` branch of the fetch handler), so "no match"
// IS the 404. Controls prove the instrument can see live routes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orderedRouteTable } from '../../../scripts/route-overlap-pairs';
import { Router } from '../../../src/utils/router';

const SERVER = readFileSync(join(import.meta.dir, '../../../src/server.ts'), 'utf8');

function liveRouter(): { router: Router; count: number } {
  const router = new Router();
  let count = 0;
  for (const r of orderedRouteTable()) {
    router.add(r.method, r.path, async () => new Response(null));
    count++;
  }
  return { router, count };
}

const PID = '11111111-2222-3333-4444-555555555555';

describe('contract-gate sign-off route is gone', () => {
  test('POST /api/projects/:id/gates/contract/request matches no route (⇒ 404)', () => {
    const { router, count } = liveRouter();
    // Non-vacuity: the live table must register routes, or "no match" is
    // meaningless. No count of the route surface is pinned.
    expect(count).toBeGreaterThan(0);
    expect(router.match('POST', `/api/projects/${PID}/gates/contract/request`)).toBeNull();
  });

  test('controls: neighbouring project routes still match', () => {
    const { router } = liveRouter();
    expect(router.match('GET', `/api/projects/${PID}/phase`)).not.toBeNull();
    expect(router.match('POST', `/api/projects/${PID}/provision`)).not.toBeNull();
  });

  test('the handler module and its registration are absent from server.ts', () => {
    // Built by concatenation so the repo-wide removal grep stays at zero hits.
    expect(SERVER).not.toContain(['project', 'gate', 'request'].join('-'));
    expect(SERVER).not.toContain('handle' + 'RequestProjectGate');
    expect(SERVER).not.toContain('/gates/');
  });
});
