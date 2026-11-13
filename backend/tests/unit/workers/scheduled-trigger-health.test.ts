// tests/unit/workers/scheduled-trigger-health.test.ts
//
// Pins the exposition body and the unhealthy-trigger log lines for
// scheduled-trigger health.
//
// These assertions are load-bearing for ALERTING, not just for rendering: the
// prometheus rules in gitops match on these exact metric names and label
// names. An alert on a metric nobody produces is zero series, and zero series
// looks healthy — so a rename here that goes unnoticed silently disarms the
// only signal this pipeline has. If a name below has to change, the gitops
// rule `fr-scheduled-triggers.yaml` changes in the same breath.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  renderScheduledTriggerHealthMetrics,
  logUnhealthyTriggers,
  FAILURE_ALERT_THRESHOLD,
  type ScheduledTriggerHealthRow,
} from '../../../src/workers/scheduled-trigger-health';

const healthy: ScheduledTriggerHealthRow = {
  trigger_id: '11111111-1111-4111-8111-111111111111',
  trigger_name: 'nightly-digest',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  last_run_status: 'ok',
  last_ok_age_seconds: 42,
  consecutive_failures: 0,
};

// The real prod row, with the real numbers measured on worker4 2026-07-30.
const broken: ScheduledTriggerHealthRow = {
  trigger_id: '676a3386-1c25-424f-8490-c76701dff585',
  trigger_name: 'spec2-2b-smoke',
  tenant_id: '00000000-0000-0000-0000-000000000001',
  last_run_status: 'partial_failure',
  last_ok_age_seconds: 911784,
  consecutive_failures: 1000,
};


describe('renderScheduledTriggerHealthMetrics', () => {
  test('emits the exact series the gitops alert rules match on', () => {
    const body = renderScheduledTriggerHealthMetrics([broken], 1785200000.7);

    expect(body).toContain(
      'fr_scheduled_trigger_consecutive_failures{' +
        'trigger_id="676a3386-1c25-424f-8490-c76701dff585",' +
        'trigger_name="spec2-2b-smoke",' +
        'tenant_id="00000000-0000-0000-0000-000000000001"} 1000',
    );
    expect(body).toContain(
      'fr_scheduled_trigger_last_ok_age_seconds{' +
        'trigger_id="676a3386-1c25-424f-8490-c76701dff585",' +
        'trigger_name="spec2-2b-smoke",' +
        'tenant_id="00000000-0000-0000-0000-000000000001"} 911784',
    );
    expect(body).toContain('fr_scheduled_triggers_enabled 1');
    // Truncated, never fractional — prometheus accepts floats but a whole
    // second keeps `time() - <metric>` readable in the alert description.
    expect(body).toContain('fr_scheduled_trigger_health_push_timestamp_seconds 1785200000');
  });

  test('every metric family carries a HELP and a TYPE line', () => {
    const body = renderScheduledTriggerHealthMetrics([healthy, broken], 1785200000);
    for (const name of [
      'fr_scheduled_trigger_consecutive_failures',
      'fr_scheduled_trigger_last_ok_age_seconds',
      'fr_scheduled_triggers_enabled',
      'fr_scheduled_trigger_health_push_timestamp_seconds',
    ]) {
      expect(body).toContain(`# HELP ${name} `);
      expect(body).toContain(`# TYPE ${name} gauge`);
    }
    expect(body.endsWith('\n')).toBe(true);
  });

  test('the heartbeat is emitted even with ZERO enabled triggers', () => {
    // This is the non-vacuity guarantee. If the heartbeat were only emitted
    // alongside a trigger, disabling the last trigger would delete the series
    // `absent()` watches — and the alerting would go quiet exactly when the
    // pipeline stopped doing anything at all.
    const body = renderScheduledTriggerHealthMetrics([], 1785200000);
    expect(body).toContain('fr_scheduled_trigger_health_push_timestamp_seconds 1785200000');
    expect(body).toContain('fr_scheduled_triggers_enabled 0');
    expect(body).not.toContain('fr_scheduled_trigger_consecutive_failures{');
  });

  test('escapes label values so one odd trigger name cannot void the whole push', () => {
    const body = renderScheduledTriggerHealthMetrics(
      [{ ...healthy, trigger_name: 'we"ird\\name\nnewline' }],
      1785200000,
    );
    expect(body).toContain('trigger_name="we\\"ird\\\\name\\nnewline"');
    // A raw newline inside a label value would split the line and make
    // pushgateway reject the ENTIRE body with 400 — taking every other
    // trigger's series with it.
    const seriesLines = body.split('\n').filter((l) => l.startsWith('fr_scheduled_trigger_consecutive_failures{'));
    expect(seriesLines.length).toBe(1);
  });
});

describe('logUnhealthyTriggers', () => {
  // Captures fr's OWN console.error lines (allowed); restored after each case.
  const realError = console.error;
  let seen: string[] = [];
  beforeEach(() => {
    console.error = () => {};
    // A trigger absent from a tick is forgotten by the production prune, so an
    // empty tick starts every case from a clean throttle (no reset hook).
    logUnhealthyTriggers([]);
    seen = [];
    console.error = (...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
    };
  });
  afterEach(() => {
    console.error = realError;
  });

  test('says nothing for a healthy trigger', () => {
    logUnhealthyTriggers([healthy]);
    expect(seen).toEqual([]);
  });

  test('reports a broken trigger on the FIRST observation, not after a delay', () => {
    logUnhealthyTriggers([broken]);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('spec2-2b-smoke');
    expect(seen[0]).toContain('1000 consecutive runs');
  });

  test('throttles instead of printing every 60s forever', () => {
    for (let i = 0; i < 40; i++) logUnhealthyTriggers([broken]);
    expect(seen.length).toBe(2);
  });

  test('recovery clears the throttle so the next failure reports immediately', () => {
    logUnhealthyTriggers([broken]);
    logUnhealthyTriggers([{ ...broken, consecutive_failures: 0 }]);
    logUnhealthyTriggers([broken]);
    expect(seen.length).toBe(2);
  });

  test('the threshold is a real boundary, not off by one', () => {
    logUnhealthyTriggers([{ ...broken, consecutive_failures: FAILURE_ALERT_THRESHOLD - 1 }]);
    expect(seen.length).toBe(0);
    logUnhealthyTriggers([{ ...broken, consecutive_failures: FAILURE_ALERT_THRESHOLD }]);
    expect(seen.length).toBe(1);
  });
});
