// The upstream body must not reach the telemetry line — INCLUDING when a
// producer inlines it into `message`.
//
// `logIntegrationFailure` carries the comment "the upstream body is
// deliberately NOT logged — it can carry tokens and PII", and the existing test
// for that invariant puts the secret in `upstreamBody` only. That is the easy
// half. Producers were defeating it from the other side:
//
//   services/metering-admin.ts:141,250,321   message: `… ${res.status}: ${text}`
//   routes/documents.ts:261,272              message: `… ${body}`
//
// `text`/`body` ARE the upstream response body. metering-admin reaches the
// converter through `gated()` (routes/admin/licenses-admin.ts), which carried NO
// telemetry at all until 2026-09-01 — so those bodies were never in the logs and
// the move of logging into the converter would newly have written them there.
// Found by an adversarial audit of the merged PR, not by this suite.
//
// The fix is at the producer: the body goes to `upstreamBody`, which is not
// logged, and `message` names the failure without quoting it. These cases pin
// BOTH halves so a future producer cannot quietly reopen the hole.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import {
  IntegrationError,
  integrationErrorResponse,
} from '../../../src/integrations/_lib/errors';

const realError = console.error;
let lines: string[] = [];
beforeEach(() => {
  lines = [];
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
});
afterEach(() => {
  console.error = realError;
});

const SECRET = 'sk-live-DO-NOT-LOG-9f3a2b';

describe('a secret in the upstream BODY is not logged', () => {
  test('the original invariant still holds', () => {
    integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'billing returned 500',
        service: 'metering-admin',
        upstreamStatus: 500,
        upstreamBody: { token: SECRET },
      }),
    );
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('a secret inlined into the MESSAGE is the half that leaked', () => {
  test('the producer must not put an upstream body in `message`', () => {
    // ⚠️ This asserts the PRODUCER contract, because the converter cannot tell a
    // body quoted inside a message from ordinary diagnostic prose. Redacting at
    // the log site was rejected deliberately: a redaction heuristic fails in
    // BOTH directions — it leaks novel secret shapes and mangles innocent text.
    // Keeping bodies out of `message` is checkable; guessing what is secret is
    // not.
    const src = require('node:fs').readFileSync(
      new URL('../../../src/services/metering-admin.ts', import.meta.url),
      'utf8',
    ) as string;
    // No `message:` template may interpolate the raw response text/parsed body.
    expect(src).not.toMatch(/message: `[^`]*\$\{\s*text\s*\}/);
    expect(src).not.toMatch(/message: `[^`]*\$\{[^}]*JSON\.stringify\(parsed\)/);
  });

  test('and the body is still available for the CLIENT response', () => {
    // Moving it must not lose it: the HTTP body still carries `upstream.body`,
    // so an operator reading the API response sees the cause. Only the LOG is
    // narrowed.
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'metering-admin getBudgetStatus returned 500',
        service: 'metering-admin',
        upstreamStatus: 500,
        upstreamBody: 'detail that helps an operator',
      }),
    );
    expect(res.status).toBe(502);
  });
});
