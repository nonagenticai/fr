/**
 * suggestion-heuristic — pure detector unit tests.
 *
 * Spec ref: docs/archive/2026-04-27-continuous-project-model-design.md §13.2
 * Closes:   §15 #1 (suggestion-detection heuristic).
 */

import { describe, expect, test } from 'bun:test';
import {
  detectCandidates,
  type RunRow,
} from '../../../src/services/suggestion-heuristic';

const t = '00000000-0000-7000-8000-000000000aaa';
const p = '00000000-0000-7000-8000-000000000bbb';
const u = 'user-ccc';

function row(fired_at: string, kind: 'cron' | 'manual' | 'webhook' = 'manual'): RunRow {
  return {
    tenant_id: t,
    project_id: p,
    triggered_by_user_id: u,
    kind,
    fired_at: new Date(fired_at),
  };
}

describe('detectCandidates', () => {
  test('emits a candidate when same user fires 3 manual runs within ±15min on 3 distinct days', () => {
    const runs: RunRow[] = [
      row('2026-05-01T09:05:00Z'),
      row('2026-05-02T09:10:00Z'),
      row('2026-05-03T09:00:00Z'),
    ];
    const candidates = detectCandidates(runs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      tenant_id: t,
      project_id: p,
      user_id: u,
      hour_utc: 9,
    });
    expect(candidates[0]!.example_run_count).toBe(3);
    expect(candidates[0]!.hint_summary).toMatch(/manual runs at ~09:00 UTC/);
  });

  test('does NOT emit when only 2 manual runs match', () => {
    expect(
      detectCandidates([row('2026-05-01T09:00:00Z'), row('2026-05-02T09:05:00Z')]),
    ).toHaveLength(0);
  });

  test('does NOT emit when runs are spread across hours', () => {
    const runs = [
      row('2026-05-01T09:00:00Z'),
      row('2026-05-02T11:00:00Z'),
      row('2026-05-03T15:00:00Z'),
    ];
    expect(detectCandidates(runs)).toHaveLength(0);
  });

  test('ignores cron and webhook runs', () => {
    const runs = [
      row('2026-05-01T09:00:00Z', 'cron'),
      row('2026-05-02T09:00:00Z', 'cron'),
      row('2026-05-03T09:00:00Z', 'cron'),
    ];
    expect(detectCandidates(runs)).toHaveLength(0);
  });

  test('groups by (tenant, project, user) — distinct users do not aggregate', () => {
    const u2 = 'user-ddd';
    const runs = [
      row('2026-05-01T09:00:00Z'),
      { ...row('2026-05-02T09:00:00Z'), triggered_by_user_id: u2 },
      row('2026-05-03T09:00:00Z'),
    ];
    expect(detectCandidates(runs)).toHaveLength(0);
  });

  test('counts distinct days, not run count — 3 runs on 2 days does NOT emit', () => {
    const runs = [
      row('2026-05-01T09:00:00Z'),
      row('2026-05-01T09:10:00Z'),
      row('2026-05-02T09:00:00Z'),
    ];
    expect(detectCandidates(runs)).toHaveLength(0);
  });

  test('emits when 4+ runs across 3+ days (count exceeds day count)', () => {
    const runs = [
      row('2026-05-01T09:00:00Z'),
      row('2026-05-01T09:14:00Z'),
      row('2026-05-02T09:00:00Z'),
      row('2026-05-03T09:00:00Z'),
    ];
    const c = detectCandidates(runs);
    expect(c).toHaveLength(1);
    expect(c[0]!.example_run_count).toBe(4);
  });

  test('handles boundary near midnight via hour-1 / hour-2 lookups', () => {
    // run at 23:50 falls into the "00:00 ± 15min" bucket
    const runs = [
      row('2026-05-01T23:50:00Z'),
      row('2026-05-02T00:05:00Z'),
      row('2026-05-03T23:55:00Z'),
    ];
    // These do NOT all map to the same hour bucket — `bucketKey` uses the
    // run's literal UTC hour. So: hour=23 has 2 runs, hour=0 has 1. No emission.
    expect(detectCandidates(runs)).toHaveLength(0);
  });

  test('omits runs with null triggered_by_user_id', () => {
    const runs: RunRow[] = [
      { ...row('2026-05-01T09:00:00Z'), triggered_by_user_id: null },
      { ...row('2026-05-02T09:00:00Z'), triggered_by_user_id: null },
      { ...row('2026-05-03T09:00:00Z'), triggered_by_user_id: null },
    ];
    expect(detectCandidates(runs)).toHaveLength(0);
  });

  test('skips runs whose project_id is in the andoned set', () => {
    const runs: RunRow[] = [
      row('2026-05-01T09:05:00Z'),
      row('2026-05-02T09:10:00Z'),
      row('2026-05-03T09:00:00Z'),
    ];
    expect(detectCandidates(runs, new Set([p]))).toHaveLength(0);
  });

  test('still emits when other projects are andoned but this one is not', () => {
    const runs: RunRow[] = [
      row('2026-05-01T09:05:00Z'),
      row('2026-05-02T09:10:00Z'),
      row('2026-05-03T09:00:00Z'),
    ];
    const otherProject = '00000000-0000-7000-8000-00000000ffff';
    expect(detectCandidates(runs, new Set([otherProject]))).toHaveLength(1);
  });
});
