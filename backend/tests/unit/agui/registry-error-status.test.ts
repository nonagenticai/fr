// tests/unit/agui/registry-error-status.test.ts
//
// An RBAC denial is a 403, not a 500.
//
// THE DEFECT. `handleError` (utils/errors.ts) maps `AppError` by statusCode and
// falls through to a bare `500 {"error":"Internal server error"}` for anything
// else. RbacDeniedError and the reachable registry errors all extended plain
// `Error`, so every one of them rendered as 500 on the REST tool routes
// (/api/tools/{analytics,kag,coding}/*, assets/artifacts). `withIntegrationCatch`
// rethrows non-IntegrationErrors by design, so nothing in between reclassified
// them.
//
// Not cosmetic: the caller could not distinguish "you may not do this" from
// "fr is broken", and 20 n8n node modules retry on `statusCode >= 500`, so a
// denial that can NEVER succeed was retried indefinitely -- the same blast
// radius as the UPSTREAM_BAD_BODY -> 502 defect in #908.
//
// ⛔ THE NAME TRAP, which is why every case below asserts `err.name`.
// `AppError`'s constructor sets `this.name = 'AppError'`. `safeRegister`
// swallows ActionAlreadyRegisteredError BY NAME in five route files
// (assets/artifacts.ts, analytics.ts, coding.ts, kag.ts, kanban.ts). If a
// conversion drops its `this.name = ...` after super(), a swallowed
// double-registration becomes a crash at module import time -- a boot failure,
// not a test failure. These assertions are the only thing standing between
// that refactor and production.

import { test, expect, describe } from 'bun:test';
import { AppError, handleError } from '../../../src/utils/errors';
import { RbacDeniedError } from '../../../src/agui/rbac';
import {
  UnknownActionError,
  ActionInputValidationError,
  ActionOutputValidationError,
  InvalidIdempotencyKeyError,
  NoApprovalBackendError,
  ActionAlreadyRegisteredError,
  InvalidActionNameError,
  NotCronSafeError,
} from '../../../src/agui/registry';

/** The five reachable-at-HTTP classes, with the status each MUST render as. */
const REACHABLE: ReadonlyArray<{ name: string; err: Error; status: number }> = [
  { name: 'RbacDeniedError', err: new RbacDeniedError('not_member', 'kag.search', 'no role'), status: 403 },
  { name: 'UnknownActionError', err: new UnknownActionError('kag.nope'), status: 404 },
  { name: 'ActionInputValidationError', err: new ActionInputValidationError('kag.search', undefined), status: 422 },
  { name: 'InvalidIdempotencyKeyError', err: new InvalidIdempotencyKeyError('kag.search'), status: 400 },
  { name: 'NoApprovalBackendError', err: new NoApprovalBackendError('kag.write'), status: 503 },
  { name: 'ActionOutputValidationError', err: new ActionOutputValidationError('kag.search', undefined), status: 500 },
];

describe('agui error classes render as their real status, not a bare 500', () => {
  for (const { name, err, status } of REACHABLE) {
    test(`${name} -> ${status}`, async () => {
      expect(err).toBeInstanceOf(AppError);
      const res = handleError(err);
      expect(res.status).toBe(status);
    });

    test(`${name} keeps its own err.name (safeRegister matches by name)`, () => {
      expect(err.name).toBe(name);
      // The precise regression: AppError's constructor would leave 'AppError'.
      expect(err.name).not.toBe('AppError');
    });
  }

  test('ActionOutputValidationError stays 500 but carries a distinguishable code', async () => {
    // A handler bug IS a server fault, so 500 is right -- but the body must say
    // which one, otherwise it is indistinguishable from the fallthrough it used
    // to be.
    const res = handleError(new ActionOutputValidationError('kag.search', undefined));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('ACTION_OUTPUT_VALIDATION_FAILED');
  });

  test('RbacDeniedError forwards its machine-readable code to the body', async () => {
    const res = handleError(new RbacDeniedError('not_member', 'kag.search', 'no role'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('not_member');
  });

  // ---- the deliberately UNCONVERTED classes ---------------------------------
  //
  // These are unreachable over HTTP: the registration validators throw at module
  // import (a boot crash, not a request) and NotCronSafe needs initiator:'cron',
  // which no HTTP route sets. They stay bare `Error` on purpose. Pinned here so
  // a later "tidy them all up" is a deliberate decision rather than a slip.
  test('registration validators remain bare Error (unreachable at HTTP)', () => {
    for (const err of [
      new ActionAlreadyRegisteredError('a.b'),
      new InvalidActionNameError('bad'),
      new NotCronSafeError('a.b'),
    ]) {
      expect(err).not.toBeInstanceOf(AppError);
    }
    // …and the one safeRegister keys on still answers to its own name.
    expect(new ActionAlreadyRegisteredError('a.b').name).toBe('ActionAlreadyRegisteredError');
  });
});
