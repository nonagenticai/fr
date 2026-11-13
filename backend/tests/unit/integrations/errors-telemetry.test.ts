// tests/unit/integrations/errors-telemetry.test.ts
//
// EVERY converted IntegrationError emits structured telemetry — because the
// converter emits it, not a wrapper somebody might forget to use.
//
// MEASURED 2026-08-30, which is why this exists. `GET /api/admin/licenses/budget/:tenantId`
// returned 502 twenty-one times in one burst and left exactly ONE line per
// failure: `[http] … 502 18ms`. No code, no service, no cause. That route goes
// through `gated()` in routes/admin/licenses-admin.ts — a second copy of the
// convert-and-return pattern that never called the logger, which lived in
// routes/assets/_lib/handler.ts and covered only that wrapper's 41 call sites.
// 32 further modules call `integrationErrorResponse` DIRECTLY. The upstream
// signal from that burst is unrecoverable: nothing wrote it down.
//
// So the assertions below are about the OBSERVABLE LOG, on the paths that were
// silent. Asserting "the logger was called" would have passed in the broken
// world too — `handle()` did call it; the 502 route simply never went through
// `handle()`.

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

/** The telemetry lines, parsed. Non-JSON console noise is ignored. */
function telemetry(): Array<Record<string, unknown>> {
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => o?.telemetry === 'integration_error');
}

describe('the converter itself emits telemetry', () => {
  test('a plain upstream failure is logged with cause, not just a status', async () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'billing GET /api/budget/status/t1 returned 401',
        service: 'metering-admin',
        method: 'GET',
        path: '/api/budget/status/t1',
        upstreamStatus: 401,
      }),
    );

    expect(res.status).toBe(502);
    const [t] = telemetry();
    expect(t).toBeDefined();
    // The four fields whose absence made the live 502 undiagnosable.
    expect(t!.code).toBe('UPSTREAM_BAD_STATUS');
    expect(t!.service).toBe('metering-admin');
    expect(t!.upstream_status).toBe(401);
    expect(t!.path).toBe('/api/budget/status/t1');
  });

  test('http_status records what WE returned, distinctly from the upstream', () => {
    // `httpStatusFor` collapses upstream 401 and 5xx into 502. Logging only one
    // of the two numbers makes an access-log 502 untraceable back to the
    // credential failure that caused it — which is exactly what happened live.
    integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'upstream said 401',
        service: 'metering-admin',
        upstreamStatus: 401,
      }),
    );
    const [t] = telemetry();
    expect(t!.upstream_status).toBe(401);
    expect(t!.http_status).toBe(502);
  });

  test('the BYO 402 path logs too', () => {
    // Three return paths exist in the converter. A logger placed on only the
    // generic one would look correct and stay silent for the other two.
    integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BYO_NOT_CONFIGURED',
        message: 'worker_management returned 402',
        service: 'worker_management',
        upstreamStatus: 402,
        upstreamBody: { code: 'byo_llm_not_configured', message: 'Configure your LLM provider.' },
      }),
    );
    const [t] = telemetry();
    expect(t).toBeDefined();
    expect(t!.http_status).toBe(402);
  });

  test('the provider-not-configured 424 path logs too', () => {
    integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'no provider',
        service: 'chat',
        upstreamStatus: 424,
        upstreamBody: { error: { message: 'provider not configured: OPENAI_API_KEY missing' } },
      }),
    );
    const t = telemetry();
    expect(t.length).toBe(1);
  });
});

describe('what the telemetry must never contain', () => {
  test('the upstream BODY is not logged', () => {
    // An upstream body can carry tokens and PII. The live redaction failure that
    // printed KAG_ONBEHALF_TOKEN is why this is asserted rather than assumed.
    integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'boom',
        service: 'kag',
        upstreamStatus: 500,
        upstreamBody: { access_token: 'super-secret-value-do-not-log' },
      }),
    );
    expect(lines.join('\n')).not.toContain('super-secret-value-do-not-log');
  });

  test('logging can never turn a refusal into a 500', () => {
    // The try/catch around the log is load-bearing: a serialization failure must
    // not escalate an upstream refusal into an fr crash.
    console.error = () => {
      throw new Error('log sink exploded');
    };
    const res = integrationErrorResponse(
      new IntegrationError({ code: 'UPSTREAM_BAD_STATUS', message: 'x', service: 's' }),
    );
    expect(res.status).toBe(502);
  });
});

describe('exactly once, not twice', () => {
  test('one conversion produces one telemetry line', () => {
    // The logger used to live in routes/assets/_lib/handler.ts, which calls this
    // converter. Leaving it in BOTH places double-logs every failure that wrapper
    // handles and inflates any rate derived from the line.
    integrationErrorResponse(
      new IntegrationError({ code: 'UPSTREAM_TIMEOUT', message: 'slow', service: 'kag' }),
    );
    expect(telemetry().length).toBe(1);
  });
});
