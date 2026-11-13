// tests/unit/analytics-rollup.test.ts
//
// Analytics rollup worker — the default metric map's PromQL shape (pure).
// The Prometheus read and the DB write are exercised live, not against stubs.

import { describe, expect, test } from 'bun:test';

import { DEFAULT_METRIC_MAP } from '../../src/workers/analytics-rollup';

describe('DEFAULT_METRIC_MAP', () => {
  test('default metric map includes tokens + cost_usd KPI entries', () => {
    const names = DEFAULT_METRIC_MAP.map((m) => m.metric);
    expect(names).toContain('tokens');
    expect(names).toContain('cost_usd');
    // PromQL must split by the canonical tenant/project/user/initiator/channel
    // labels so the writer's pivot key matches the requests-row key.
    const tokens = DEFAULT_METRIC_MAP.find((m) => m.metric === 'tokens')!;
    const cost = DEFAULT_METRIC_MAP.find((m) => m.metric === 'cost_usd')!;
    for (const promql of [tokens.promql(300), cost.promql(300)]) {
      expect(promql).toContain('tenant_id');
      expect(promql).toContain('project_id');
      expect(promql).toContain('user_id');
      expect(promql).toContain('initiator');
      expect(promql).toContain('channel');
    }
    // Tokens fold input + output into one number so the drill-down "tokens"
    // column reflects total LLM throughput.
    expect(tokens.promql(300)).toContain('input_tokens_total');
    expect(tokens.promql(300)).toContain('output_tokens_total');
    expect(cost.promql(300)).toContain('cost_usd_total');
  });
});
