// tests/unit/analytics-actions.test.ts
//
// Wave-3 analytics slice — AG-UI action shape coverage.
//
// We import the route module so the three actions self-register, then look
// them up via the registry's `listActions()` and assert:
//   - all three names exist (analytics.summary / breakdown / export)
//   - kind=read, approval={type:'auto'}, cronSafe=true
//   - input/output schemas accept canonical input + reject obvious bad input
//
// The registry import order matters: the side-effect register at module
// bottom of `routes/tools/analytics.ts` runs once when first imported.

import { beforeAll, describe, expect, test } from 'bun:test';

process.env.AUTH_BYPASS = 'true';

import { listActions } from '../../src/agui/registry';
import { pivotBreakdownRows } from '../../src/routes/tools/analytics';

let summary: ReturnType<typeof listActions>[number] | undefined;
let breakdown: ReturnType<typeof listActions>[number] | undefined;
let exp: ReturnType<typeof listActions>[number] | undefined;
let perChannel: ReturnType<typeof listActions>[number] | undefined;

beforeAll(async () => {
  // Side-effect import — registers the four actions.
  await import('../../src/routes/tools/analytics');
  const all = listActions();
  summary = all.find((a) => a.name === 'analytics.summary');
  breakdown = all.find((a) => a.name === 'analytics.breakdown');
  exp = all.find((a) => a.name === 'analytics.export');
  perChannel = all.find((a) => a.name === 'analytics.per_channel');
});

describe('AG-UI catalog — analytics.*', () => {
  test('all four actions registered', () => {
    expect(summary).toBeDefined();
    expect(breakdown).toBeDefined();
    expect(exp).toBeDefined();
    expect(perChannel).toBeDefined();
  });

  test('every action is read / auto-approved / cron-safe (spec §7)', () => {
    for (const a of [summary, breakdown, exp, perChannel]) {
      expect(a!.kind).toBe('read');
      expect(a!.approval).toEqual({ type: 'auto' });
      expect(a!.cronSafe).toBe(true);
    }
  });

  test('summary input accepts canonical filter set, rejects bad window', () => {
    const ok = (summary!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      window: '7d',
      project_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(ok.success).toBe(true);

    const bad = (summary!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      window: '1y', // not a permitted enum
    });
    expect(bad.success).toBe(false);
  });

  test('breakdown input rejects unknown dimension', () => {
    const bad = (breakdown!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      window: '7d',
      dimension: 'banana',
      metric: 'kag.ingests.upload',
    });
    expect(bad.success).toBe(false);
  });

  test('idempotency keys are deterministic + non-empty within the same minute', async () => {
    const inputA = { window: '7d', project_id: '11111111-1111-1111-1111-111111111111' };
    const k1 = await summary!.idempotencyKey(inputA);
    const k2 = await summary!.idempotencyKey(inputA);
    expect(k1).toBe(k2);
    expect(k1.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Plan-4 Lane B — compare=prev + per-channel
  // -------------------------------------------------------------------------

  test('summary input accepts compare=prev', () => {
    const ok = (summary!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      window: '7d',
      compare: 'prev',
    });
    expect(ok.success).toBe(true);
  });

  test('summary input rejects unknown compare value', () => {
    const bad = (summary!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      window: '7d',
      compare: 'yoy', // not yet supported
    });
    expect(bad.success).toBe(false);
  });

  test('breakdown input accepts compare=prev', () => {
    const ok = (breakdown!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      window: '7d',
      dimension: 'channel',
      metric: 'kag.ingests.upload',
      compare: 'prev',
    });
    expect(ok.success).toBe(true);
  });

  test('per_channel input accepts default + project_id', () => {
    const ok = (perChannel!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      project_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(ok.success).toBe(true);

    const okBare = (
      perChannel!.input as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({});
    expect(okBare.success).toBe(true); // window defaults to 30d
  });

  test('per_channel input rejects bad window', () => {
    const bad = (perChannel!.input as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      window: '1y',
    });
    expect(bad.success).toBe(false);
  });

  test('per_channel idempotency key is stable within the same minute', () => {
    const k1 = perChannel!.idempotencyKey({ window: '30d' });
    const k2 = perChannel!.idempotencyKey({ window: '30d' });
    expect(k1).toBe(k2);
    expect(k1).toContain('analytics.per_channel');
  });
});

// ---------------------------------------------------------------------------
// Drill-down pivot — tokens + cost_usd land on each dimension cell
// ---------------------------------------------------------------------------

describe('breakdown pivot — tokens + cost_usd folded into each row', () => {
  test('pivots tokens + cost_usd onto each dimension key when dimension != tool', () => {
    // Three (key, metric_name, value) triplets mimic the GROUP BY 1, metric_name
    // result: for dimension=initiator, 'human' has 5 requests / 1200 tokens / 0.42 cost.
    const rows = [
      { key: 'human', metric_name: 'kag.ingests.upload', value: 5 },
      { key: 'human', metric_name: 'tokens', value: 1200 },
      { key: 'human', metric_name: 'cost_usd', value: 0.42 },
      { key: 'agent', metric_name: 'kag.ingests.upload', value: 2 },
      // No tokens / cost_usd for 'agent' → stays null (drill-down renders "—").
    ];
    const out = pivotBreakdownRows(rows, 'kag.ingests.upload', 'initiator');
    expect(out).toHaveLength(2);
    // Sorted by value desc → human first.
    expect(out[0]).toEqual({ key: 'human', value: 5, tokens: 1200, cost_usd: 0.42 });
    expect(out[1]).toEqual({ key: 'agent', value: 2, tokens: null, cost_usd: null });
  });

  test('tokens / cost_usd rows are stripped from dimension=tool results and folded as tenant totals', () => {
    // For dimension='tool', metric_name IS the dimension key, so 'tokens' /
    // 'cost_usd' show up as rows themselves; the pivot strips them and
    // duplicates their totals onto every real tool key.
    const rows = [
      { key: 'kag.ingests.upload', metric_name: 'kag.ingests.upload', value: 7 },
      { key: 'coding.findings.new', metric_name: 'coding.findings.new', value: 3 },
      // The query filters metric_name IN (input.metric, 'tokens', 'cost_usd');
      // for dimension=tool, the requested metric matches its own key. Other
      // metric_name='tokens' rows show up under their own key (because the
      // dimension column IS metric_name). We model that here.
      { key: 'tokens', metric_name: 'tokens', value: 5000 },
      { key: 'cost_usd', metric_name: 'cost_usd', value: 1.23 },
    ];
    const out = pivotBreakdownRows(rows, 'kag.ingests.upload', 'tool');
    // 'tokens' / 'cost_usd' meta-keys are stripped.
    expect(out.find((r) => r.key === 'tokens')).toBeUndefined();
    expect(out.find((r) => r.key === 'cost_usd')).toBeUndefined();
    // Real tool keys carry the cross-cutting tenant totals.
    for (const r of out) {
      expect(r.tokens).toBe(5000);
      expect(r.cost_usd).toBeCloseTo(1.23);
    }
    expect(out.find((r) => r.key === 'kag.ingests.upload')?.value).toBe(7);
  });

  test('returns null tokens/cost_usd when upstream rows are missing entirely', () => {
    // Legacy buckets — only 'requests'-equivalent rows exist.
    const rows = [
      { key: 'web', metric_name: 'kag.ingests.upload', value: 4 },
    ];
    const out = pivotBreakdownRows(rows, 'kag.ingests.upload', 'channel');
    expect(out).toEqual([{ key: 'web', value: 4, tokens: null, cost_usd: null }]);
  });
});
