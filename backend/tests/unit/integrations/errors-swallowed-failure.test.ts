// tests/unit/integrations/errors-swallowed-failure.test.ts
//
// fr has a whole family of `catch { rows = []; }`: a list falls back to empty, a
// rollup to zero, a sparkline to a flat line. Most of those fallbacks are
// correct — an inherited-asset lookup that has not been provisioned yet SHOULD
// degrade rather than 500 a page.
//
// The defect is not the fallback. It is that the fallback was INVISIBLE: an
// upstream outage and a genuinely empty result produced byte-identical output
// AND byte-identical logs, so afterwards nobody could tell which had happened.
// That is the same blindness the whole telemetry effort exists to end, and it is
// why a 30-day failure ranking can look clean while data is quietly missing.
//
// `reportSwallowedFailure` records the swallowed failure without changing what
// the caller returns. These assertions are about the two fields that make such a
// line USABLE — the ones a reader keys on to tell a swallowed failure from a
// served one.

import { describe, expect, test, afterEach } from 'bun:test';
import {
  IntegrationError,
  reportSwallowedFailure,
} from '../../../src/integrations/_lib/errors';

const realError = console.error;
afterEach(() => {
  console.error = realError;
});

function capture(fn: () => void): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  console.error = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    } catch {
      /* not a telemetry line */
    }
  };
  fn();
  return lines;
}

describe('a swallowed failure is still recorded', () => {
  test('it emits an integration_error line the ranking already parses', () => {
    // Deliberately the SAME `telemetry` value as the converter emits, so the
    // existing ranker picks these up with no change. A new telemetry name would
    // have meant a silent gap until someone remembered to parse it too.
    const [line] = capture(() =>
      reportSwallowedFailure(
        new IntegrationError({
          code: 'UPSTREAM_UNAUTHORIZED',
          message: 'system tenant read refused',
          service: 'kag',
          upstreamStatus: 401,
        }),
        { service: 'system-tenant-union', degradedTo: 'tenant-only rows' },
      ),
    );
    expect(line?.telemetry).toBe('integration_error');
    expect(line?.code).toBe('UPSTREAM_UNAUTHORIZED');
    expect(line?.upstream_status).toBe(401);
  });

  test('http_status is null — that is what marks it as never served', () => {
    // The discriminating field. A served failure carries a real status; a
    // swallowed one produced no response at all. Without this a reader cannot
    // separate "the user saw a 502" from "the user saw an empty list".
    const [line] = capture(() =>
      reportSwallowedFailure(new Error('boom'), {
        service: 'svc',
        degradedTo: 'empty list',
      }),
    );
    expect(line?.http_status).toBeNull();
    expect(line?.swallowed).toBe(true);
  });

  test('it records what the caller got INSTEAD, rather than leaving it inferred', () => {
    // "Something failed" is not actionable without knowing what was served in
    // its place — an empty list and a zero count are very different lies.
    const [line] = capture(() =>
      reportSwallowedFailure(new Error('boom'), {
        service: 'svc',
        degradedTo: 'tenant-only rows (no inherited system assets)',
      }),
    );
    expect(line?.degraded_to).toBe('tenant-only rows (no inherited system assets)');
  });

  test('a non-IntegrationError still produces a usable, labelled line', () => {
    // Plenty of swallowed failures are bare Errors. Dropping those would leave
    // exactly the blind spot this function exists to close.
    const [line] = capture(() =>
      reportSwallowedFailure(new Error('kaboom'), {
        service: 'svc',
        method: 'GET',
        path: '/x',
        degradedTo: 'empty list',
      }),
    );
    expect(line?.code).toBe('SWALLOWED_NON_INTEGRATION_ERROR');
    expect(line?.service).toBe('svc');
    expect(line?.path).toBe('/x');
    expect(line?.message).toBe('kaboom');
  });
});

describe('reporting a swallowed failure never becomes one', () => {
  test('a console that throws does not propagate out of the reporter', () => {
    // It is called from inside a catch block that is deliberately degrading. If
    // this threw, it would convert a handled degrade into an unhandled failure —
    // strictly worse than the silence it replaces.
    console.error = () => {
      throw new Error('logger exploded');
    };
    expect(() =>
      reportSwallowedFailure(new Error('boom'), { service: 's', degradedTo: 'x' }),
    ).not.toThrow();
  });
});
