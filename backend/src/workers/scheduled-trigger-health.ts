// src/workers/scheduled-trigger-health.ts
//
// Health telemetry for the scheduled-intake cron loop.
//
// WHY THIS EXISTS
// ---------------
// The enabled `spec2-2b-smoke` trigger POSTed to an n8n webhook that no longer
// exists. Verified live 2026-08-02 against the n8n REST API (255 workflows,
// FULL pagination — the first page caps at 250, and reading that page alone
// would have produced a false "not found" — plus a positive control on a
// known-good path): workflow `lJ2S10eYhvu7cvuu` is gone, and NO workflow
// anywhere serves the path `intake-test-2b`. An in-cluster POST returns 404
// for the stored URL AND for its de-doubled form, while `/webhook/signal-
// incoming` returns 200 — so the doubled `/webhook/` segment in the stored URL
// is a red herring, not the cause. The destination is simply dead.
//
// It last DELIVERED anything on 2026-05-13 (the last run with
// records_processed > 0) and was invisible for the 81 days since, in two
// distinct phases:
//
//   * until 2026-07-20, the pre-#722 idempotency bug (claim-before-dispatch,
//     7-day TTL, no release on failure) burned the record's key on the first
//     404, so later ticks deduped against work that never happened and
//     honestly reported `ok, records_processed=0` — 51,820 such rows;
//   * after #722 released those keys, every tick re-fetched the same records
//     and recorded `partial_failure` — 8,956 consecutive times.
//
// Neither phase produced a single signal outside the `scheduled_trigger_runs`
// table. `tickOnce()` folds a per-row dispatch failure into that row's
// `status`, NOT into `TickResult.errors`, so the only log line the scheduler
// ever emitted was `claimed triggers=1 reports=0 errors=0` — indistinguishable
// from a healthy tick. There was no metric either: fr's `/api/metrics/prom`
// exporter carries only kanban lag + n8n execution counts, and (verified live
// 2026-07-30 against prometheus in-cluster) fr is not a scrape target at all —
// zero `fr_*` series exist. The `fr` namespace is ambient-meshed, so making
// the API port scrapable would require `portLevelMtls: PERMISSIVE` on the port
// that serves the whole authenticated API. That is a worse trade than pushing.
//
// So this module PUSHES to the pushgateway fr-backend is already wired to
// (`PUSHGATEWAY_URL` is set on the deployment and the gateway is a healthy
// prometheus target), pushing `cron_last_success_seconds` the same way every
// other fr cron-freshness producer does.
//
// The paired alert rules live in
// clusters/prod/services/prometheus/rules.yaml
// (`fr-scheduled-triggers.yaml` key). `fr_scheduled_trigger_health_push_
// timestamp_seconds` is the non-vacuity partner: an alert on a metric that is
// never produced is 0 series, and 0 series looks healthy. `absent()` on the
// heartbeat is what makes "fr stopped reporting" fire instead of going quiet.

import { queryClient } from '../db/client';

/**
 * Consecutive-failure counting is capped so the scan stays bounded no matter
 * how long a trigger has been broken. The cap is far above any threshold an
 * alert would use — the alert asks "≥ 5?", not "how many?" — and the query
 * plan degenerates to a `LIMIT`-bounded index scan instead of counting 7,000+
 * rows every 60s. Measured on prod 2026-07-30: 11.9 ms for the whole snapshot
 * with a 7,593-run failure streak in the table.
 */
export const CONSECUTIVE_FAILURE_SCAN_CAP = 1000;

/**
 * Consecutive failures at or above which a trigger is considered broken
 * rather than transiently unlucky. Shared by the throttled log line here and
 * documented as the threshold used by the `FrScheduledTriggerFailing` alert —
 * keep the two in step.
 */
export const FAILURE_ALERT_THRESHOLD = 5;

/** Pushgateway grouping key. One group per job; each push REPLACES it. */
export const PUSHGATEWAY_JOB = 'fr-scheduled-trigger-health';

/**
 * Wall-clock bound on the pushgateway POST. NOT tuning — it is what makes the
 * catch in `publishScheduledTriggerHealth` reachable when the socket never
 * settles rather than refuses. See that docblock. 10 s is far above a healthy
 * in-cluster POST and far below `TICK_INTERVAL_MS`.
 */
export const HEALTH_PUSH_TIMEOUT_MS = 10_000;

export interface ScheduledTriggerHealthRow {
  trigger_id: string;
  trigger_name: string;
  tenant_id: string;
  last_run_status: string;
  /**
   * Seconds since this trigger last recorded a run with status `ok`, falling
   * back to the row's `created_at` when it has NEVER succeeded — so a trigger
   * that was broken from birth reports a large age rather than a null that
   * would silently drop out of the alert expression.
   */
  last_ok_age_seconds: number;
  /** Non-`ok` runs since the last `ok` run, capped at CONSECUTIVE_FAILURE_SCAN_CAP. */
  consecutive_failures: number;
}

