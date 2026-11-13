/**
 * Coding routes — AG-UI catalog assertion + handler shape checks.
 *
 * Slice: 2026-04-24-coding-analysis-ui §"Verification" (catalog assertion:
 * 5 actions; cancel HTTP route returns direct 501 NOT_SUPPORTED with no
 * action-registry / approval round-trip; trigger validates body).
 *
 * `coding.cancel_job` is intentionally not registered — see
 * plan code-review-agile-seal.md §Task #2 and the TODO in routes/tools/coding.ts.
 */

import { describe, expect, test } from 'bun:test';

import {
  handleCancelJob,
  handleListAnalysisTypes,
  handleTriggerAnalysis,
} from '../../../../src/routes/tools/coding';
import { listActions } from '../../../../src/agui/registry';

const BASE_URL = 'http://test';

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe('AG-UI registration — coding', () => {
  test('five coding actions registered with the right kinds + approval policies (cancel intentionally absent)', () => {
    const all = listActions();
    const coding = all.filter((a) => a.name.startsWith('coding.'));
    const names = coding.map((a) => a.name).sort();
    expect(names).toEqual([
      'coding.get_findings',
      'coding.get_job_status',
      'coding.list_analysis_types',
      'coding.list_jobs',
      'coding.trigger_analysis',
    ]);
    expect(names).not.toContain('coding.cancel_job');

    const byName = new Map(coding.map((a) => [a.name, a]));

    for (const n of [
      'coding.list_analysis_types',
      'coding.list_jobs',
      'coding.get_job_status',
      'coding.get_findings',
    ]) {
      const a = byName.get(n)!;
      expect(a.kind).toBe('read');
      expect(a.approval.type).toBe('auto');
    }

    {
      const a = byName.get('coding.trigger_analysis')!;
      expect(a.kind).toBe('write');
      expect(a.approval.type).toBe('single-approver');
      const policy = a.approval as { type: string; approver: string };
      expect(policy.approver).toBe('initiator');
    }

    for (const a of coding) {
      expect(/^coding\.[a-z][a-z0-9_]*$/.test(a.name)).toBe(true);
    }
  });
});

describe('GET /api/tools/coding/analysis-types', () => {
  test('returns the frozen enum', async () => {
    const req = new Request(`${BASE_URL}/api/tools/coding/analysis-types`);
    const res = await handleListAnalysisTypes(req);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.data.types).toEqual([
      'security',
      'bug_hunt',
      'quality',
      'dependencies',
      'tests',
    ]);
  });
});

describe('POST /api/tools/coding/jobs (trigger)', () => {
  test('rejects body missing client_idempotency_key', async () => {
    const req = new Request(`${BASE_URL}/api/tools/coding/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo_id: 'r', type: 'security' }),
    });
    const res = await handleTriggerAnalysis(req);
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  test('rejects body with invalid type', async () => {
    const req = new Request(`${BASE_URL}/api/tools/coding/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repo_id: 'r',
        type: 'bogus',
        client_idempotency_key: 'k',
      }),
    });
    const res = await handleTriggerAnalysis(req);
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  test('rejects malformed JSON', async () => {
    const req = new Request(`${BASE_URL}/api/tools/coding/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const res = await handleTriggerAnalysis(req);
    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('BAD_REQUEST');
  });
});

describe('POST /api/tools/coding/jobs/:id/cancel', () => {
  test('returns direct 501 NOT_SUPPORTED without invoking the action registry / approvals', async () => {
    // Snapshot the registered action names; the handler must not register,
    // unregister, or otherwise touch the action registry.
    const before = listActions()
      .map((a) => a.name)
      .sort();

    const req = new Request(`${BASE_URL}/api/tools/coding/jobs/anything/cancel`, {
      method: 'POST',
    });
    const res = await handleCancelJob(req, 'anything');
    expect(res.status).toBe(501);
    const body = await readJson(res);
    expect(body.error.code).toBe('NOT_SUPPORTED');
    expect(body.error.message).toBe('cancel_job is not exposed at this revision');
    // No upstream envelope — the route does NOT proxy through coding-gateway.
    expect(body.error.upstream).toBeUndefined();

    const after = listActions()
      .map((a) => a.name)
      .sort();
    expect(after).toEqual(before);
    expect(after).not.toContain('coding.cancel_job');
  });
});
