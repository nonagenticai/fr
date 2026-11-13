// tests/unit/workers/approval-expiry-horizon.test.ts
//
// Pins the expiry-horizon gauge emitted by the approval-expiry tick.
//
// These assertions are load-bearing for ALERTING, not for rendering. The gitops
// rule that will watch `fr_approvals_pending_expiring` matches on this exact
// metric name and this exact `horizon` label value set, so a rename here that
// goes unnoticed silently disarms the only warning that 925 approvals are about
// to become permanently undecidable. If a name below changes, the gitops rule
// changes in the same breath.
//
// Two properties get the most attention because they are the two ways this
// metric could LIE:
//
//   * emitting nothing at 0. A gauge that disappears when the count is zero is
//     indistinguishable from a gauge nobody is producing, so the alert can
//     never be falsified in the direction that matters.
//   * getting the boundary wrong. The horizons are cumulative and inclusive; an
//     off-by-one at the edge misfiles exactly the most urgent row.

import { describe, expect, test } from 'bun:test';
import {
  APPROVAL_KIND_LABELS,
  CALLBACK_OUTCOME_LABELS,
  DECISION_LABELS,
  HORIZON_BUCKETS,
  bucketApprovalsByHorizon,
  callbackOutcomesFromTick,
  clampDecisionTotalsMonotonic,
  emptyApprovalCallbackOutcomeCounts,
  emptyApprovalDecisionCounts,
  emptyApprovalHorizonCounts,
  renderApprovalHorizonMetrics,
  type ApprovalBacklogSnapshot,
  type ApprovalDecisionCounts,
  type ApprovalHorizonCounts,
} from '../../../src/workers/approval-expiry';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;

describe('HORIZON_BUCKETS', () => {
  // The window widths are the metric's meaning. 7d is not decoration: the TTL
  // measured on prod is bimodal (591 rows at 8d, 564 at 14d), so a 72h-only
  // alert reads 0 right up until ~2.5 days before an 839-row bolus lapses.
  test('pins the three cumulative windows and their exact widths', () => {
    expect(HORIZON_BUCKETS.map((b) => b.label)).toEqual(['24h', '72h', '7d']);
    expect(HORIZON_BUCKETS.map((b) => b.seconds)).toEqual([86_400, 259_200, 604_800]);
  });

  test('widths are strictly increasing, which is what makes them nestable', () => {
    for (let i = 1; i < HORIZON_BUCKETS.length; i += 1) {
      expect(HORIZON_BUCKETS[i]!.seconds).toBeGreaterThan(HORIZON_BUCKETS[i - 1]!.seconds);
    }
  });
});

describe('bucketApprovalsByHorizon', () => {
  test('is inclusive at the boundary: exactly now+24h lands INSIDE 24h', () => {
    const exactly24h = new Date(NOW.getTime() + 86_400 * 1000);
    expect(bucketApprovalsByHorizon([exactly24h], NOW)).toEqual({
      '24h': 1,
      '72h': 1,
      '7d': 1,
    });
  });

  test('one second past the boundary falls OUT of 24h but stays in the wider ones', () => {
    const justOver24h = new Date(NOW.getTime() + (86_400 + 1) * 1000);
    expect(bucketApprovalsByHorizon([justOver24h], NOW)).toEqual({
      '24h': 0,
      '72h': 1,
      '7d': 1,
    });
  });

  test('the same boundary rule holds at the widest horizon', () => {
    const exactly7d = new Date(NOW.getTime() + 604_800 * 1000);
    const justOver7d = new Date(NOW.getTime() + (604_800 + 1) * 1000);
    expect(bucketApprovalsByHorizon([exactly7d], NOW)['7d']).toBe(1);
    expect(bucketApprovalsByHorizon([justOver7d], NOW)['7d']).toBe(0);
  });

  test('windows are CUMULATIVE, not disjoint — an inner row is counted in every outer one', () => {
    const inTwoHours = new Date(NOW.getTime() + 2 * 3_600 * 1000);
    expect(bucketApprovalsByHorizon([inTwoHours], NOW)).toEqual({
      '24h': 1,
      '72h': 1,
      '7d': 1,
    });
  });

  test('an already-lapsed row counts everywhere rather than vanishing', () => {
    // The reaper normally clears these in the same tick. When it has not, the
    // 24h bucket rising is a true "the reaper is behind" signal, so a lapsed
    // row must not be silently dropped by the metric.
    const lapsed = new Date(NOW.getTime() - 3_600 * 1000);
    expect(bucketApprovalsByHorizon([lapsed], NOW)).toEqual({
      '24h': 1,
      '72h': 1,
      '7d': 1,
    });
  });

  test('reproduces the shape measured on prod: 0 inside 24h/72h, a bolus inside 7d', () => {
    const day = 86_400 * 1000;
    const rows = [
      ...Array.from({ length: 86 }, () => new Date(NOW.getTime() + 5.4 * day)),
      ...Array.from({ length: 839 }, () => new Date(NOW.getTime() + 5.9 * day)),
    ];
    expect(bucketApprovalsByHorizon(rows, NOW)).toEqual({
      '24h': 0,
      '72h': 0,
      '7d': 925,
    });
  });

  test('no rows at all yields every horizon at 0, never an empty object', () => {
    expect(bucketApprovalsByHorizon([], NOW)).toEqual({ '24h': 0, '72h': 0, '7d': 0 });
    expect(emptyApprovalHorizonCounts()).toEqual({ '24h': 0, '72h': 0, '7d': 0 });
  });
});