interface RawHealthRow {
  trigger_id: string;
  trigger_name: string;
  tenant_id: string;
  last_run_status: string;
  last_ok_age_seconds: number | string | null;
  consecutive_failures: number | string | null;
}

function toFiniteNumber(v: number | string | null, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Snapshot the health of every ENABLED scheduled_triggers row.
 *
 * Disabled rows are excluded deliberately: an operator who turns a trigger off
 * has said "stop running this", and keeping it in the alert set would make
 * disabling a broken trigger fail to clear its own alert.
 */
export async function collectScheduledTriggerHealth(): Promise<ScheduledTriggerHealthRow[]> {
  const rows = await queryClient<RawHealthRow[]>`
    SELECT t.id                                 AS trigger_id,
           t.name                               AS trigger_name,
           t.tenant_id                          AS tenant_id,
           COALESCE(t.last_run_status, 'never') AS last_run_status,
           EXTRACT(
             EPOCH FROM (now() - COALESCE(ok.last_ok_at, t.created_at))
           )::float8                            AS last_ok_age_seconds,
           COALESCE(f.consecutive_failures, 0)::int AS consecutive_failures
      FROM scheduled_triggers t
      -- Backward index scan on (trigger_kind, trigger_id, fired_at DESC) that
      -- stops at the first ok run, so its cost is the length of the CURRENT
      -- failure streak, not the size of the table.
      LEFT JOIN LATERAL (
            SELECT max(r.fired_at) AS last_ok_at
              FROM scheduled_trigger_runs r
             WHERE r.trigger_kind = 'scheduled_intake'
               AND r.trigger_id   = t.id
               AND r.status       = 'ok'
      ) ok ON true
      LEFT JOIN LATERAL (
            SELECT count(*) AS consecutive_failures
              FROM (
                SELECT 1
                  FROM scheduled_trigger_runs r
                 WHERE r.trigger_kind = 'scheduled_intake'
                   AND r.trigger_id   = t.id
                   AND r.status      <> 'ok'
                   AND r.fired_at > COALESCE(ok.last_ok_at, '-infinity'::timestamptz)
                 ORDER BY r.fired_at DESC
                 LIMIT ${CONSECUTIVE_FAILURE_SCAN_CAP}
              ) capped
      ) f ON true
     WHERE t.enabled = true
  `;

  return rows.map((r) => ({
    trigger_id: r.trigger_id,
    trigger_name: r.trigger_name,
    tenant_id: r.tenant_id,
    last_run_status: r.last_run_status,
    last_ok_age_seconds: toFiniteNumber(r.last_ok_age_seconds),
    consecutive_failures: toFiniteNumber(r.consecutive_failures),
  }));
}

/**
 * Escape a Prometheus label VALUE per the exposition format: backslash,
 * double-quote and newline. `trigger_name` is operator-supplied free text, so
 * an unescaped quote would produce a body pushgateway rejects wholesale —
 * taking every other trigger's series down with it.
 */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(r: ScheduledTriggerHealthRow): string {
  return (
    `{trigger_id="${escapeLabelValue(r.trigger_id)}",` +
    `trigger_name="${escapeLabelValue(r.trigger_name)}",` +
    `tenant_id="${escapeLabelValue(r.tenant_id)}"}`
  );
}

/**
 * Render the pushgateway body (exposition format 0.0.4).
 *
 * `fr_scheduled_trigger_health_push_timestamp_seconds` is emitted
 * UNCONDITIONALLY — including when there are zero enabled triggers — because
 * it is the series `absent()` watches. If it were only emitted alongside a
 * trigger, deleting the last trigger would silently disarm the alerting.
 */
export function renderScheduledTriggerHealthMetrics(
  rows: ScheduledTriggerHealthRow[],
  nowSeconds: number,
): string {
  const lines: string[] = [];

  lines.push(
    '# HELP fr_scheduled_trigger_consecutive_failures Non-ok scheduled_trigger_runs since this trigger last succeeded (capped).',
  );
  lines.push('# TYPE fr_scheduled_trigger_consecutive_failures gauge');
  for (const r of rows) {
    lines.push(`fr_scheduled_trigger_consecutive_failures${labels(r)} ${r.consecutive_failures}`);
  }

  lines.push(
    '# HELP fr_scheduled_trigger_last_ok_age_seconds Seconds since this trigger last recorded an ok run (since created_at if never).',
  );
  lines.push('# TYPE fr_scheduled_trigger_last_ok_age_seconds gauge');
  for (const r of rows) {
    lines.push(
      `fr_scheduled_trigger_last_ok_age_seconds${labels(r)} ${Math.round(r.last_ok_age_seconds)}`,
    );
  }

  lines.push('# HELP fr_scheduled_triggers_enabled Number of enabled scheduled_triggers rows.');
  lines.push('# TYPE fr_scheduled_triggers_enabled gauge');
  lines.push(`fr_scheduled_triggers_enabled ${rows.length}`);

  lines.push(
    '# HELP fr_scheduled_trigger_health_push_timestamp_seconds Unix time fr-backend last published scheduled-trigger health.',
  );
  lines.push('# TYPE fr_scheduled_trigger_health_push_timestamp_seconds gauge');
  lines.push(`fr_scheduled_trigger_health_push_timestamp_seconds ${Math.floor(nowSeconds)}`);

  return lines.join('\n') + '\n';
}

/** Throttle state for the log line — per trigger id, ticks since last emit. */
const _logThrottle = new Map<string, number>();
/** 30 health cycles ≈ 30 minutes at the 60s tick interval. */
const LOG_EVERY_N_CYCLES = 30;

/**
 * Emit a log line for each broken trigger, throttled.
 *
 * Untuned this would print every 60s forever for a permanently broken row —
 * the kind of noise that gets a whole prefix filtered out, which is how the
 * next failure becomes invisible again. Throttled, a broken trigger says so
 * immediately on the first observation and then twice an hour.
 */
export function logUnhealthyTriggers(
  rows: ScheduledTriggerHealthRow[],
): void {
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.trigger_id);
    if (r.consecutive_failures < FAILURE_ALERT_THRESHOLD) {
      _logThrottle.delete(r.trigger_id);
      continue;
    }
    const since = _logThrottle.get(r.trigger_id);
    if (since !== undefined && since < LOG_EVERY_N_CYCLES) {
      _logThrottle.set(r.trigger_id, since + 1);
      continue;
    }
    _logThrottle.set(r.trigger_id, 1);
    console.error(
      `[scheduled-trigger-tick] trigger ${r.trigger_id} ("${r.trigger_name}") ` +
        `tenant=${r.tenant_id} has failed ${r.consecutive_failures} consecutive runs ` +
        `(last_run_status=${r.last_run_status}, last ok ${Math.round(r.last_ok_age_seconds)}s ago)`,
    );
  }
  // Drop throttle state for triggers that are no longer enabled so a
  // re-enabled trigger reports immediately instead of inheriting a countdown.
  for (const id of [..._logThrottle.keys()]) {
    if (!seen.has(id)) _logThrottle.delete(id);
  }
}

