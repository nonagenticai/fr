// tests/unit/utils/errors-integration-escape.test.ts
//
// An IntegrationError that escapes its route's wrapper must still render as
// itself, not as a 500.
//
// `handleError` is the top-level catch. It branches on AppError, ZodError,
// bare jose errors (-> 401) and Postgres 22P02 (-> 400), then falls through to
// 500. `IntegrationError` is NOT an AppError, so every one that escaped a
// route's own `handle(...)` / `withIntegrationCatch(...)` wrapper hit that 500
// -- including the caller-side codes whose entire purpose is to be a 4xx.
//
// MEASURED on the deployed pod (fr-5599f785d-c9h2j, image revision 7922df7e),
// which is how this was found rather than reasoned about:
//
//     GET /api/tools/bridge/sources/artifacts/outputs   (no project_id)
//       -> 500 {"error":"Internal server error"}
//     same request WITH project_id, no auth  -> 401   (so the route is live)
//     same request WITH project_id, garbage  -> 401
//
// `handleListOutputs` calls `requireProjectIdFromQuery(req)` on its FIRST line,
// before `buildBridgeCtx` and outside the wrapper, so its BAD_REQUEST never
// reached `httpStatusFor`. A missing query parameter told the caller fr had
// broken.
//
// This is the same defect class as PR #907 -- a caller's mistake reported as a
// server failure -- at a different seam: not the status MAP, but the path that
// bypasses it.
import { describe, test, expect } from 'bun:test';

import { handleError } from '../../../src/utils/errors';
import { IntegrationError } from '../../../src/integrations/_lib/errors';

describe('handleError — an IntegrationError that escaped its wrapper', () => {
  test('BAD_REQUEST renders 400, not 500 — the measured regression', async () => {
    const res = handleError(
      new IntegrationError({
        code: 'BAD_REQUEST',
        message: 'project_id query parameter is required',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    // The generic body must be gone — that string is what a caller saw.
    expect(JSON.stringify(body)).not.toContain('Internal server error');
  });

  test('it renders IDENTICALLY whether it escaped or was caught by a wrapper', async () => {
    // The point of routing through the same converter: an escaped error and a
    // wrapped one must be indistinguishable to a caller. Otherwise the fix
    // just moves the inconsistency.
    const { integrationErrorResponse } = await import('../../../src/integrations/_lib/errors');
    const err = new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id query parameter is required',
    });
    const escaped = handleError(err);
    const wrapped = integrationErrorResponse(err);
    expect(escaped.status).toBe(wrapped.status);
    expect(await escaped.text()).toBe(await wrapped.text());
  });

  test('the other caller-side codes keep their own statuses', async () => {
    const cases: [string, number][] = [
      ['PAYLOAD_TOO_LARGE', 413],
      ['MISSING_TENANT', 409],
      ['INTERNAL_PRECONDITION', 500],
    ];
    for (const [code, status] of cases) {
      const res = handleError(
        new IntegrationError({ code: code as 'PAYLOAD_TOO_LARGE', message: 'x' }),
      );
      expect(res.status).toBe(status);
    }
  });

  test('a genuine upstream failure is still 502 — this must not turn 5xx into 4xx', async () => {
    // The over-reach control. Making escapes render correctly must not make
    // every escaped error a client error.
    const res = handleError(
      new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: 'kag returned invalid JSON',
        service: 'kag',
      }),
    );
    expect(res.status).toBe(502);
  });

  test('a NON-IntegrationError still falls through to 500', async () => {
    // The other over-reach control: a real bug must stay a 500. A TypeError is
    // not something a caller can fix.
    const res = handleError(new TypeError('undefined is not a function'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