describe('renderApprovalHorizonMetrics', () => {
  test('emits EVERY horizon at 0 — the property that makes the alert falsifiable', () => {
    const body = renderApprovalHorizonMetrics(emptyApprovalHorizonCounts(), NOW_SECONDS);
    expect(body).toContain('fr_approvals_pending_expiring{horizon="24h"} 0');
    expect(body).toContain('fr_approvals_pending_expiring{horizon="72h"} 0');
    expect(body).toContain('fr_approvals_pending_expiring{horizon="7d"} 0');
  });

  test('emits the heartbeat at 0 too, so absent() means "fr went quiet" not "nothing is expiring"', () => {
    const body = renderApprovalHorizonMetrics(emptyApprovalHorizonCounts(), NOW_SECONDS);
    // Truncated, never fractional — a whole second keeps `time() - <metric>`
    // readable in the alert description.
    expect(body).toContain(
      `fr_approval_horizon_push_timestamp_seconds ${Math.floor(NOW_SECONDS)}`,
    );
  });

  test('emits the exact series the gitops alert rule will match on', () => {
    const counts: ApprovalHorizonCounts = { '24h': 0, '72h': 0, '7d': 925 };
    const body = renderApprovalHorizonMetrics(counts, 1788000000.7);
    expect(body).toContain('fr_approvals_pending_expiring{horizon="7d"} 925');
    expect(body).toContain('fr_approval_horizon_push_timestamp_seconds 1788000000');
  });

  test('every metric family carries a HELP and a TYPE line', () => {
    const body = renderApprovalHorizonMetrics(emptyApprovalHorizonCounts(), NOW_SECONDS);
    for (const name of [
      'fr_approvals_pending_expiring',
      'fr_approvals_pending_total',
      'fr_approvals_pending_oldest_age_seconds',
      'fr_approval_horizon_push_timestamp_seconds',
    ]) {
      expect(body).toContain(`# HELP ${name} `);
      expect(body).toContain(`# TYPE ${name} gauge`);
    }
    expect(body).toContain('# HELP fr_approval_decisions_total ');
    expect(body).toContain('# TYPE fr_approval_decisions_total counter');
  });

  test('body ends with a newline — pushgateway rejects a truncated final line', () => {
    expect(renderApprovalHorizonMetrics(emptyApprovalHorizonCounts(), NOW_SECONDS)).toEndWith('\n');
  });

  test('emits fr_approvals_pending_total for EVERY kind at 0, plus oldest_age and decisions at 0 — same falsifiability rule as the horizon buckets', () => {
    const body = renderApprovalHorizonMetrics(emptyApprovalHorizonCounts(), NOW_SECONDS);
    for (const kind of APPROVAL_KIND_LABELS) {
      expect(body).toContain(`fr_approvals_pending_total{kind="${kind}"} 0`);
    }
    expect(body).toContain('fr_approvals_pending_oldest_age_seconds 0');
    for (const decision of DECISION_LABELS) {
      expect(body).toContain(`fr_approval_decisions_total{decision="${decision}"} 0`);
    }
  });

  test('reproduces the shape measured on prod 2026-09-11/12: 1,267 pending (12.7% of it inside any expiry horizon), oldest ~1,288,490s, 2,001 decisions ever', () => {
    const backlog: ApprovalBacklogSnapshot = {
      byKind: {
        generic: 1059,
        'improvement.design': 26,
        'improvement.release': 0,
        'execution.ready_signoff': 182,
        'improvement.canary_action': 0,
      },
      total: 1267,
      oldestAgeSeconds: 1_288_490,
    };
    const decisionTotals: ApprovalDecisionCounts = { approved: 1981, rejected: 20 };
    const body = renderApprovalHorizonMetrics(
      emptyApprovalHorizonCounts(),
      NOW_SECONDS,
      undefined,
      undefined,
      backlog,
      decisionTotals,
    );
    expect(body).toContain('fr_approvals_pending_total{kind="generic"} 1059');
    expect(body).toContain('fr_approvals_pending_total{kind="improvement.design"} 26');
    expect(body).toContain('fr_approvals_pending_total{kind="improvement.release"} 0');
    expect(body).toContain('fr_approvals_pending_total{kind="execution.ready_signoff"} 182');
    expect(body).toContain('fr_approvals_pending_total{kind="improvement.canary_action"} 0');
    expect(body).toContain('fr_approvals_pending_oldest_age_seconds 1288490');
    expect(body).toContain('fr_approval_decisions_total{decision="approved"} 1981');
    expect(body).toContain('fr_approval_decisions_total{decision="rejected"} 20');
  });
});