/**
 * Collect, log and push scheduled-trigger health.
 *
 * NEVER throws: this is observability hanging off the scheduler loop, and a
 * pushgateway outage or a slow DB must not be able to stop scheduled intake
 * from running. Failures are logged, which is strictly more than the zero
 * signal that existed before.
 *
 * ⚠️ "Never throws" was doing more work in this docblock than it can bear, and
 * the caller acted on the stronger reading. Two corrections:
 *
 *  1. NOT HANGING is a separate property, and this used to lack it. The catch
 *     around the POST is AFTER the await, so an untimed `fetch` onto a socket
 *     that never settles is not a caught failure — it is a promise that never
 *     resolves. `HEALTH_PUSH_TIMEOUT_MS` now converts that into an `AbortError`
 *     the catch already handles. (`collect()` is a DB query and is likewise
 *     unbounded; the caller therefore does NOT rely on this returning, and
 *     wraps the call so a stalled snapshot cannot take the loop with it.)
 *  2. "Never throws" is a contract, not a proof. `logUnhealthyTriggers` and
 *     `renderScheduledTriggerHealthMetrics` sit outside the try blocks. The
 *     caller must still guard, and does.
 */
export async function publishScheduledTriggerHealth(): Promise<void> {
  const nowSeconds = Date.now() / 1000;

  let rows: ScheduledTriggerHealthRow[];
  try {
    rows = await collectScheduledTriggerHealth();
  } catch (err) {
    console.warn(
      `[scheduled-trigger-health] snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  logUnhealthyTriggers(rows);

  const pushgatewayUrl = process.env.PUSHGATEWAY_URL ?? '';
  if (!pushgatewayUrl) {
    // No hardcoded fallback, per config-externalization-policy.md. The
    // `absent()` half of the alert pair is what catches this in an
    // environment where the push was expected.
    return;
  }

  const body = renderScheduledTriggerHealthMetrics(rows, nowSeconds);
  try {
    const resp = await fetch(
      `${pushgatewayUrl.replace(/\/+$/, '')}/metrics/job/${PUSHGATEWAY_JOB}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        // See the docblock: without this the catch below is unreachable on a
        // silent drop and this call never returns to its caller.
        signal: AbortSignal.timeout(HEALTH_PUSH_TIMEOUT_MS),
      },
    );
    if (!resp.ok) {
      console.warn(
        `[scheduled-trigger-health] pushgateway returned ${resp.status}; health metrics NOT updated`,
      );
    }
  } catch (err) {
    console.warn(
      `[scheduled-trigger-health] push failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
