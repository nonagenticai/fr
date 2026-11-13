// Raw upstream detail must not reach a non-super-admin browser.
//
// Measured: a customer's /chat showed
//   "worker_management GET /providers/xai/models returned 403"
// plus `service` and the upstream's own body — fr's internal service names and
// paths, served to the public. The converter now redacts for every request
// frame whose VERIFIED caller is not a super-admin; the full detail stays on the
// log line (`logIntegrationFailure`).

import { describe, expect, test } from 'bun:test';
import {
  IntegrationError,
  integrationErrorResponse,
} from '../../../src/integrations/_lib/errors';
import {
  withRequestContext,
  type RequestContext,
} from '../../../src/integrations/_lib/context';
import { buildRequestContext } from '../../../src/middleware/request-context';

function frame(callerIsSuperAdmin?: boolean): RequestContext {
  return {
    correlationId: 'redaction-test',
    initiator: 'human',
    channel: 'web',
    tenantId: '0195f48b-d000-7000-8000-0000000000cc',
    ...(callerIsSuperAdmin === undefined ? {} : { callerIsSuperAdmin }),
  };
}

function forbidden403(): IntegrationError {
  return new IntegrationError({
    code: 'UPSTREAM_BAD_STATUS',
    message: 'worker_management GET /providers/xai/models returned 403',
    service: 'worker_management',
    path: '/providers/xai/models',
    method: 'GET',
    upstreamStatus: 403,
    upstreamBody: { detail: 'xai blocked by policy at http://worker-management.example.com' },
  });
}

async function bodyOf(res: Response): Promise<{ error: Record<string, unknown> }> {
  return (await res.json()) as { error: Record<string, unknown> };
}

describe('integrationErrorResponse — non-super-admin caller', () => {
  test('upstream 403: generic message, no service, no upstream body', async () => {
    const res = await withRequestContext(frame(false), async () =>
      integrationErrorResponse(forbidden403()),
    );
    expect(res.status).toBe(403);
    const { error } = await bodyOf(res);
    expect(error.message).toBe('You do not have access to this');
    expect(error.service).toBeUndefined();
    expect((error.upstream as Record<string, unknown>).body).toBeUndefined();
    const raw = JSON.stringify(error);
    expect(raw).not.toContain('worker_management');
    expect(raw).not.toContain('/providers/');
    expect(raw).not.toContain('svc.cluster.local');
  });

  test('a frame that never set the flag is redacted too (fail closed)', async () => {
    const res = await withRequestContext(frame(undefined), async () =>
      integrationErrorResponse(forbidden403()),
    );
    const { error } = await bodyOf(res);
    expect(error.service).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('worker_management');
  });

  test('unreachable upstream (502): generic message, no service', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_UNREACHABLE',
      message: 'kag POST http://kag.example.com:8000/ingest could not connect',
      service: 'kag',
    });
    const res = await withRequestContext(frame(false), async () => integrationErrorResponse(err));
    expect(res.status).toBe(502);
    const { error } = await bodyOf(res);
    expect(error.message).toBe('A backing service failed — try again');
    expect(error.service).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('svc.cluster.local');
  });

  test('upstream 422 keeps the body (it describes the caller\'s own input) but drops service', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: 'requirements_management PUT /principles/x returned 422',
      service: 'requirements_management',
      upstreamStatus: 422,
      upstreamBody: { detail: [{ loc: ['body', 'title'], msg: 'Field required' }] },
    });
    const res = await withRequestContext(frame(false), async () => integrationErrorResponse(err));
    expect(res.status).toBe(422);
    const { error } = await bodyOf(res);
    expect(error.service).toBeUndefined();
    expect(error.message).toBe('The request was rejected');
    expect((error.upstream as Record<string, unknown>).body).toEqual({
      detail: [{ loc: ['body', 'title'], msg: 'Field required' }],
    });
  });

  // kag's proxy re-raises a downstream 4xx as "Backend service error (<status>):
  // <500-char preview of the internal service's body>". Under a 409/422 that is
  // NOT the caller's own input — it is another service's response.
  test('kag proxy-wrapped 409 body is withheld from a non-super-admin', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_CONFLICT',
      message: 'kag POST /documents/upload returned 409',
      service: 'kag',
      upstreamStatus: 409,
      upstreamBody: {
        detail:
          'Backend service error (409): {"detail":"duplicate at http://ingestion.example.com:8080/jobs"}',
      },
    });
    const res = await withRequestContext(frame(false), async () => integrationErrorResponse(err));
    expect(res.status).toBe(409);
    const { error } = await bodyOf(res);
    expect((error.upstream as Record<string, unknown>).status).toBe(409);
    expect((error.upstream as Record<string, unknown>).body).toBeUndefined();
    const raw = JSON.stringify(error);
    expect(raw).not.toContain('Backend service error');
    expect(raw).not.toContain('svc.cluster.local');
  });

  test('kag proxy-wrapped 422 as a bare string body is withheld too', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: 'kag POST /query returned 422',
      service: 'kag',
      upstreamStatus: 422,
      upstreamBody: 'Backend service error (422): graph-adapter rejected tenant 0195 at /internal/q',
    });
    const res = await withRequestContext(frame(false), async () => integrationErrorResponse(err));
    const { error } = await bodyOf(res);
    expect(JSON.stringify(error)).not.toContain('graph-adapter');
  });

  test('a validation list keeps only loc/msg/type (no echoed input)', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: 'requirements_management PUT /principles/x returned 422',
      service: 'requirements_management',
      upstreamStatus: 422,
      upstreamBody: {
        detail: [
          { loc: ['body', 'title'], msg: 'Field required', type: 'missing', input: { secret: 'x' }, url: 'https://errors.pydantic.dev' },
        ],
      },
    });
    const res = await withRequestContext(frame(false), async () => integrationErrorResponse(err));
    const { error } = await bodyOf(res);
    expect((error.upstream as Record<string, unknown>).body).toEqual({
      detail: [{ loc: ['body', 'title'], msg: 'Field required', type: 'missing' }],
    });
  });

  test('a super-admin still sees the proxy-wrapped body', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_CONFLICT',
      message: 'kag POST /documents/upload returned 409',
      service: 'kag',
      upstreamStatus: 409,
      upstreamBody: { detail: 'Backend service error (409): dup' },
    });
    const res = await withRequestContext(frame(true), async () => integrationErrorResponse(err));
    const { error } = await bodyOf(res);
    expect((error.upstream as Record<string, unknown>).body).toEqual({
      detail: 'Backend service error (409): dup',
    });
  });

  test('an fr-local caller-input code keeps fr\'s own message', async () => {
    const err = new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'project_id is required',
      service: 'bridge',
    });
    const res = await withRequestContext(frame(false), async () => integrationErrorResponse(err));
    const { error } = await bodyOf(res);
    expect(error.message).toBe('project_id is required');
    expect(error.service).toBeUndefined();
  });

  test('provider_not_configured keeps its actionable sentence, drops service + body', async () => {
    const err = new IntegrationError({
      code: 'UPSTREAM_BAD_STATUS',
      message: 'worker_management GET /providers/anthropic/models returned 502',
      service: 'worker_management',
      upstreamStatus: 502,
      upstreamBody: {
        error: {
          code: 'BAD_GATEWAY',
          message: "Upstream unreachable for provider 'anthropic': ANTHROPIC_API_KEY is not configured",
          status: 502,
        },
      },
    });
    const res = await withRequestContext(frame(false), async () => integrationErrorResponse(err));
    expect(res.status).toBe(424);
    const { error } = await bodyOf(res);
    expect(error.code).toBe('provider_not_configured');
    expect(String(error.message)).toContain('not configured');
    expect(error.service).toBeUndefined();
    expect((error.upstream as Record<string, unknown>).body).toBeUndefined();
  });
});