describe('clampDecisionTotalsMonotonic', () => {
  test('passes a non-decreasing raw read straight through and raises the floor', () => {
    const floor = emptyApprovalDecisionCounts();
    const raw: ApprovalDecisionCounts = { approved: 1981, rejected: 20 };
    expect(clampDecisionTotalsMonotonic(raw, floor)).toEqual(raw);
  });

  test('equal to the floor is not a regression — passes through unchanged', () => {
    const floor: ApprovalDecisionCounts = { approved: 1981, rejected: 20 };
    expect(clampDecisionTotalsMonotonic({ ...floor }, floor)).toEqual(floor);
  });

  test('a per-label regression is clamped to that label\'s floor, independently of the other label', () => {
    const floor: ApprovalDecisionCounts = { approved: 1981, rejected: 20 };
    const raw: ApprovalDecisionCounts = { approved: 1900, rejected: 25 };
    // approved regressed (clamped to floor), rejected grew (passes through).
    expect(clampDecisionTotalsMonotonic(raw, floor)).toEqual({ approved: 1981, rejected: 25 });
  });

  test('logs the regression with both values and the label, and only for the regressed label', () => {
    // Captures fr's OWN console.error line (allowed); restored in finally.
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      clampDecisionTotalsMonotonic({ approved: 1900, rejected: 20 }, { approved: 1981, rejected: 20 });
    } finally {
      console.error = realError;
    }
    const line = lines.join('\n');
    expect(line).toContain('fr_approval_decisions_total{decision="approved"}');
    expect(line).toContain('went BACKWARDS');
    expect(line).toContain('1981 -> 1900');
    expect(line).not.toContain('"rejected"} went BACKWARDS');
  });
});

describe('CALLBACK_OUTCOME_LABELS', () => {
  test('pins the exact label set a gitops alert rule will match on', () => {
    expect([...CALLBACK_OUTCOME_LABELS]).toEqual([
      'sent',
      'failed',
      // 409/410 — the waiting execution is gone. A DISTINCT label, so the
      // alert's `outcome="failed"` filter keeps meaning "the receiver broke or
      // refused", never "there was nothing left to deliver".
      'already-terminal',
      'unsupported',
      'skipped',
      'deferred',
    ]);
  });

  test('zeroes are a full shape, never an empty object', () => {
    expect(emptyApprovalCallbackOutcomeCounts()).toEqual({
      sent: 0,
      failed: 0,
      'already-terminal': 0,
      unsupported: 0,
      skipped: 0,
      deferred: 0,
    });
  });
});

describe('callbackOutcomesFromTick', () => {
  // Distinct values per field on purpose: with all-1s a mapping that swapped
  // two labels would still pass. These six numbers make any transposition a
  // failure.
  test('maps each tick counter to its own label — no transposition', () => {
    expect(
      callbackOutcomesFromTick({
        callbacksSent: 1,
        callbacksFailed: 2,
        callbacksAlreadyTerminal: 3,
        callbacksUnsupported: 4,
        callbacksSkipped: 5,
        callbacksDeferred: 6,
      }),
    ).toEqual({
      sent: 1,
      failed: 2,
      'already-terminal': 3,
      unsupported: 4,
      skipped: 5,
      deferred: 6,
    });
  });
});

