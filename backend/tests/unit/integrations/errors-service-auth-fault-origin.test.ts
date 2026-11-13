// tests/unit/integrations/errors-service-auth-fault-origin.test.ts
//
// A broken fr-side credential must not be reported as the caller's mistake.
//
// `httpStatusFor` passes an upstream 4xx THROUGH, which is correct: a kanban 422
// on a malformed card genuinely is the caller's fault. The boundary then used
// `UPSTREAM_BAD_STATUS` for a failed service-credential MINT too — and Keycloak
// answers **400 `invalid_client`** for a wrong client secret. So a fault the
// caller could not possibly have caused, and can do nothing about, reached them
// as HTTP 400 "your request was bad". Only 401 was special-cased.
//
// The fix classifies by WHO caused it, not by which status the token endpoint
// picked. That distinction is what these assertions pin, and it needs BOTH
// halves: "mint 400 becomes 502" alone is satisfied just as well by collapsing
// every 4xx to 502, which would destroy real caller-fault reporting across the
// whole API. The passthrough case is the control that rules that out.
//
// Why this file exists at all: the classification used to be inline in
// server.ts's boundary, and every test that appeared to cover it constructed
// the IntegrationError by hand — asserting its own input, not the mapping.

import { describe, expect, test } from 'bun:test';
import {
  IntegrationError,
  integrationErrorResponse,
  serviceAuthIntegrationError,
} from '../../../src/integrations/_lib/errors';

describe('a failed credential mint is never the caller fault', () => {
  // 400 is the one that actually shipped; the others are the special cases that
  // would have been needed one at a time under the old status-patching approach
  // (403 = client disabled, 404 = wrong realm URL, 401 = the only one handled).
  for (const upstream of [400, 401, 403, 404, 422]) {
    test(`a mint refused with ${upstream} surfaces as 502`, () => {
      const res = integrationErrorResponse(
        serviceAuthIntegrationError({
          message: `Token request failed: ${upstream}`,
          service: 'keycloak-token',
          statusCode: upstream,
        }),
      );
      expect(res.status).toBe(502);
    });
  }

  test('it is coded SERVICE_AUTH_FAILED and keeps the real upstream status', async () => {
    // The 502 is for the caller; the operator still needs to know Keycloak said
    // 400, or they cannot tell a bad secret from an unreachable endpoint.
    const res = integrationErrorResponse(
      serviceAuthIntegrationError({
        message: 'Token request failed: 400 invalid_client',
        service: 'keycloak-token',
        statusCode: 400,
      }),
    );
    const body = (await res.json()) as {
      error: { code: string; service: string; upstream?: { status: number } };
    };
    expect(body.error.code).toBe('SERVICE_AUTH_FAILED');
    expect(body.error.service).toBe('keycloak-token');
    expect(body.error.upstream?.status).toBe(400);
  });

  test('an unreachable token endpoint stays UPSTREAM_UNREACHABLE', async () => {
    // Refused and unreachable are different operator problems — a bad secret
    // versus networking. Both are 502, so only the code distinguishes them.
    const res = integrationErrorResponse(
      serviceAuthIntegrationError({
        message: 'Failed to connect to token endpoint',
        service: 'keycloak-token',
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UPSTREAM_UNREACHABLE');
  });
});

describe('the control — a genuine caller-fault upstream 4xx still passes through', () => {
  // Without this, "mint 400 -> 502" is indistinguishable from "collapse every
  // 4xx to 502", which would blame fr for every malformed request in the API.
  test('a kanban 422 on a bad card is still 422, not 502', () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'kanban POST /lists/1/cards returned 422',
        service: 'kanban',
        upstreamStatus: 422,
      }),
    );
    expect(res.status).toBe(422);
  });

  test('an upstream 400 driven by the caller is still 400', () => {
    const res = integrationErrorResponse(
      new IntegrationError({
        code: 'UPSTREAM_BAD_STATUS',
        message: 'upstream rejected the supplied filter',
        service: 'kanban',
        upstreamStatus: 400,
      }),
    );
    expect(res.status).toBe(400);
  });
});