describe('integrationErrorResponse — super-admin caller keeps full detail', () => {
  test('raw message, service and upstream body are present', async () => {
    const res = await withRequestContext(frame(true), async () =>
      integrationErrorResponse(forbidden403()),
    );
    const { error } = await bodyOf(res);
    expect(error.message).toBe('worker_management GET /providers/xai/models returned 403');
    expect(error.service).toBe('worker_management');
    expect((error.upstream as Record<string, unknown>).body).toBeDefined();
  });
});

describe('buildRequestContext: callerIsSuperAdmin is false without a VERIFIED super_admin token', () => {
  test('no bearer → false', async () => {
    const ctx = await buildRequestContext(new Request('http://x'));
    expect(ctx.callerIsSuperAdmin).toBe(false);
  });

  // A FORGED token claiming super_admin must never unlock raw upstream detail.
  const forgedClaims = {
    iss: 'https://test-issuer.fr.test/realms/test',
    sub: '7c9b6c8f-1111-2222-3333-444444444444',
    tenant_id: '0195f48b-d000-7000-8000-0000000000cc',
    realm_access: { roles: ['super_admin'] },
  };
  async function ctxForToken(token: string) {
    return buildRequestContext(
      new Request('http://x', { headers: { Authorization: `Bearer ${token}` } }),
    );
  }

  test('an UNSIGNED (alg:none) token claiming super_admin → false', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(forgedClaims)}.`;
    expect((await ctxForToken(token)).callerIsSuperAdmin).toBe(false);
  });

  test('a token signed by a STRANGER key (same kid) claiming super_admin → false', async () => {
    const { generateKeyPair, SignJWT } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT(forgedClaims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid-1' })
      .sign(privateKey);
    expect((await ctxForToken(token)).callerIsSuperAdmin).toBe(false);
  });
});

describe('clientSafePlankaErrorMessage — routes that render a PlankaError themselves', () => {
  test('never returns the mapped operator string (internal path + raw body)', async () => {
    const { clientSafePlankaErrorMessage } = await import('../../../src/utils/errors');
    const { PlankaError, PlankaForbiddenError } = await import('../../../src/services/planka/errors');
    const raw = 'Planka 500 on /api/cards/123/custom-field-values: RBAC: access denied';
    expect(clientSafePlankaErrorMessage(new PlankaError(raw, { status: 500 }), 't')).toBe('Upstream error');
    expect(clientSafePlankaErrorMessage(new PlankaForbiddenError(raw, { status: 403 }), 't')).toBe('Forbidden');
  });
});
