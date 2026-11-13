// tests/unit/capabilities/real-pipeline.ts
//
// fr-agui P4d-1 (P4-carry SYSTEMIC): drive a capability's route through the SERVER'S
// real request pipeline, not `cap.legacyHandler` directly.
//
// Calling the handler directly skips what src/server.ts runs around it:
//   * the FULL ordered route table — a probe is matched first-match-wins against every
//     row (literal and capability-derived, in server order: scripts/route-overlap-pairs.ts
//     `orderedRouteTable`, the reconstruction tests/unit/capabilities/route-order.test.ts
//     pins), so a path another row shadows is caught;
//   * `dispatchRouted` (utils/routed-dispatch.ts): `tagInboundJsonParseErrors` (a
//     non-JSON body is 400 `invalid JSON body`), `recordMatchedRoute` on the MATCHED
//     pattern, `assertLicenceBearerRouteAllowed` (a licence bearer off the allowlist is
//     403 `licence_route_not_allowed` BEFORE the handler runs) and the central catch.
//     Called directly, the licence allowlist matches by PATHNAME, so
//     `GET /api/reports/approval-backlog` matched the allowlisted `/api/reports/:reportId`
//     and a licence wrongly passed (P4b part 2 finding).
//
// Not reproduced: the package-licence gate (a no-op unless that app's flag is on) and the
// usage-span / CORS wrapping of a success (headers only).

import { capabilityRouteHandler } from '../../../src/capabilities/derive-router';
import type { Capability } from '../../../src/capabilities/define';
import { dispatchRouted } from '../../../src/utils/routed-dispatch';
import { Router } from '../../../src/utils/router';
import { orderedRouteTable } from '../../../scripts/route-overlap-pairs';
import { getCapability } from '../../helpers/capabilities';

/** A literal (non-capability) row was matched: the probe never reaches the capability. */
export class LiteralRowReached extends Error {}

let router: Router | null = null;

/** The server's route table, in match order: capability rows bound to their real handlers. */
export function realRouter(): Router {
  if (router !== null) return router;
  const r = new Router();
  for (const row of orderedRouteTable()) {
    if (row.handler.startsWith('capability:')) {
      const cap = getCapability(row.handler.slice('capability:'.length));
      if (cap === undefined) throw new Error(`real-pipeline: unknown capability row ${row.handler}`);
      r.add(row.method, row.path, capabilityRouteHandler(cap));
    } else {
      const key = `${row.method} ${row.path}`;
      r.add(row.method, row.path, async () => {
        throw new LiteralRowReached(`literal row ${key} (${row.handler})`);
      });
    }
  }
  router = r;
  return r;
}

export interface RealDispatchOptions {
  /**
   * Errors a test's sentinels throw to signal "past the gate" (a store sentinel, a
   * past-the-door marker). The pipeline's catch would render them as 500; one thrown by
   * the handler is RE-THROWN after dispatch instead, so the test keeps its own signal.
   */
  passthrough?: (err: unknown) => boolean;
  /**
   * Run THIS instead of the capability's handler once the pipeline admits the request
   * (a harness that must never reach a real handler: it sees exactly what the pre-handler
   * steps decided).
   */
  handler?: (req: Request, ...params: string[]) => Promise<Response>;
}

/**
 * Dispatch `req` exactly as src/server.ts does. Throws when the real table routes the
 * request to any row other than `cap`'s own: that is a disagreement between the
 * declaration (its method + path) and what the server serves.
 */
export async function dispatchReal(cap: Capability<any, any>, req: Request, opts: RealDispatchOptions = {}): Promise<Response> {
  const url = new URL(req.url);
  const match = realRouter().match(req.method, url.pathname);
  if (match === null) throw new Error(`${cap.id}: the real route table serves no ${req.method} ${url.pathname}`);
  if (match.path !== cap.http.path) {
    throw new Error(`${cap.id}: the real route table dispatches ${req.method} ${url.pathname} to ${match.path}, not ${cap.http.path}`);
  }
  let captured: { err: unknown } | null = null;
  const outcome = await dispatchRouted(req, req.method, match.path, async () => {
    try {
      return await (opts.handler ?? match.handler)(req, ...match.params);
    } catch (err) {
      if (opts.passthrough?.(err)) captured = { err };
      throw err;
    }
  });
  if (captured !== null) throw (captured as { err: unknown }).err;
  return outcome.ok
    ? outcome.response
    : new Response(outcome.body, { status: outcome.status, headers: { 'content-type': 'application/json' } });
}
