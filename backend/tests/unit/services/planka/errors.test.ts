import { test, expect, describe } from 'bun:test';
import {
  PlankaError,
  PlankaAuthError,
  PlankaNotFoundError,
  PlankaValidationError,
  PlankaConflictError,
  PlankaServerError,
  mapPlankaError,
} from '../../../../src/services/planka/errors';

describe('PlankaError', () => {
  test('preserves status, code, and body', () => {
    const err = new PlankaError('boom', { status: 418, code: 'TEAPOT', body: { hint: 'h' } });
    expect(err.status).toBe(418);
    expect(err.code).toBe('TEAPOT');
    expect(err.body).toEqual({ hint: 'h' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('mapPlankaError', () => {
  const mkResp = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  test('401 → PlankaAuthError', async () => {
    const err = await mapPlankaError(mkResp(401, { code: 'NOT_AUTHENTICATED', message: 'nope' }), '/api/projects');
    expect(err).toBeInstanceOf(PlankaAuthError);
    expect(err.status).toBe(401);
  });

  test('404 → PlankaNotFoundError', async () => {
    const err = await mapPlankaError(mkResp(404, { code: 'NOT_FOUND' }), '/api/cards/x');
    expect(err).toBeInstanceOf(PlankaNotFoundError);
  });

  test('409 → PlankaConflictError', async () => {
    const err = await mapPlankaError(mkResp(409, { code: 'CONFLICT' }), '/api/projects');
    expect(err).toBeInstanceOf(PlankaConflictError);
  });

  test('422 → PlankaValidationError with field list', async () => {
    const err = await mapPlankaError(
      mkResp(422, { code: 'INVALID', problems: [{ attribute: 'name', message: 'required' }] }),
      '/api/projects',
    );
    expect(err).toBeInstanceOf(PlankaValidationError);
    expect((err as PlankaValidationError).fields).toEqual([{ attribute: 'name', message: 'required' }]);
  });

  test('500 → PlankaServerError', async () => {
    const err = await mapPlankaError(mkResp(500, 'ise'), '/api/projects');
    expect(err).toBeInstanceOf(PlankaServerError);
  });

  test('non-JSON body tolerated', async () => {
    const err = await mapPlankaError(mkResp(502, '<html>bad</html>'), '/api/projects');
    expect(err.status).toBe(502);
    expect(err.body).toBe('<html>bad</html>');
  });

  test('plain-text 403 includes body snippet in message (Istio RBAC case)', async () => {
    // Simulate ambient-mesh ztunnel denying the request upstream of Planka.
    const resp = new Response('RBAC: access denied', {
      status: 403,
      headers: { 'content-type': 'text/plain' },
    });
    const err = await mapPlankaError(resp, '/api/access-tokens/exchange-with-bearer');
    expect(err.status).toBe(403);
    expect(err.message).toContain('RBAC: access denied');
    expect(err.body).toBe('RBAC: access denied');
  });
});
