import { describe, expect, test } from 'bun:test';

import {
  adaptAugmentedGraph,
  adaptQualityGateResult,
  buildDegradedDependencyReport,
} from '../../../../src/routes/coding/adapters';

describe('adaptAugmentedGraph', () => {
  test('normalizes raw graph nodes/edges into the frontend shape', () => {
    const raw = {
      nodes: [
        { id: 'n1', type: 'module', properties: { name: 'auth' } },
        { id: 'n2', type: 'module', properties: { label: 'db' } },
        { id: 'n3', type: 'service', properties: {} },
      ],
      edges: [
        { source: 'n1', target: 'n2', relationship: 'imports' },
        { source: 'n2', target: 'n3' },
      ],
    };

    const adapted = adaptAugmentedGraph(raw);

    // label = properties.name ?? properties.label ?? id
    expect(adapted.nodes).toEqual([
      { id: 'n1', label: 'auth', type: 'module', metadata: { name: 'auth' } },
      { id: 'n2', label: 'db', type: 'module', metadata: { label: 'db' } },
      { id: 'n3', label: 'n3', type: 'service', metadata: {} },
    ]);
    // edge.type = relationship ?? 'dependency'
    expect(adapted.edges).toEqual([
      { source: 'n1', target: 'n2', type: 'imports' },
      { source: 'n2', target: 'n3', type: 'dependency' },
    ]);
    expect(typeof adapted.timestamp).toBe('string');
    expect(Number.isNaN(new Date(adapted.timestamp).getTime())).toBe(false);
  });

  test('missing / empty nodes and edges normalize to empty arrays', () => {
    expect(adaptAugmentedGraph({}).nodes).toEqual([]);
    expect(adaptAugmentedGraph({}).edges).toEqual([]);
    expect(adaptAugmentedGraph({ nodes: null, edges: undefined }).nodes).toEqual([]);
    expect(adaptAugmentedGraph(undefined).edges).toEqual([]);
  });

  test('preserves an upstream-provided timestamp', () => {
    const adapted = adaptAugmentedGraph({ nodes: [], edges: [], timestamp: '2026-07-01T00:00:00Z' });
    expect(adapted.timestamp).toBe('2026-07-01T00:00:00Z');
  });
});

