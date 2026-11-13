// tests/unit/utils/planka-error-boundary.test.ts
//
// `PlankaError` (services/planka/errors.ts) is not an `AppError`, a
// `z.ZodError`, an `AuthenticationError`, or an `IntegrationError` — the only
// branches `statusForError`/`handleError` had before this fix. It also does
// not carry a `data` field, so server.ts's typed-error probe
// (`'status' in error && 'data' in error`) never matches it either. Any
// `PlankaError` that escapes a route WITHOUT going through the local
// `routes/kanban/_errors.ts toHttpError()` shim therefore fell through to a
// bare 500 — a Planka 403 (lost board access) or 429 (rate-limited) read as
// "fr crashed" instead of a permission or backoff signal.
//
// Each case below asserts on the OUTCOME (status / body), not on which
// branch ran, so removing the new branch in `utils/errors.ts` fails the
// assertion, not just a code-coverage line.
//
// ⛔ mock.module() is banned in this repo (scripts/check-no-test-doubles.ts).
// Every error below is a REAL subclass instance, constructed directly —
// no module mocking anywhere in this file.
import { describe, test, expect } from 'bun:test';

import { handleError, statusForError, ValidationError } from '../../../src/utils/errors';
import {
  PlankaAuthError,
  PlankaConflictError,
  PlankaError,
  PlankaForbiddenError,
  PlankaNotFoundError,
  PlankaRateLimitError,
  PlankaServerError,
  PlankaValidationError,
} from '../../../src/services/planka/errors';

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('the fr error boundary knows about PlankaError', () => {
  test('PlankaNotFoundError -> 404, in both statusForError and handleError', async () => {
    const err = new PlankaNotFoundError('card 42 not found', { status: 404 });
    expect(statusForError(err)).toBe(404);
    const res = handleError(err);
    expect(res.status).toBe(404);
    const body = await bodyOf(res);
    // GENERIC, not the upstream's own words. `mapPlankaError` builds messages
    // like `Planka 404 on /api/boards/9/cards: <200 chars of raw body>` — an
    // operator string carrying an internal path and, for a mesh deny, text from
    // ztunnel/nginx rather than Planka. Before this branch existed these fell
    // through to a generic 500 body, so echoing the message would have widened
    // disclosure across every Planka-calling route as a side effect of fixing
    // the status code.
    expect(body.error).toBe('Not found');
    expect(body.error).not.toContain('card 42');
  });

  test('the upstream path and raw body NEVER reach the client', async () => {
    // The disclosure case stated directly, with a message shaped like the ones
    // mapPlankaError actually produces for a mesh deny.
    const err = new PlankaForbiddenError(
      'Planka 403 on /api/boards/9/cards: RBAC: access denied',
      { status: 403 },
    );
    const res = handleError(err);
    expect(res.status).toBe(403);
    const body = await bodyOf(res);
    expect(body.error).toBe('Forbidden');
    expect(JSON.stringify(body)).not.toContain('/api/boards/9/cards');
    expect(JSON.stringify(body)).not.toContain('RBAC');
  });

  test('PlankaForbiddenError -> 403 — the measured "lost board access" case', async () => {
    const err = new PlankaForbiddenError('agent lost access to board 9', { status: 403 });
    expect(statusForError(err)).toBe(403);
    const res = handleError(err);
    expect(res.status).toBe(403);
  });

  test('PlankaAuthError -> 401', async () => {
    const err = new PlankaAuthError('planka session expired', { status: 401 });
    expect(statusForError(err)).toBe(401);
    const res = handleError(err);
    expect(res.status).toBe(401);
  });

  test('PlankaValidationError -> 400, and .fields reaches the response details', async () => {
    const fields = [{ attribute: 'name', message: 'is required' }];
    const err = new PlankaValidationError('validation failed', { status: 400, fields });
    expect(statusForError(err)).toBe(400);
    const res = handleError(err);
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(body.details).toEqual(fields);
  });

  test('a generic PlankaError -> 502, NOT 500 — the headline case', async () => {
    // No specific subclass: a network/server/conflict-shaped failure that
    // still needs to read as "upstream", not "fr is broken".
    const err = new PlankaError('planka is unreachable', { status: 0 });
    expect(statusForError(err)).toBe(502);
    const res = handleError(err);
    // The bug this fixes: before the branch existed this was 500.
    expect(res.status).toBe(502);
    expect(res.status).not.toBe(500);
  });

  test('PlankaServerError (a Planka 5xx) also -> 502, not passed through as its own 5xx', async () => {
    const err = new PlankaServerError('planka 500', { status: 500 });
    expect(statusForError(err)).toBe(502);
    expect(handleError(err).status).toBe(502);
  });

  test('PlankaConflictError -> 502, matching the generic bucket (no dedicated conflict status)', async () => {
    const err = new PlankaConflictError('card version conflict', { status: 409 });
    expect(statusForError(err)).toBe(502);
    expect(handleError(err).status).toBe(502);
  });

  test('PlankaRateLimitError -> 429, deliberately NOT 502 — decision recorded in utils/errors.ts', async () => {
    // toHttpError() (routes/kanban/_errors.ts) lumps this into its generic
    // 502 bucket. The central boundary corrects it: 429 is the one Planka
    // status whose entire meaning is "back off", and collapsing it into a
    // generic 502 makes a caller retry immediately instead of backing off.
    const err = new PlankaRateLimitError('planka rate limit exceeded', { status: 429 });
    expect(statusForError(err)).toBe(429);
    const res = handleError(err);
    expect(res.status).toBe(429);
  });

  test('a NON-Planka error still maps exactly as before — no regression, no over-broad branch', async () => {
    // This is the case that fails if the new PlankaError branch is written
    // too broadly (e.g. duck-typing on `.status` instead of `instanceof`).
    const err = new ValidationError('bad payload', { field: 'name' });
    expect(statusForError(err)).toBe(422);
    const res = handleError(err);
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(body.error).toBe('bad payload');
    expect(body.details).toEqual({ field: 'name' });
  });

  test('a plain Error (no PlankaError anywhere) still falls through to 500', () => {
    const err = new Error('something else entirely');
    expect(statusForError(err)).toBe(500);
    expect(handleError(err).status).toBe(500);
  });
});
