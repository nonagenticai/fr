// tests/unit/integrations/errors-already-reported.test.ts
//
// A refusal is not an integration failure, and must not be COUNTED as one.
//
// MEASURED on prod 2026-09-04 (Loki, window 2026-09-02T05:37Z -> 09-04T05:34Z,
// i.e. the current binary only): 13 of the 38 `integration_error` rows — 34% of
// the entire production defect ranking — were `service: fr-streams`,
// `code: UPSTREAM_NOT_FOUND`, with `path` AND `upstream_status` both null.
//
// Nothing called `fr-streams`. There is no such upstream. They were
// `middleware/internal-tenant-only.ts refuseTenant()`: an access-control gate
// turning away a tenant it is supposed to turn away. It already emits a
// dedicated `internal_tenant_refused` line carrying strictly MORE than the
// converter can (which gate, which tenant, which set was admitted), and then
// threw an IntegrationError to produce the 404 — which the converter logged a
// second time, as an upstream failure that never happened.
//
// So the top of the fault ranking was a gate working correctly. That is the
// instrument misleading the person reading it, which is the exact failure this
// telemetry was installed to end.
//
// Both directions are pinned. Suppressing too much would be far worse than the
// double count: `alreadyReported` must silence the LOG only, never the status,
// and must never apply to an error no other stream recorded.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import {
  IntegrationError,
  integrationErrorResponse,
} from '../../../src/integrations/_lib/errors';

const realError = console.error;
let lines: string[] = [];

beforeEach(() => {
  lines = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
});
afterEach(() => {
  console.error = realError;
});

/** Parsed telemetry lines of one kind. Non-JSON console noise is ignored. */
function telemetryOfKind(kind: string): Array<Record<string, unknown>> {
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => !!o && o.telemetry === kind);
}

describe('alreadyReported suppresses the duplicate line, not the failure', () => {
  test('no integration_error line is emitted', () => {
    integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_NOT_FOUND',
        message: 'Not found',
        service: 'fr-streams',
        alreadyReported: true,
      }),
    );

    expect(telemetryOfKind('integration_error')).toHaveLength(0);
  });

  test('the HTTP status is unchanged — only the log is suppressed', async () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_NOT_FOUND',
        message: 'Not found',
        service: 'fr-streams',
        alreadyReported: true,
      }),
    );

    // The whole point: callers, clients and status mapping see NO difference.
    expect(res.status).toBe(404);
  });
});

describe('the ordinary path is untouched (negative control)', () => {
  test('without the flag, the same error DOES emit integration_error', () => {
    // If this ever goes quiet, the flag has leaked into the default and the
    // telemetry has been silenced rather than de-duplicated.
    integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_NOT_FOUND',
        message: 'Not found',
        service: 'fr-streams',
      }),
    );

    const rows = telemetryOfKind('integration_error');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'UPSTREAM_NOT_FOUND', service: 'fr-streams' });
  });
});
