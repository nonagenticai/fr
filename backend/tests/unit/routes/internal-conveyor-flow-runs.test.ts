// tests/unit/routes/internal-conveyor-flow-runs.test.ts
//
// Cockpit A5 / R-CK5 — POST /api/internal/conveyor/flow-runs: the S2S door and the body rules.
// No database: the door test is refused before any write, and the body rules are pure parsing.
// The DB-backed upsert / terminal rule is not covered here.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { handleIngestConveyorFlowRuns } from '../../../src/routes/internal-conveyor-flow-runs';
import {
  ERROR_MESSAGE_MAX,
  parseFlowRunRecord,
  recordsOf,
  FlowRunBodyError,
} from '../../../src/services/conveyor-flow-runs';

const ISSUER = 'https://auth.invalid/realms/secure-apps';
const HOOK_AZP = 'n8n-flow-run-hook';

const saved = { azp: process.env.FR_FLOW_RUN_WRITER_AZP, iss: process.env.FR_FLOW_RUN_ISSUER, bypass: process.env.AUTH_BYPASS };
beforeEach(() => {
  process.env.FR_FLOW_RUN_WRITER_AZP = HOOK_AZP;
  process.env.FR_FLOW_RUN_ISSUER = ISSUER;
  delete process.env.AUTH_BYPASS;
});
afterAll(() => {
  for (const [k, v] of [
    ['FR_FLOW_RUN_WRITER_AZP', saved.azp],
    ['FR_FLOW_RUN_ISSUER', saved.iss],
    ['AUTH_BYPASS', saved.bypass],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('the S2S door', () => {
  test('no bearer ⇒ 401 through the REAL validateAuth', async () => {
    const res = await handleIngestConveyorFlowRuns(
      new Request('http://fr.test/api/internal/conveyor/flow-runs', { method: 'POST', body: '[]' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('record validation (parseFlowRunRecord / recordsOf)', () => {
  test('a minimal record normalises; numbers become strings; aliases map', () => {
    const r = parseFlowRunRecord({ execution_id: 12345, status: 'waiting', workflow: 'ct.x', project_id: 'rm-eid-1', card_id: 99 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.execution_id).toBe('12345');
    expect(r.record.workflow_name).toBe('ct.x');
    expect(r.record.project_ref).toBe('rm-eid-1');
    expect(r.record.card_id).toBe('99');
    expect(r.record.started_at).toBeNull();
  });

  test('canonical names win over aliases; unknown keys are ignored', () => {
    const r = parseFlowRunRecord({ execution_id: 'e', status: 'success', workflow: 'alias', workflow_name: 'canon', project_ref: 'p', project_id: 'q', extra: 1 });
    expect(r.ok && r.record.workflow_name).toBe('canon');
    expect(r.ok && r.record.project_ref).toBe('p');
  });

  test('error_message is clipped to 2000, never refused for length', () => {
    const r = parseFlowRunRecord({ execution_id: 'e', status: 'error', error_message: 'x'.repeat(5000) });
    expect(r.ok && r.record.error_message?.length).toBe(ERROR_MESSAGE_MAX);
  });

  test('bad status, missing id, bad timestamp are refused with a reason', () => {
    expect(parseFlowRunRecord({ execution_id: 'e', status: 'done' }).ok).toBe(false);
    expect(parseFlowRunRecord({ status: 'success' }).ok).toBe(false);
    expect(parseFlowRunRecord({ execution_id: '', status: 'success' }).ok).toBe(false);
    const bad = parseFlowRunRecord({ execution_id: 'e', status: 'success', started_at: 'yesterday' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('started_at');
    const ok = parseFlowRunRecord({ execution_id: 'e', status: 'success', started_at: '2026-10-25T10:00:00Z' });
    expect(ok.ok && ok.record.started_at?.toISOString()).toBe('2026-10-25T10:00:00.000Z');
    expect(parseFlowRunRecord(null).ok).toBe(false);
  });

  test('recordsOf: one object, an array, {records}; bad shapes throw FlowRunBodyError', () => {
    expect(recordsOf({ execution_id: 'a' })).toHaveLength(1);
    expect(recordsOf([{}, {}])).toHaveLength(2);
    expect(recordsOf({ records: [{}, {}, {}] })).toHaveLength(3);
    expect(() => recordsOf(42)).toThrow(FlowRunBodyError);
    expect(() => recordsOf([])).toThrow(FlowRunBodyError);
  });
});
