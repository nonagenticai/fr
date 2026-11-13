// tests/unit/utils/errors-code.test.ts
//
// The machine-readable `code` on an error body.
//
// WHY THIS MATTERS. An error message is prose: "No project found for boardId
// 177…". A caller that wants to distinguish "this board is not registered in
// fr" from "this project has no approvers" has, until now, had only the HTTP
// status (404 vs 422 — already overloaded by every other failure on the route)
// and the English text (free to be reworded by anyone). `code` is the stable
// contract, so the branch a caller writes keeps working.
//
// The load-bearing negative assertion is that a throw site which sets NO code
// produces a body with NO `code` key at all — not `code: null`, not
// `code: undefined`. Every pre-existing consumer of every pre-existing throw
// site in fr reads this shape, and an additive field must be genuinely
// additive.

import { describe, expect, test } from 'bun:test';

import {
  AppError,
  BadRequestError,
  NotFoundError,
  ValidationError,
  handleError,
} from '../../../src/utils/errors';
import { SIGNOFF_BLOCK_REASONS } from '../../../src/lib/execution-signoff';

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('AppError.withCode / handleError', () => {
  test('withCode attaches the code and returns the same error instance', () => {
    const err = new NotFoundError('nope');
    const returned = err.withCode('signoff_project_not_found');
    // Same instance — the throw site relies on `throw new X(m).withCode(c)`
    // being a single expression, which requires `this`, not a copy.
    expect(returned).toBe(err);
    expect(err.code).toBe('signoff_project_not_found');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('nope');
  });

  test('an error WITHOUT a code produces a body with no `code` key at all', async () => {
    const res = handleError(new ValidationError('plain'));
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(body.error).toBe('plain');
    // Not null, not undefined — absent. This is what keeps the change additive.
    expect(Object.keys(body)).not.toContain('code');
  });

  test('an error WITH a code emits it as a top-level `code`, alongside error', async () => {
    const res = handleError(
      new ValidationError('no approvers').withCode(SIGNOFF_BLOCK_REASONS.NO_APPROVERS),
    );
    expect(res.status).toBe(422);
    const body = await bodyOf(res);
    expect(body.code).toBe('signoff_no_approvers');
    // The prose is still there — `code` supplements, it does not replace.
    expect(body.error).toBe('no approvers');
  });

  test('code survives on every AppError subclass the sign-off gate throws', async () => {
    const cases: Array<[AppError, number, string]> = [
      [
        new NotFoundError('a').withCode(SIGNOFF_BLOCK_REASONS.PROJECT_NOT_FOUND),
        404,
        'signoff_project_not_found',
      ],
      [
        new BadRequestError('b').withCode(SIGNOFF_BLOCK_REASONS.PROJECT_UNTENANTED),
        400,
        'signoff_project_untenanted',
      ],
      [
        new ValidationError('c').withCode(SIGNOFF_BLOCK_REASONS.NO_APPROVERS),
        422,
        'signoff_no_approvers',
      ],
    ];
    for (const [err, status, code] of cases) {
      const res = handleError(err);
      expect(res.status).toBe(status);
      expect((await bodyOf(res)).code).toBe(code);
    }
  });

  test('`details` and `code` coexist without clobbering each other', async () => {
    const err = new ValidationError('x', { field: 'card_id' }).withCode('some_code');
    const body = await bodyOf(handleError(err));
    expect(body.details).toEqual({ field: 'card_id' });
    expect(body.code).toBe('some_code');
  });
});

describe('sign-off block reason taxonomy', () => {
  test('every reason code is distinct and namespaced', () => {
    const values = Object.values(SIGNOFF_BLOCK_REASONS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v.startsWith('signoff_')).toBe(true);
  });
});
