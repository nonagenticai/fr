// tests/unit/channels/identity-unavailable-honesty.test.ts
//
// `isTransientDependencyFault` is the discriminator the channel dispatcher uses
// to tell a transient upstream fault (refused retriably, 503 + Retry-After) from
// an fr-side bug (200 ack + error reply; re-delivery would fail identically).
// Pure-logic tests: the positive legs and the controls together pin it.

import { test, expect, describe } from 'bun:test';
import { isTransientDependencyFault } from '../../../src/channels';
import { IntegrationError } from '../../../src/integrations/_lib/errors';

/** A Postgres `57P01` (admin_shutdown) as the driver actually raises it. */
function pgAdminShutdown(): Error {
  return Object.assign(new Error('terminating connection due to administrator command'), {
    code: '57P01',
    severity: 'FATAL',
    routine: 'ProcessInterrupts',
  });
}

/** What a thrown error looks like once drizzle has wrapped it: `.cause`, no `.code`. */
function drizzleWrapped(inner: Error): Error {
  return Object.assign(new Error('Failed query: select … from approvals'), { cause: inner });
}

describe('isTransientDependencyFault', () => {
  test('the discriminator reads a DRIZZLE-WRAPPED driver fault, not just the top-level error', async () => {
    // ⚠️ THIS IS THE ARM MOST LIKELY TO BE SILENTLY BROKEN. `pgErrorCode`'s own
    // doc records that drizzle wraps every driver error in a `DrizzleQueryError`
    // carrying `.cause` and NO `.code`, which is how a `22P02` became a bare 500
    // in production for weeks. `CONNECT_TIMEOUT` (the literal string
    // `db/client.ts:166` records from a real pgbouncer failure) is additionally
    // NOT SQLSTATE-shaped, so `pgErrorCode` alone can never return it — a
    // predicate built on that helper alone would be blind to the single most
    // likely fault on both legs.
    expect(
      isTransientDependencyFault(
        drizzleWrapped(
          Object.assign(new Error('write CONNECT_TIMEOUT 10.43.0.1:6432'), {
            code: 'CONNECT_TIMEOUT',
          }),
        ),
      ),
    ).toBe(true);
    // Cycle-safe: `cause` is caller-assignable and `err.cause = err` is legal.
    const selfReferential = new Error('loop') as Error & { cause?: unknown };
    selfReferential.cause = selfReferential;
    expect(isTransientDependencyFault(selfReferential)).toBe(false);
  });

  test('CONTROL — the discriminator admits ONLY proven-transient faults', async () => {
    // Without this, a predicate that answered `true` for everything would pass
    // both positive legs above, and a predicate that answered `false` for
    // everything would pass both controls. This is the table that makes either
    // one impossible.
    const transient: unknown[] = [
      new IntegrationError({ code: 'UPSTREAM_UNREACHABLE', message: 'x', service: 's' }),
      new IntegrationError({ code: 'UPSTREAM_TIMEOUT', message: 'x', service: 's' }),
      // The upstream ANSWERED with its own "unavailable"/"too many".
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'x',
        service: 's',
        upstreamStatus: 503,
      }),
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'x',
        service: 's',
        upstreamStatus: 429,
      }),
      pgAdminShutdown(),
      Object.assign(new Error('connection exception'), { code: '08006', severity: 'FATAL' }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ];
    for (const err of transient) {
      expect(isTransientDependencyFault(err)).toBe(true);
    }

    const frSide: unknown[] = [
      // An upstream 4xx is "your request is wrong", not "try later" — the same
      // distinction `routes/agui.ts classifyError` draws one layer over.
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'x',
        service: 's',
        upstreamStatus: 404,
      }),
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'x',
        service: 's',
        upstreamStatus: 422,
      }),
      // The caller's input, fr's own invariant, and fr's own credential. None of
      // the three changes answer on a re-delivery.
      new IntegrationError({ code: 'BAD_REQUEST', message: 'x' }),
      new IntegrationError({ code: 'INTERNAL_PRECONDITION', message: 'x' }),
      new IntegrationError({ code: 'SERVICE_AUTH_FAILED', message: 'x', service: 'keycloak' }),
      new IntegrationError({ code: 'UPSTREAM_NOT_FOUND', message: 'x', service: 's' }),
      // A malformed uuid reaching Postgres: a 5-char SQLSTATE, and permanent.
      Object.assign(new Error('invalid input syntax for type uuid'), {
        code: '22P02',
        routine: 'string_to_uuid',
      }),
      // Plain fr bugs, and the non-Error shapes a `throw` can carry.
      new TypeError('undefined is not a function'),
      new Error('no code at all'),
      'a thrown string',
      null,
      undefined,
    ];
    for (const err of frSide) {
      expect(isTransientDependencyFault(err)).toBe(false);
    }
  });
});
