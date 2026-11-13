// tests/unit/workers/deblock-redelivery-invalid-card-id.test.ts
//
// ⭐ #1104 — A PLANKA 400 ON THE CARD READ FOR AN ID THAT IS NOT A PLANKA ID.
//
// THE DEFECT, MEASURED. Approval `cf5c5a2f-26c9-4ae8-9e95-ba891780b653` is
// `voided` with `card_id = 'smoke-n8n-r2-2'` — a smoke-run literal that was never
// a Planka id. Planka answers that read 400; `mapPlankaError`
// (services/planka/errors.ts:124) turns a 400 into `PlankaValidationError`; and
// `classifyReadFailure` branched on 404 ONLY, so the row classified `'degraded'`.
// `recordUnreadable` is called ONLY for `'gone'` — so the row took ZERO strikes,
// `callback_unreadable_reads` stayed 0, `UNREADABLE_STRIKES` could never be
// reached, and the row came back on every scan cycle forever.
//
// ⛔ WHY THIS IS A UNIT TEST AND NOT ONLY AN INTEGRATION ONE. Reaching this branch
// through a tick needs a real Postgres AND a Planka fake that can raise a 400 on
// exactly the card path, and the failure mode is SILENT — a row that never strikes
// looks identical to a row that has not struck YET. The classification is a pure
// function of (error, definitive path, card id), so it is provable here for free,
// and a branch whose regression is invisible in production deserves the cheap
// proof as well as the expensive one.
import { describe, expect, test } from 'bun:test';

import {
  PlankaNotFoundError,
  PlankaServerError,
  PlankaValidationError,
} from '../../../src/services/planka/errors';
import {
  classifyReadFailure,
  isPlankaCardId,
} from '../../../src/workers/deblock-callback-redelivery';

/** The real smoke literal off the prod row this issue was filed for. */
const SMOKE_CARD_ID = 'smoke-n8n-r2-2';
/** A real Planka id: decimal, snowflake-shaped. */
const REAL_CARD_ID = '1541239876543210987';

const cardPath = (id: string): string => `/api/cards/${id}`;

describe('isPlankaCardId', () => {
  test('a decimal snowflake IS a Planka id', () => {
    expect(isPlankaCardId(REAL_CARD_ID)).toBe(true);
    expect(isPlankaCardId('1')).toBe(true);
  });

  test('a smoke literal is NOT', () => {
    expect(isPlankaCardId(SMOKE_CARD_ID)).toBe(false);
  });

  test('empty is NOT an id — it addresses nothing either', () => {
    expect(isPlankaCardId('')).toBe(false);
  });

  test('a uuid is NOT — approvals.id is a uuid and has leaked into card_id before', () => {
    expect(isPlankaCardId('cf5c5a2f-26c9-4ae8-9e95-ba891780b653')).toBe(false);
  });
});

describe('classifyReadFailure — #1104, a 400 on the card read path', () => {
  test("400 + a non-Planka card id is 'gone', so strikes can accrue", () => {
    const err = new PlankaValidationError('Validation failed', {
      status: 400,
      path: cardPath(SMOKE_CARD_ID),
    });
    const failure = classifyReadFailure(
      err,
      `card ${SMOKE_CARD_ID}`,
      cardPath(SMOKE_CARD_ID),
      SMOKE_CARD_ID,
    );
    expect(failure.kind).toBe('gone');
    // The message has to name the reason, because `card_unreadable` is terminal and
    // the only thing an operator will ever see is this string in a log.
    expect(failure.message).toContain(SMOKE_CARD_ID);
    expect(failure.message).toContain('400');
  });

  test("400 + a NUMERIC card id stays 'degraded'", () => {
    // ⛔ THE CONTROL THAT KEEPS THE FIX NARROW. A 400 on a well-formed id is
    // ambiguous — a Planka bug, a mesh response, a validation rule we do not model
    // — and this file fails towards 'degraded' for everything ambiguous. Widening
    // the branch to "any 400 on the card path" turns this RED, and in production it
    // would retire live cards as `card_unreadable` on a transient upstream fault.
    const err = new PlankaValidationError('Validation failed', {
      status: 400,
      path: cardPath(REAL_CARD_ID),
    });
    const failure = classifyReadFailure(
      err,
      `card ${REAL_CARD_ID}`,
      cardPath(REAL_CARD_ID),
      REAL_CARD_ID,
    );
    expect(failure.kind).toBe('degraded');
  });

  test("400 raised by a DIFFERENT request stays 'degraded' even for a bad id", () => {
    // The `definitivePath` rule is unchanged and still load-bearing: a 400 from the
    // list read or from `loginAgent` is evidence about Planka, not about this card.
    const err = new PlankaValidationError('Validation failed', {
      status: 400,
      path: '/api/lists/999',
    });
    const failure = classifyReadFailure(
      err,
      `card ${SMOKE_CARD_ID}`,
      cardPath(SMOKE_CARD_ID),
      SMOKE_CARD_ID,
    );
    expect(failure.kind).toBe('degraded');
  });

  test("a 422 — the OTHER status mapped to PlankaValidationError — stays 'degraded'", () => {
    // `mapPlankaError` maps BOTH 400 and 422 to this class, so an `instanceof` test
    // alone would have widened the branch to 422 by accident.
    const err = new PlankaValidationError('Unprocessable', {
      status: 422,
      path: cardPath(SMOKE_CARD_ID),
    });
    const failure = classifyReadFailure(
      err,
      `card ${SMOKE_CARD_ID}`,
      cardPath(SMOKE_CARD_ID),
      SMOKE_CARD_ID,
    );
    expect(failure.kind).toBe('degraded');
  });

  test("400 with NO card id passed stays 'degraded'", () => {
    // A caller that does not name the card cannot produce a strike — the same
    // default `definitivePath` already had.
    const err = new PlankaValidationError('Validation failed', {
      status: 400,
      path: cardPath(SMOKE_CARD_ID),
    });
    const failure = classifyReadFailure(
      err,
      `card ${SMOKE_CARD_ID}`,
      cardPath(SMOKE_CARD_ID),
    );
    expect(failure.kind).toBe('degraded');
  });
});

describe('classifyReadFailure — 404 behaviour is UNCHANGED by #1104', () => {
  test("404 on the card's own path is still 'gone'", () => {
    const err = new PlankaNotFoundError('Card not found', {
      status: 404,
      path: cardPath(REAL_CARD_ID),
    });
    const failure = classifyReadFailure(
      err,
      `card ${REAL_CARD_ID}`,
      cardPath(REAL_CARD_ID),
      REAL_CARD_ID,
    );
    expect(failure.kind).toBe('gone');
  });

  test("404 on ANOTHER path is still 'degraded'", () => {
    const err = new PlankaNotFoundError('Not found', {
      status: 404,
      path: 'https://planka.example.com/api/access-tokens',
    });
    const failure = classifyReadFailure(
      err,
      `card ${REAL_CARD_ID}`,
      cardPath(REAL_CARD_ID),
      REAL_CARD_ID,
    );
    expect(failure.kind).toBe('degraded');
  });

  test("a 504 is still 'degraded' — one blip must never write off a backlog", () => {
    const err = new PlankaServerError('Gateway timeout', {
      status: 504,
      path: cardPath(SMOKE_CARD_ID),
    });
    const failure = classifyReadFailure(
      err,
      `card ${SMOKE_CARD_ID}`,
      cardPath(SMOKE_CARD_ID),
      SMOKE_CARD_ID,
    );
    expect(failure.kind).toBe('degraded');
  });
});
