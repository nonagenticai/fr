// The `toHttpError` shim was the SECOND DOOR on the Planka error boundary.
//
// `utils/errors.ts::handleError` was hardened so a PlankaError reaches the
// client as a fixed safe string per status. But 33 authenticated /api/kanban/*
// routes never reach that boundary — they `throw toHttpError(err)`, and the
// shim echoed `err.message` verbatim.
//
// `mapPlankaError` builds that message as
//     `Planka <status> on <internal path>: <200 chars of raw upstream body>`
// whenever the upstream body is not parsed JSON. That is deliberate and
// correct FOR AN OPERATOR — it is how you tell a real Planka 403 from an Istio
// ambient `RBAC: access denied`. It is not for the caller.
//
// Every error below is a REAL subclass instance. mock.module() is banned in
// this repo (scripts/check-no-test-doubles.ts) and is not used here.
import { describe, test, expect } from 'bun:test';

import { toHttpError } from '../../../../src/routes/kanban/_errors';
import {
  PlankaAuthError,
  PlankaConflictError,
  PlankaForbiddenError,
  PlankaNotFoundError,
  PlankaRateLimitError,
  PlankaServerError,
  PlankaValidationError,
} from '../../../../src/services/planka/errors';

// The exact shape mapPlankaError produces for a non-JSON upstream body — an
// internal path plus a mesh-deny snippet.
const LEAKY = 'Planka 403 on /api/boards/9/cards: RBAC: access denied';

describe('toHttpError never echoes the upstream message', () => {
  test('a mesh-deny snippet does not reach the caller', () => {
    const out = toHttpError(new PlankaForbiddenError(LEAKY, { status: 403 }));
    expect(out.status).toBe(403);
    // Fails on THESE assertions when `message: err.message` is restored.
    expect(out.data.message).toBe('Forbidden');
    expect(JSON.stringify(out.data)).not.toContain('RBAC');
    expect(JSON.stringify(out.data)).not.toContain('/api/boards/9/cards');
  });

  test('404 maps to the safe text', () => {
    const out = toHttpError(new PlankaNotFoundError(LEAKY, { status: 404 }));
    expect(out.status).toBe(404);
    expect(out.data.message).toBe('Not found');
    expect(JSON.stringify(out.data)).not.toContain('RBAC');
  });

  test('401 maps to the safe text', () => {
    const out = toHttpError(new PlankaAuthError(LEAKY, { status: 401 }));
    expect(out.status).toBe(401);
    expect(out.data.message).toBe('Unauthorized');
  });

  // ⚠️ This one is a BEHAVIOUR change, and it is the point: the shim used to
  // lump 429 into its generic 502 bucket. 429 is the one Planka status whose
  // entire meaning is "back off"; collapsing it makes a caller retry
  // immediately. utils/errors.ts already mapped it correctly — the shim did
  // not, and the divergence is exactly what one shared table prevents.
  test('429 survives as 429, not a generic 502', () => {
    const out = toHttpError(new PlankaRateLimitError('planka rate limited', { status: 429 }));
    expect(out.status).toBe(429);
    expect(out.data.message).toBe('Rate limited');
  });

  test('an unclassified PlankaError still falls through to 502', () => {
    const out = toHttpError(new PlankaConflictError(LEAKY, { status: 409 }));
    expect(out.status).toBe(502);
    expect(out.data.message).toBe('Upstream error');
    expect(JSON.stringify(out.data)).not.toContain('RBAC');
  });

  // `fields` is Planka's `problems` array — it describes the CALLER's own
  // input, so it is forwarded, exactly as handleError does.
  test('validation fields ARE forwarded; the message still is not', () => {
    const out = toHttpError(
      new PlankaValidationError(LEAKY, {
        status: 400,
        fields: [{ attribute: 'name', message: 'is required' }],
      }),
    );
    expect(out.status).toBe(400);
    expect(out.data.message).toBe('Validation error');
    expect(out.data.details).toEqual([{ attribute: 'name', message: 'is required' }]);
    expect(JSON.stringify(out.data)).not.toContain('RBAC');
  });

  test('a plain upstream 5xx stays 502 with NO code (still reads as an outage)', () => {
    const out = toHttpError(new PlankaServerError(LEAKY, { status: 500 }));
    expect(out.status).toBe(502);
    expect(out.data.code).toBeUndefined();
  });

  test('a non-PlankaError is rethrown unchanged', () => {
    const boom = new Error('not a planka error');
    expect(() => toHttpError(boom)).toThrow(boom);
  });
});