describe('adaptQualityGateResult', () => {
  const raw = {
    passed: false,
    overall_score: 72.5,
    grade: 'C',
    gate_checks: [
      {
        name: 'minimum_score',
        description: 'Overall score must be >= 70',
        passed: true,
        actual: 72.5,
        threshold: 70,
      },
      {
        name: 'critical_issues',
        description: 'No critical issues allowed',
        passed: false,
        actual: 2,
        threshold: 0,
      },
    ],
    recommendations: ['Fix the two critical issues before merging.'],
  };

  test('maps QualityGateResult → frontend QualityGate shape', () => {
    const adapted = adaptQualityGateResult('codegraph-hello', raw);

    expect(adapted.container_name).toBe('codegraph-hello');
    expect(adapted.status).toBe('warning');
    expect(adapted.overall_score).toBe(72.5);
    expect(adapted.grade).toBe('C');
    expect(adapted.recommendations).toEqual(raw.recommendations);

    const metrics = adapted.metrics as Array<Record<string, unknown>>;
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({
      name: 'minimum_score',
      status: 'passed',
      value: 72.5,
      threshold: 70,
    });
    expect(metrics[1]).toMatchObject({
      name: 'critical_issues',
      status: 'failed',
      value: 2,
      threshold: 0,
    });
  });

  test('status = passed when raw.passed is true', () => {
    const adapted = adaptQualityGateResult('c', { ...raw, passed: true, grade: 'A' });
    expect(adapted.status).toBe('passed');
  });

  test('status = failed when grade is F', () => {
    const adapted = adaptQualityGateResult('c', { ...raw, passed: false, grade: 'F' });
    expect(adapted.status).toBe('failed');
  });

  test('timestamp is a valid ISO string', () => {
    const adapted = adaptQualityGateResult('c', raw);
    expect(typeof adapted.timestamp).toBe('string');
    expect(() => new Date(adapted.timestamp as string).toISOString()).not.toThrow();
    expect(Number.isNaN(new Date(adapted.timestamp as string).getTime())).toBe(false);
  });

  test('tolerates missing gate_checks / recommendations', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: true,
      overall_score: 100,
      grade: 'A',
    });
    expect(adapted.metrics).toEqual([]);
    expect(adapted.recommendations).toEqual([]);
  });

  // Honesty pins (§8.2): an inconclusive gate — coding-analysis abstained
  // because no analysis tool succeeded — must NOT be dressed up as a warning,
  // and its -1.0 sentinel score must never reach the frontend.
  test('inconclusive gate → status "inconclusive" (never "warning")', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: false,
      overall_score: -1.0,
      grade: 'N/A',
      inconclusive: true,
    });
    expect(adapted.status).toBe('inconclusive');
    expect(adapted.status).not.toBe('warning');
    expect(adapted.inconclusive).toBe(true);
    // The -1.0 sentinel is nulled, not passed through (and not coerced to 0).
    expect(adapted.overall_score).toBeNull();
    expect(adapted.grade).toBe('N/A');
  });

  test('a conclusive gate carries inconclusive:false and its real score', () => {
    const adapted = adaptQualityGateResult('c', raw);
    expect(adapted.inconclusive).toBe(false);
    expect(adapted.overall_score).toBe(72.5);
  });

  // Defense-in-depth: a negative sentinel that arrives WITHOUT the flag is still
  // never a real score — null it, but keep the (real) failed verdict.
  test('a negative score is nulled even without the inconclusive flag', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: false,
      grade: 'F',
      overall_score: -1,
    });
    expect(adapted.overall_score).toBeNull();
    expect(adapted.status).toBe('failed');
    expect(adapted.inconclusive).toBe(false);
  });

  test('a genuine 0 IS surfaced (0 ≠ no-datum)', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: false,
      grade: 'F',
      overall_score: 0,
    });
    expect(adapted.overall_score).toBe(0);
  });

  // Strict coercion: a stray non-boolean flag must not mute a real failure.
  test('a non-boolean inconclusive value does not mute a real failure', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: false,
      grade: 'F',
      overall_score: 40,
      inconclusive: 'false', // hostile non-boolean (arg is `unknown`)
    });
    expect(adapted.status).toBe('failed');
    expect(adapted.inconclusive).toBe(false);
  });

  // Per-tool provenance (PR-U1): a partial gate carries partial:true + the tool
  // split so the frontend can say "graded on N of M tools".
  test('partial gate surfaces partial:true and the tool provenance', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: true,
      overall_score: 88,
      grade: 'B',
      partial: true,
      tools_attempted: ['ruff', 'bandit', 'mypy'],
      tools_succeeded: ['ruff', 'bandit'],
      tools_failed: ['mypy'],
    });
    expect(adapted.partial).toBe(true);
    expect(adapted.tools_attempted).toEqual(['ruff', 'bandit', 'mypy']);
    expect(adapted.tools_succeeded).toEqual(['ruff', 'bandit']);
    expect(adapted.tools_failed).toEqual(['mypy']);
    // A partial run still has a real score/verdict — it is NOT inconclusive.
    expect(adapted.status).toBe('passed');
    expect(adapted.inconclusive).toBe(false);
  });

  // partial and inconclusive are mutually exclusive — a partial flag over an
  // abstained scan is nonsense; force it off.
  test('inconclusive forces partial off even if the flag is set', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: false,
      overall_score: -1.0,
      grade: 'N/A',
      inconclusive: true,
      partial: true,
    });
    expect(adapted.status).toBe('inconclusive');
    expect(adapted.partial).toBe(false);
  });

  test('a non-boolean partial value is not honored', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: true,
      overall_score: 90,
      grade: 'A',
      partial: 'true', // hostile non-boolean
    });
    expect(adapted.partial).toBe(false);
  });

  test('a conclusive gate defaults partial:false with empty tool lists', () => {
    const adapted = adaptQualityGateResult('c', raw);
    expect(adapted.partial).toBe(false);
    expect(adapted.tools_attempted).toEqual([]);
    expect(adapted.tools_succeeded).toEqual([]);
    expect(adapted.tools_failed).toEqual([]);
  });

  // coding-analysis #107: nothing stored + an abstaining gate. Upstream sends
  // overall_score 0.0 and one synthetic check with actual 0.0 — neither is a
  // measurement, so neither may reach the UI as a score.
  test('not_analyzed gate → status "not_analyzed", no score, no grade, no synthetic metric', () => {
    const adapted = adaptQualityGateResult('c', {
      passed: false,
      overall_score: 0.0,
      grade: 'N/A',
      inconclusive: true,
      gate_checks: [
        { name: 'analysis_available', description: 'x', passed: false, actual: 0.0, threshold: 1.0 },
      ],
      recommendations: ['No stored quality result.'],
      status: 'not_analyzed',
      result_id: null,
      commit_sha: null,
      source: null,
    });
    expect(adapted.status).toBe('not_analyzed');
    expect(adapted.overall_score).toBeNull();
    expect(adapted.grade).toBe('');
    expect(adapted.metrics).toEqual([]);
    expect(adapted.inconclusive).toBe(true);
    expect(adapted.result_status).toBe('not_analyzed');
    expect(adapted.commit_sha).toBeNull();
  });

  test('a stored complete gate passes through commit_sha / result_id / source', () => {
    const adapted = adaptQualityGateResult('c', {
      ...raw,
      status: 'complete',
      result_id: 'r-1',
      commit_sha: 'abc1234',
      source: 'stored',
    });
    expect(adapted.status).toBe('warning');
    expect(adapted.overall_score).toBe(72.5);
    expect(adapted.result_status).toBe('complete');
    expect(adapted.result_id).toBe('r-1');
    expect(adapted.commit_sha).toBe('abc1234');
    expect(adapted.source).toBe('stored');
    expect((adapted.metrics as unknown[]).length).toBe(2);
  });
});

describe('buildDegradedDependencyReport', () => {
  const report = {
    container_name: 'demo',
    dependencies: [{ name: 'requests', version: '2.31.0' }],
    total_count: 1,
    vulnerable_count: 0,
    critical_count: 0,
    timestamp: '2026-07-01T12:00:00Z',
  };

  test('preserves the stored report shape and adds degraded markers', () => {
    const out = buildDegradedDependencyReport(report, '2026-07-01T12:00:00Z');
    // Original fields survive unchanged (frontend renders the same shape).
    expect(out.container_name).toBe('demo');
    expect(out.dependencies).toEqual(report.dependencies);
    expect(out.total_count).toBe(1);
    // Degraded markers surfaced for the "stale as of" badge.
    expect(out.degraded).toBe(true);
    expect(out.stale_as_of).toBe('2026-07-01T12:00:00Z');
  });

  test('tolerates a missing computed_at', () => {
    const out = buildDegradedDependencyReport(report, undefined);
    expect(out.degraded).toBe(true);
    expect(out.stale_as_of).toBeUndefined();
  });

  test('does not mutate the input report', () => {
    const copy = { ...report };
    buildDegradedDependencyReport(report, '2026-07-01T12:00:00Z');
    expect(report).toEqual(copy);
    expect('degraded' in report).toBe(false);
  });
});