describe('fr_approval_expiry_callback_last_tick exposition', () => {
  test('emits EVERY outcome at 0 — silence at zero is the failure mode', () => {
    const body = renderApprovalHorizonMetrics(emptyApprovalHorizonCounts(), NOW_SECONDS);
    for (const label of CALLBACK_OUTCOME_LABELS) {
      expect(body).toContain(`fr_approval_expiry_callback_last_tick{outcome="${label}"} 0`);
    }
  });

  test('carries a HELP and a gauge TYPE, and the HELP disowns the 2xx claim', () => {
    const body = renderApprovalHorizonMetrics(emptyApprovalHorizonCounts(), NOW_SECONDS);
    expect(body).toContain('# HELP fr_approval_expiry_callback_last_tick ');
    // Gauge, not counter: a `_total` under a job-only grouping key would be a
    // lie. See the header block in the worker.
    expect(body).toContain('# TYPE fr_approval_expiry_callback_last_tick gauge');
    expect(body).not.toContain('# TYPE fr_approval_expiry_callback_last_tick counter');
    expect(body).toContain('does not prove the card was re-queued');
    // ⚠️ The HELP must describe the UPDATE RULE the code implements. The guard
    // in `runOnce` is `r.acquiredLock`, NOT `r.expired > 0`, so a lock-winning
    // tick that reaped nothing also republishes all-zero. An earlier draft said
    // "the last expiry tick that reaped", which would have had an operator read
    // an honest zero as a stalled reaper. Pinned so the prose cannot drift back.
    expect(body).toContain('ACQUIRED THE LOCK');
    expect(body).not.toContain('last expiry tick that reaped');
  });

  test('the emitted text PARSES as exposition format 0.0.4', () => {
    const body = renderApprovalHorizonMetrics(
      { '24h': 1, '72h': 2, '7d': 925 },
      NOW_SECONDS,
      { sent: 3, failed: 1, 'already-terminal': 5, unsupported: 2, skipped: 4, deferred: 0 },
    );
    // Every non-comment line must be `name{labels} value` with a finite value,
    // and every sample's family must have been declared by a preceding TYPE.
    const declared = new Set<string>();
    const seen = new Map<string, number>();
    for (const line of body.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('# TYPE ')) {
        declared.add(line.split(' ')[2]!);
        continue;
      }
      if (line.startsWith('#')) continue;
      const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (-?[0-9.eE+]+)$/.exec(line);
      expect(m).not.toBeNull();
      const [, name, labels, value] = m!;
      expect(declared.has(name!)).toBe(true);
      expect(Number.isFinite(Number(value))).toBe(true);
      if (labels) {
        // Labels must be well-formed `k="v"` pairs — an unescaped quote here is
        // what makes pushgateway reject the whole body with a 400.
        for (const pair of labels.slice(1, -1).split(',')) {
          expect(/^[a-zA-Z_][a-zA-Z0-9_]*="[^"\\]*"$/.test(pair)).toBe(true);
        }
      }
      const key = `${name}${labels ?? ''}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // No duplicate series — pushgateway 400s on a repeated label set.
    for (const [, n] of seen) expect(n).toBe(1);
    // ⚠️ Scoped to the family under test, NOT to the body's total series count.
    // `seen.size === 3 + 5 + 1` was true here only because three families
    // happened to exist on the day this was written — nine is not a property of
    // exposition-format validity. Adding an unrelated fourth family would have
    // failed a test named "PARSES as exposition format 0.0.4" and sent its
    // author hunting a parse bug that does not exist. Assert the property the
    // name claims instead: every outcome label present exactly once, and no
    // extra series smuggled into the family.
    for (const label of CALLBACK_OUTCOME_LABELS) {
      expect(seen.get(`fr_approval_expiry_callback_last_tick{outcome="${label}"}`)).toBe(1);
    }
    const outcomeSeries = [...seen.keys()].filter((k) =>
      k.startsWith('fr_approval_expiry_callback_last_tick{'),
    );
    expect(outcomeSeries).toHaveLength(CALLBACK_OUTCOME_LABELS.length);
  });

});
