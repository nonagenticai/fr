// tests/unit/services/conveyor-start-webhook-body.test.ts
//
// The conveyor start webhook's wire body (services/conveyor-start-webhook.ts): EXACTLY the four
// keys, in order, for the first start and the start-card retry; those four plus `restart` for a
// project or phase restart (George 2026-10-31 — the contract the conveyor implements).
import { describe, expect, test } from 'bun:test';

import { conveyorStartBody, conveyorStartRequest, signConveyorStartBody } from '../../../src/services/conveyor-start-webhook';

const E = {
  rm_project_id: '0199aaaa-0000-7000-8000-00000000a001',
  tenant_id: '0199aaaa-0000-7000-8000-00000000b001',
  fr_project_id: '0199aaaa-0000-7000-8000-00000000c001',
};

describe('conveyorStartBody', () => {
  test('without a restart: exactly the four keys, in order, byte-identical to the start it always was', () => {
    const body = conveyorStartBody({ ...E, idempotency_key: `${E.fr_project_id}:retry-2` });
    expect(Object.keys(JSON.parse(body))).toEqual(['event', 'rm_project_id', 'tenant_id', 'fr_project_id']);
    expect(body).toBe(
      `{"event":"project.created","rm_project_id":"${E.rm_project_id}","tenant_id":"${E.tenant_id}","fr_project_id":"${E.fr_project_id}"}`,
    );
  });

  test('a project restart: the four keys plus restart {scope:"project"} last', () => {
    const body = JSON.parse(conveyorStartBody({ ...E, restart: { scope: 'project' } }));
    expect(Object.keys(body)).toEqual(['event', 'rm_project_id', 'tenant_id', 'fr_project_id', 'restart']);
    expect(body.event).toBe('project.created');
    expect(body.restart).toEqual({ scope: 'project' });
  });

  test('a phase restart carries the phase name, and nothing else', () => {
    const body = JSON.parse(conveyorStartBody({ ...E, restart: { scope: 'phase', phase: 'execution' } }));
    expect(Object.keys(body)).toHaveLength(5);
    expect(body.restart).toEqual({ scope: 'phase', phase: 'execution' });
  });

  test("R349: a restart's comment rides in restart, after scope (and phase); an absent comment adds no key", () => {
    expect(JSON.parse(conveyorStartBody({ ...E, restart: { scope: 'phase', phase: 'preliminary', comment: 'Use the v2 brief' } })).restart).toEqual({
      scope: 'phase',
      phase: 'preliminary',
      comment: 'Use the v2 brief',
    });
    expect(JSON.parse(conveyorStartBody({ ...E, restart: { scope: 'project', comment: 'Start over' } })).restart).toEqual({
      scope: 'project',
      comment: 'Start over',
    });
  });
});

describe('conveyorStartRequest (the built request a restart sends)', () => {
  const SECRET = 'test-secret-not-real';

  test('a restart: the 5-key body, signed, under Idempotency-Key <fr id>:restart-<n>', () => {
    const key = `${E.fr_project_id}:restart-3`;
    const r = conveyorStartRequest({ ...E, idempotency_key: key, restart: { scope: 'phase', phase: 'execution' } }, SECRET);
    expect(JSON.parse(r.body)).toEqual({ event: 'project.created', ...E, restart: { scope: 'phase', phase: 'execution' } });
    expect(r.headers['Idempotency-Key']).toBe(key);
    expect(r.headers['X-FR-Signature']).toBe(signConveyorStartBody(r.body, SECRET));
    expect(r.headers['Content-Type']).toBe('application/json');
  });

  test('the first start keeps the bare fr id as its key; a retry its own key; both bodies are 4 keys', () => {
    const first = conveyorStartRequest(E, SECRET);
    expect(first.headers['Idempotency-Key']).toBe(E.fr_project_id);
    const retry = conveyorStartRequest({ ...E, idempotency_key: `${E.fr_project_id}:retry-2` }, SECRET);
    expect(retry.headers['Idempotency-Key']).toBe(`${E.fr_project_id}:retry-2`);
    expect(retry.body).toBe(first.body);
  });
});
