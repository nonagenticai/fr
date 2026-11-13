/**
 * Kanban tools routes — liveness verification of the kanban WebSocket
 * subscriber pool.
 *
 * Slice: 2026-04-24-n8n-observability-kanban-liveness §"Verification"
 * (liveness route + AG-UI catalog assertion). Action name was realigned to
 * `kanban.verify_liveness` in Wave 2 of the docs/superpowers follow-up plan.
 *
 * Uses AUTH_BYPASS dev user. The `kanbanWebSocket` module's snapshot is a
 * pure read of in-memory subscriber state — no DB needed for this slice.
 */

import { describe, expect, test } from 'bun:test';

import {
  handleGetLiveness,
} from '../../../../src/routes/tools/kanban';
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



// ---------------------------------------------------------------------------
// AG-UI catalog assertion
// ---------------------------------------------------------------------------

describe('AG-UI registration — kanban.*', () => {
  test('kanban.verify_liveness registered as read+auto+cronSafe', () => {
    const all = listActions();
    const kanban = all.filter((a) => a.name.startsWith('kanban.'));
    const names = kanban.map((a) => a.name).sort();
    expect(names).toContain('kanban.verify_liveness');
    const verify = kanban.find((a) => a.name === 'kanban.verify_liveness');
    expect(verify).toBeDefined();
    expect(verify!.kind).toBe('read');
    expect(verify!.approval.type).toBe('auto');
    expect(verify!.cronSafe).toBe(true);
    expect(/^kanban\.[a-z][a-z0-9_]*$/.test(verify!.name)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// liveness HTTP route
// ---------------------------------------------------------------------------

describe('GET /api/tools/kanban/liveness', () => {
  test('returns disconnected when no subscribers', async () => {
    const req = new Request(`${BASE_URL}/api/tools/kanban/liveness`);
    const res = await handleGetLiveness(req);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.data.status).toBe('disconnected');
    expect(body.data.subscribers).toBe(0);
    expect(typeof body.data.max_lag_seconds).toBe('number');
    expect(typeof body.data.last_broadcast_seq).toBe('number');
    // Additive lag_ms field — purely for the verify_liveness contract.
    expect(typeof body.data.lag_ms).toBe('number');
    expect(body.data.lag_ms).toBe(0);
  });

  test('accepts a projectId scoping query param without erroring', async () => {
    // No subscribers for this project → snapshot is the empty case mapped to
    // disconnected. The point of this test is ensuring the projectId filter
    // is plumbed through the route → snapshot helper without throwing.
    const req = new Request(`${BASE_URL}/api/tools/kanban/liveness?projectId=proj-xyz`);
    const res = await handleGetLiveness(req);
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.data.status).toBe('disconnected');
    expect(body.data.subscribers).toBe(0);
    expect(body.data.lag_ms).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AG-UI action — additive lagMs in the output schema
// ---------------------------------------------------------------------------

describe('kanban.verify_liveness output — lagMs is additive', () => {
  test('output schema parses both maxLagSeconds and lagMs', () => {
    const all = listActions();
    const verify = all.find((a) => a.name === 'kanban.verify_liveness');
    expect(verify).toBeDefined();
    // The registry types `output` as `unknown` to avoid zod-version
    // coupling — cast to the local zod-schema shape we actually exported.
    const outputSchema = verify!.output as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const parsed = outputSchema.safeParse({
      status: 'disconnected',
      maxLagSeconds: 0,
      lagMs: 0,
      subscribers: 0,
    });
    expect(parsed.success).toBe(true);
    // Output without lagMs should now fail validation (lagMs is required
    // on the new schema). Documenting this so future drift gets caught.
    const missing = outputSchema.safeParse({
      status: 'disconnected',
      maxLagSeconds: 0,
      subscribers: 0,
    });
    expect(missing.success).toBe(false);
  });
});
