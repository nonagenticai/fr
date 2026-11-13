import { describe, test, expect } from 'bun:test';
import { handleError } from '../../../src/utils/errors';

describe('handleError — bare jose JWT errors', () => {
  test('maps ERR_JWT_EXPIRED to 401', async () => {
    const err = Object.assign(new Error('token expired'), { code: 'ERR_JWT_EXPIRED' });
    const res = handleError(err);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  test('maps ERR_JWT_CLAIM_VALIDATION_FAILED to 401', async () => {
    const err = Object.assign(new Error('iss mismatch'), {
      code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    });
    const res = handleError(err);
    expect(res.status).toBe(401);
  });

  test('maps ERR_JWS_SIGNATURE_VERIFICATION_FAILED to 401', async () => {
    const err = Object.assign(new Error('bad sig'), {
      code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    });
    const res = handleError(err);
    expect(res.status).toBe(401);
  });

  test('still returns 500 for non-JWT errors', () => {
    const res = handleError(new Error('boom'));
    expect(res.status).toBe(500);
  });
});

describe('handleError — Postgres 22P02 (invalid typed literal)', () => {
  test('maps a non-UUID :id cast error (22P02) to 400, not 500', async () => {
    // Shape of a postgres.js PostgresError raised by `WHERE projects.id = $1`
    // when $1 is a non-UUID string cast to a `uuid` column.
    const err = Object.assign(
      new Error('invalid input syntax for type uuid: "not-a-uuid"'),
      { code: '22P02' }
    );
    const res = handleError(err);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request parameter');
  });

  test('does not leak the raw Postgres message', async () => {
    const err = Object.assign(
      new Error('invalid input syntax for type uuid: "secret-internal-detail"'),
      { code: '22P02' }
    );
    const body = (await handleError(err).json()) as { error: string };
    expect(body.error).not.toContain('invalid input syntax');
    expect(body.error).not.toContain('secret-internal-detail');
  });

  test('a bare Error with no code still returns 500', () => {
    expect(handleError(new Error('boom')).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The wrapped case — the one production actually produces.
//
// ⚠️ READ THE FIXTURES ABOVE FIRST. Every 22P02 case in the block above builds
// `Object.assign(new Error(…), { code: '22P02' })` and its comment calls it
// "Shape of a postgres.js PostgresError". That is the shape the DRIVER raises.
// It is NOT the shape the application receives: drizzle-orm catches the driver
// error and rethrows `new DrizzleQueryError(query, params, cause)`, which sets
// `.query`, `.params` and `.cause` — and no `.code`.
//
// So those tests were green, asserted exactly the right behaviour, and proved
// nothing about production, where the same request returned 500 for months.
// MEASURED on the deployed pod 2026-09-04: 13 of 13 HTTP 500s in a 37-minute
// window were this, on real authenticated traffic.
//
// These cases construct the REAL wrapper imported from drizzle-orm. A
// hand-rolled lookalike would reproduce the original mistake one level up.
// ---------------------------------------------------------------------------
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { statusForError, pgErrorCode } from '../../../src/utils/errors';
import { IntegrationError } from '../../../src/integrations/_lib/errors';

/** A postgres.js PostgresError as the driver actually raises it. */
function driverError(code: string, message = 'invalid input syntax for type uuid'): Error {
  return Object.assign(new Error(message), {
    code,
    severity: 'ERROR',
    routine: 'string_to_uuid',
  });
}

/** What drizzle hands the application for that same failure. */
function wrapped(code: string): Error {
  return new DrizzleQueryError(
    'select "projects"."id" from "projects" where "projects"."id" = $1',
    ['stream:9b9fc446-3fff-4587-be44-68908427ea32'],
    driverError(code),
  );
}

describe('22P02 wrapped in drizzle’s DrizzleQueryError — the production shape', () => {
  test('the wrapper genuinely does not carry the code (the premise of this whole block)', () => {
    const err = wrapped('22P02');
    expect((err as unknown as { code?: unknown }).code).toBeUndefined();
    expect((err.cause as { code?: unknown }).code).toBe('22P02');
  });

  test('handleError maps the WRAPPED 22P02 to 400, not 500', async () => {
    const res = handleError(wrapped('22P02'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid request parameter');
  });

  test('statusForError agrees, so metering and the response cannot drift', () => {
    expect(statusForError(wrapped('22P02'))).toBe(400);
  });

  test('the wrapped body still does not leak the raw Postgres message', async () => {
    const err = new DrizzleQueryError(
      'select 1',
      ['secret-internal-detail'],
      driverError('22P02', 'invalid input syntax for type uuid: "secret-internal-detail"'),
    );
    const body = (await handleError(err).json()) as { error: string };
    expect(body.error).not.toContain('invalid input syntax');
    expect(body.error).not.toContain('secret-internal-detail');
  });
});

describe('pgErrorCode — the walk must not over-admit', () => {
  test('finds a SQLSTATE at depth 0 (unchanged from the pre-fix behaviour)', () => {
    expect(pgErrorCode(driverError('23505'))).toBe('23505');
  });

  test('finds it through one wrapper — the drizzle case', () => {
    expect(pgErrorCode(wrapped('23505'))).toBe('23505');
  });

  test('NEGATIVE CONTROL: an ordinary error wrapped with a cause is still 500', () => {
    const err = new Error('outer');
    (err as { cause?: unknown }).cause = new Error('inner');
    expect(pgErrorCode(err)).toBeUndefined();
    expect(statusForError(err)).toBe(500);
    expect(handleError(err).status).toBe(500);
  });

  test('NEGATIVE CONTROL: a five-uppercase non-pg code below the top is refused', () => {
    // `EPIPE` matches the SQLSTATE shape. Without the driver-marker requirement
    // an unrelated inner error would be read as a Postgres code.
    const err = new Error('outer');
    (err as { cause?: unknown }).cause = Object.assign(new Error('broken pipe'), {
      code: 'EPIPE',
    });
    expect(pgErrorCode(err)).toBeUndefined();
  });

  test('a cause cycle terminates instead of hanging', () => {
    const err = new Error('self-referential');
    (err as { cause?: unknown }).cause = err;
    expect(pgErrorCode(err)).toBeUndefined();
  });

  test('stops at the bounded depth rather than walking forever', () => {
    // Depth 4 is past MAX_DEPTH (3). Measured: drizzle wraps exactly once, so
    // this is slack, not a supported nesting level.
    let err: Error = driverError('22P02');
    for (let i = 0; i < 4; i += 1) {
      const outer = new Error(`layer ${i}`);
      (outer as { cause?: unknown }).cause = err;
      err = outer;
    }
    expect(pgErrorCode(err)).toBeUndefined();
  });
});

describe('branch ORDER — an upstream fault must not be laundered into a client fault', () => {
  test('an IntegrationError carrying a drizzle cause keeps its OWN upstream status', () => {
    // 31 sites in this repo construct errors with `cause: err`. If the SQLSTATE
    // branch ran before the IntegrationError branch (as it did before this
    // change), every one of these would be answered 400 — reporting an upstream
    // failure as the caller's mistake, which is the exact inversion
    // `scripts/check-client-input-not-upstream.ts` exists to police.
    const err = new IntegrationError({
      code: 'UPSTREAM_UNREACHABLE',
      message: 'kag unreachable',
      service: 'kag',
      cause: wrapped('22P02'),
    });
    expect(statusForError(err)).not.toBe(400);
    expect(statusForError(err)).toBeGreaterThanOrEqual(500);
  });

  test('the jose mapping was NOT widened over cause chains', () => {
    // The jose read is deliberately top-level only. A JWT error buried in a
    // cause chain must not turn an unrelated failure into a 401.
    const err = new Error('outer');
    (err as { cause?: unknown }).cause = Object.assign(new Error('token expired'), {
      code: 'ERR_JWT_EXPIRED',
    });
    expect(statusForError(err)).toBe(500);
    expect(handleError(err).status).toBe(500);
  });
});
