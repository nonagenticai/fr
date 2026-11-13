// tests/integration/helpers/handler-throws.ts
//
// Some route handlers (`scheduled-triggers`, `scheduled-reports`,
// `projects` PATCH, `streams` manual-trigger error path, etc.) do NOT
// catch their own errors — they `throw new BadRequestError(...)`,
// `throw new NotFoundError(...)`, etc. and rely on the top-level
// `server.ts` catch-all (lines ~1453-1465) to convert the throw into a
// JSON `Response`. Integration tests that call those handlers directly
// (without going through the server) therefore receive a thrown promise,
// not a Response — `expect(res.status).toBe(400)` then fails because
// `res` is `undefined` and the throw escapes the test.
//
// This helper mirrors the server's catch-all so a test can write:
//
//   const res = await callHandler(handleXxx(req));
//   expect(res.status).toBe(400);
//
// instead of either:
//   - duplicating the catch-and-convert dance in every test, OR
//   - rewriting the assertion as `expect(...).rejects.toThrow(...)`
//     which loses the ability to inspect status codes / body details.
//
// The mapping mirrors `src/utils/errors.ts::handleError` exactly.

import { handleError } from '../../../src/utils/errors';

/**
 * Await a handler call that may either resolve to a Response (success
 * path) or throw an AppError-shaped error (validation / not-found /
 * upstream-typed error). In both cases a Response is returned, with
 * the thrown error converted via the same `handleError` mapping
 * `server.ts` uses at the top-level catch.
 *
 * Pattern:
 *   const res = await callHandler(handleCreateScheduledTrigger(req));
 *   expect(res.status).toBe(400);
 *   const body = await res.json();
 *   expect(body.error).toMatch(/cron/);
 */
export async function callHandler(
  promise: Promise<Response>,
): Promise<Response> {
  try {
    return await promise;
  } catch (err: unknown) {
    // server.ts also branches on typed-upstream errors with `status` +
    // `data` shape; mirror that branch first so UpstreamError /
    // ServiceUnavailableError surface the same way they do in prod.
    if (
      err &&
      typeof err === 'object' &&
      'status' in err &&
      'data' in err
    ) {
      const e = err as { status: number; data: unknown };
      return new Response(JSON.stringify(e.data), {
        status: e.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return handleError(err);
  }
}

/**
 * Lower-level shim for legacy callers that already wrapped the Promise
 * in a withRequestContext — same semantics as `callHandler`.
 */
export const rejectsToResponse = callHandler;
