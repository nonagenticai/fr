// src/utils/routed-dispatch.ts
//
// The router-dispatched request pipeline of src/server.ts, as ONE function, so a
// test can drive a request through exactly what the server runs around a matched
// handler (and not a replica of it):
//
//   1. `tagInboundJsonParseErrors(req)` — a malformed INBOUND body is the caller's
//      fault: `handleError` answers 400 `{"error":"invalid JSON body"}`, not 500.
//   2. `recordMatchedRoute(req, method, pattern)` — the registered pattern the
//      router dispatched to, what the licence route allowlist keys on.
//   3. inside the try: `assertLicenceBearerRouteAllowed(req)` — a licence-shaped
//      bearer on a route not on the n8n-nodes-fr allowlist is 403
//      `licence_route_not_allowed` BEFORE the handler runs; then `run()` (the
//      server's package-licence gate + the handler).
//   4. the central catch (`renderRouteError`).
//
// src/server.ts calls `dispatchRouted`.

import { assertLicenceBearerRouteAllowed, recordMatchedRoute } from '../lib/licence-route-allowlist';
import { handleError, tagInboundJsonParseErrors } from './errors';

export type RoutedOutcome =
  | { ok: true; response: Response }
  | { ok: false; status: number; body: string };

/**
 * The central catch of a routed request: the status and JSON body the server
 * answers for an error thrown by the pre-handler checks or the handler.
 */
export async function renderRouteError(error: unknown): Promise<{ status: number; body: string }> {
  if (error && typeof error === 'object' && 'status' in error && 'data' in error) {
    // Typed error from route handlers (UpstreamError, ServiceUnavailableError, etc.)
    return { status: (error as any).status, body: JSON.stringify((error as any).data) };
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    ((error as { code: string }).code).startsWith('ERR_JWT_')
  ) {
    // Bare jose JWT error (ERR_JWT_EXPIRED / ERR_JWS_INVALID / …) — any
    // route that forgets to wrap validateAuth shouldn't surface 500. The
    // primary auth path already maps these to UnauthorizedError; this is
    // defence in depth for unknown future leak paths.
    return { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  // NOTE: the IntegrationError and AuthenticationError branches that used
  // to sit here were REMOVED (2026-09-01) and now live in `handleError`
  // (utils/errors.ts), which this fallback calls.
  //
  // The IntegrationError one was redundant from the moment it landed: main
  // added the identical conversion inside `handleError` in #908, with the
  // same reasoning, and neither branch knew about the other. Proven by
  // mutation — deleting the block changed NOTHING observable, because
  // the fallback already handled it. Two implementations of one concern is
  // exactly the defect that PR set out to remove.
  //
  // AuthenticationError was NOT redundant (deleting it did turn a test red),
  // but it belongs beside its sibling rather than in a second location.
  const errorResponse = handleError(error);
  return { status: errorResponse.status, body: await errorResponse.text() };
}

/**
 * Run a router-matched request: the pre-handler steps, then `run` (which the
 * server uses for its package-licence gate, the handler and the success
 * headers), and the central catch for anything either throws.
 */
export async function dispatchRouted(
  req: Request,
  method: string,
  pattern: string,
  run: () => Promise<Response>,
): Promise<RoutedOutcome> {
  // Mark a malformed INBOUND body as the caller's fault so `handleError`
  // answers 400 instead of 500. Done on the Request instance (not by matching
  // the SyntaxError message) because an upstream `Response.json()` failure is
  // byte-identical and must keep its own status — see utils/errors.ts.
  tagInboundJsonParseErrors(req);

  // The registered pattern the router dispatched to — what the licence route
  // allowlist keys on (never the raw URL). lib/licence-route-allowlist.ts.
  recordMatchedRoute(req, method, pattern);

  try {
    // ⛔ Licence callers: deny by default — a licence-shaped bearer on a route
    // not on the n8n-nodes-fr allowlist is 403 `licence_route_not_allowed`
    // before the handler runs (rendered by the catch below).
    assertLicenceBearerRouteAllowed(req);
    return { ok: true, response: await run() };
  } catch (error) {
    return { ok: false, ...(await renderRouteError(error)) };
  }
}
