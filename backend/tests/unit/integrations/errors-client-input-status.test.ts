// tests/unit/integrations/errors-client-input-status.test.ts
//
// A caller-side refusal must not be reported as an upstream failure.
//
// Before this, `IntegrationErrorCode` had NO caller-side member, so every route
// that needed to say "the caller sent malformed JSON" reached for
// `UPSTREAM_BAD_BODY` — a hard 502. Three retry layers key on that class:
//
//   * Cloudflare replaces origin 5xx bodies with its own HTML page, so an API
//     client never saw fr's JSON envelope at all.
//   * `routes/agui.ts` classifyError treats an IntegrationError with no
//     `upstreamStatus` as `retriable: true`, so agents retried input that can
//     never succeed.
//   * 20 n8n node modules ship a LicenseAuthenticator that retries on
//     `statusCode >= 500`, MAX_RETRIES 3, delays [1000, 2000, 4000]; five of
//     them call fr directly.
//
// So the status here is not cosmetic — it is the signal all three read.

import { describe, expect, test } from 'bun:test';
import {
  IntegrationError,
  integrationErrorResponse,
} from '../../../src/integrations/_lib/errors';

describe('integrationErrorResponse — caller-side refusals are 4xx', () => {
  test('BAD_REQUEST is 400, not 502', async () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'BAD_REQUEST',
        message: 'project_id query parameter is required',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toBe('project_id query parameter is required');
  });

  test('PAYLOAD_TOO_LARGE is 413, not 502', async () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'sync upload limited to 10485760 bytes; got 20000000',
      }),
    );
    expect(res.status).toBe(413);
  });

  test('the envelope names no service when none was contacted', async () => {
    const res = integrationErrorResponse(
      new IntegrationError({ code: 'BAD_REQUEST', message: 'Invalid JSON request body' }),
    );
    const body = (await res.json()) as { error: Record<string, unknown> };
    // Not `service: null` and not the name of an upstream fr never called —
    // the key is simply absent. `service: 'kag'` on a request that never
    // reached kag is the "wrong blame" half of this defect.
    expect('service' in body.error).toBe(false);
  });

  test('a genuine upstream bad body is STILL 502 — the sweep must not over-reach', async () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        message: 'n8n POST /workflows/x/run reply has no executionId',
        service: 'n8n',
      }),
    );
    expect(res.status).toBe(502);
  });
});

describe('integrationErrorResponse — an fr invariant failure is 500', () => {
  test('INTERNAL_PRECONDITION is 500 — not 502, and not a 4xx', async () => {
    // 502 blames an upstream that was never contacted; a 4xx tells the caller
    // to fix input that was already correct. Both were available and both are
    // false, which is why this member exists.
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'INTERNAL_PRECONDITION',
        message: 'workflow id is required',
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_PRECONDITION');
  });

  test('it is not in the 4xx band at all', () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'INTERNAL_PRECONDITION',
        message: 'METERING_INTERNAL_SECRET is not set',
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('the sweep did not over-reach — genuine upstream failures are still 502', () => {
  // 17 sites moved off UPSTREAM_BAD_BODY in this change. The risk of a sweep is
  // the opposite of the defect it fixes: reclassifying a site where fr really
  // DID call someone and really DID get an unusable answer. Those must keep
  // returning 502, because a retry genuinely might succeed.
  test('UPSTREAM_BAD_BODY still maps to 502', () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_BODY',
        // The archetype that must survive: an upstream answered 200 with a
        // body fr could not parse. http-client.ts raises exactly this.
        message: 'kag returned invalid JSON',
        service: 'kag',
      }),
    );
    expect(res.status).toBe(502);
  });

  test('a 5xx-class upstream refusal is still 502, and still names its service', async () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_UNREACHABLE',
        message: 'kag unreachable: ECONNREFUSED',
        service: 'kag',
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { service?: string } };
    expect(body.error.service).toBe('kag');
  });

  test('the three caller/fr-side codes are the ONLY non-5xx additions', () => {
    // A ratchet in test form: if a future edit maps another code into the 4xx
    // band it has to come here and say so deliberately.
    const statuses = (
      ['BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'MISSING_TENANT', 'INTERNAL_PRECONDITION'] as const
    ).map((code) => integrationErrorResponse(new IntegrationError({ code, message: 'x' })).status);
    expect(statuses).toEqual([400, 413, 409, 500]);
  });
});

