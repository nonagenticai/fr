// src/lib/roster-discharge-metrics.ts
//
// ⛔ WHAT THIS COUNTS, AND WHY IT IS OBSERVABILITY AND NOT A FIX (issue #1059).
//
// `handleUpdateApproval` picks WHICH roster row a decision discharges and writes
// it to `approval_decisions.required_approver_id` (migration 108, #923). Quorum
// is then `allRequiredApprovers.every((ra) => satisfied.has(ra.id))` — it asks
// which ROW was discharged and never asks WHO discharged it. Because
// `approverIdentityFilter` admits a caller by `required_approvers.user_id` OR by
// a matching `required_approvers.role`, a caller who matches only by role
// discharges an obligation the roster names for a DIFFERENT user, and the
// approval completes.
//
// ── THE MEASUREMENT THAT MOTIVATES THIS FILE ────────────────────────────────
// Prod, 2026-09-08T19:00Z, SELECT-only (issue #1059 and its comments):
//
//   decisions joined to a roster row via required_approver_id : 519
//   decider == the roster row's user_id  (the CORRECT case)   :   0   <- control
//   decider != the roster row's user_id  (THE DIVERGENCE)     : 519
//
// 519 of 519, inside an 8-minute window, by one identity, on rows named for
// three others. All 519 approvals are now `approved`. Nothing in fr emitted a
// single byte about it: the divergence is invisible until somebody hand-writes
// a join between `approval_decisions` and `required_approvers`.
//
// ── ⛔ WHY THIS DOES NOT TIGHTEN THE RULE ────────────────────────────────────
// The obvious repair — require the decision's `approver_id` to equal the row's
// `user_id` — is REFUSED here, and refused on measurement rather than on taste:
//
//   roster rows naming a user who has NEVER decided : 2,785 of 2,859 (97.4%)
//   the same, on PENDING approvals                  : 1,021 of 1,041 (98.1%)
//
// …and every one of those 1,021 pending rows has `notified_at` set, with the
// dominant named user carrying 2,912 telegram deliveries and still receiving
// them. So the named approvers ARE being asked and do not act: requiring them
// would not redirect the conveyor, it would halt it. Whether a roster row's
// `user_id` is a REQUIREMENT or a LABEL is a product decision about what a
// roster row means, and it belongs to the operator. This file exists so that
// decision can be taken on a live number instead of a one-off SELECT.
//
// ── WHY A COUNTER *AND* A LOG LINE, WHICH ARE NOT ALTERNATIVES ──────────────
// They answer different questions and neither can answer the other's:
//
//   * THE COUNTER answers "is this happening, at what rate, and is it ALL of
//     the traffic or a minority?" It carries NO identity — see the cardinality
//     note below — so it can never name a row.
//   * THE LOG LINE (`[approvals] roster-discharge divergence …`, emitted by
//     routes/approvals.ts beside the counter, in the same idiom as the
//     `deblock_action` warning three lines further down that file) carries the
//     approval id, the decider id, the roster row id and the named user id, so
//     an operator who sees the rate move can name the rows. Ids in a log line
//     are already the norm on this route; ids as METRIC LABELS are not, and are
//     forbidden below.
//
// ⭐ `named_self` IS A LOAD-BEARING SERIES, NOT DECORATION — the same lesson
// `found` carries in `lib/keycloak-lookup-metrics.ts`. A divergence COUNT is
// not a divergence RATE, and the entire force of #1059 came from the control:
// "0 correct out of 519" is a different claim from "519 divergences", and only
// the first says the correct path is never taken. Without `named_self` in the
// same denominator a reader sees divergences rise and cannot tell a system
// where the role arm is the ONLY arm from one where it is a minority.
//
// ── ⚠️ CARDINALITY: WHAT IS DELIBERATELY *NOT* A LABEL ───────────────────────
//   * NOT the user id (decider or named). Thousands of values, and it would put
//     raw identity into a metric that is scraped, stored and rendered.
//   * NOT the approval id. Unbounded by construction — 1,378 pending rows alone.
//   * NOT `required_approvers.role`. This one looks bounded (four values live:
//     card_approver, execution_signoff, reviewer, action_approver) and IS NOT:
//     `role` is `text('role')` and three of the six writers pass a value
//     straight from a request body or webhook payload (`routes/webhooks.ts:183`
//     `approver.role`, `routes/approvals.ts:922` `approver.role`,
//     `routes/improvement-approvals.ts:287` `a.role ?? null`). A caller-supplied
//     string as a Prometheus label is an unbounded label by definition. The role
//     goes in the log line instead, where an unbounded value costs nothing.
//
// What is left is one bounded dimension with three values, which is exactly the
// question an operator has to answer.
//
// Lives in `lib/` for the same reason `deblock-action-metrics.ts` and
// `metering-span-metrics.ts` do: `routes/metrics.ts` imports the render helper,
// and nothing on a hot path may transitively pull in `db/client`.

import { hostname } from 'node:os';

/**
 * How one discharge related the decider to the roster row it discharged.
 *
 * `named_self`  — the row's `user_id` IS the decider. The obligation was met by
 *                 the party it names. THE DENOMINATOR (see the ⭐ note above).
 * `named_other` — the row's `user_id` is a DIFFERENT party. The decider reached
 *                 the row through the role arm of `approverIdentityFilter` and
 *                 discharged an obligation named for somebody else. This is the
 *                 519-of-519 population.
 * `unnamed`     — the row names NO user at all.
 *
 * ⚠️ `unnamed` IS STRUCTURALLY UNREACHABLE TODAY, AND IS EXPOSED ANYWAY. Checked
 * rather than assumed: `required_approvers.user_id` is `notNull()` in
 * `db/schema.ts` AND `not null` in the live DDL (`\d required_approvers` against
 * a schema built by this repo's own `drizzle-kit push` -> migrate bootstrap), so
 * no row can name nobody. It gets its own series for two reasons. First, the
 * same reason `no_list_target` is exposed at a permanent zero in
 * `deblock-action-metrics.ts`: a series that appears only once it is non-zero
 * cannot be alerted on from a dashboard nobody has built yet. Second, and the
 * load-bearing one: if that NOT NULL is ever dropped, a NULL `user_id` compares
 * unequal to every decider and would land silently in `named_other` — reporting
 * a STRUCTURAL ABSENCE as a BYPASS, on the one counter built to tell them apart.
 * A permanent zero that can only move for a real reason is worth its line.
 */
export const ROSTER_DISCHARGE_OUTCOMES = ['named_self', 'named_other', 'unnamed'] as const;
export type RosterDischargeOutcome = (typeof ROSTER_DISCHARGE_OUTCOMES)[number];

/**
 * Classify one discharge. PURE — no db, no clock, no counter — so the mapping
 * can be pinned without a Postgres.
 *
 * ⛔ THE COMPARISON MUST BE THE ROUTE'S COMPARISON, CHARACTER FOR CHARACTER.
 * `handleUpdateApproval` selects the row with `candidateRosterRows.find((r) =>
 * r.user_id === user.id)` — a strict, case-SENSITIVE `===`. This function uses
 * the same one on purpose. Normalising case or trimming here would be a
 * reasonable-looking improvement that breaks the metric's only contract: a
 * classifier that says `named_self` where the route's `find` said "no match"
 * would report a discharge that did not happen, and the counter would then
 * disagree with the row it is describing. If the route's predicate ever changes,
 * this one changes WITH it, in the same commit.
 */
export function classifyRosterDischarge(
  rowUserId: string | null | undefined,
  deciderId: string,
): RosterDischargeOutcome {
  if (rowUserId === null || rowUserId === undefined || rowUserId === '') return 'unnamed';
  return rowUserId === deciderId ? 'named_self' : 'named_other';
}

const counts = new Map<RosterDischargeOutcome, number>();

function zero(): void {
  counts.clear();
  // Pre-zeroed: all three series exist from process start, so `increase()` has a
  // baseline and `named_self` is a real denominator on the first divergence
  // rather than an absent vector.
  for (const outcome of ROSTER_DISCHARGE_OUTCOMES) counts.set(outcome, 0);
}
zero();

/**
 * Count one PERSISTED discharge.
 *
 * ⚠️ CALL IT AFTER THE `approval_decisions` INSERT, NEVER BEFORE. The route picks
 * `requiredApprover` early — before the burst guard (#901), before the
 * already-decided check and before the body is even parsed — so counting at the
 * pick would count refusals as discharges. Every one of those paths throws, and
 * a throw is not a discharge.
 */
export function recordRosterDischarge(outcome: RosterDischargeOutcome): void {
  counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
}

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderRosterDischargeMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_approval_roster_discharge_total Approval decisions by how the decider related to the required_approvers row the decision discharged. named_self means the row named the decider. named_other means the row named a DIFFERENT user and the decider reached it through the role arm of approverIdentityFilter — the divergence issue #1059 measured at 519 of 519. unnamed means the row named no user and is structurally unreachable while required_approvers.user_id is NOT NULL. This counter changes NO authorization outcome; it makes an existing one visible.',
    '# TYPE fr_approval_roster_discharge_total counter',
  ];
  for (const outcome of ROSTER_DISCHARGE_OUTCOMES) {
    lines.push(
      `fr_approval_roster_discharge_total{outcome="${outcome}"} ${counts.get(outcome) ?? 0}`,
    );
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// RETENTION: WHY THIS IS PUSHED AS WELL AS RENDERED
// ═══════════════════════════════════════════════════════════════════════════
//
// Rendering into `routes/metrics.ts :: handlePromMetrics` alone would ship a
// SILENT counter, and that is a measured fact in this repo rather than a worry.
// `lib/deblock-action-metrics.ts` records, verified against in-cluster
// prometheus on 2026-09-07, that fr's `/api/metrics/prom` exporter is NEVER
// SCRAPED — `fr_deblock_actions_total` had 0 series and `/api/v1/metadata` did
// not know the name — while the only retained `fr_*` families all arrive via the
// pushgateway carrying `exported_job`. A counter built to end a silence that is
// itself silent is the same defect one layer out, so this rides the same rail.
//
// The whole design argument (POST-only and why DELETE is the alarm-erasure
// vector of deployment#3490; `{job, instance}` grouping and why a counter
// must not copy the horizon emitter's job-only key; `exported_job` at the QUERY
// layer versus `job` at the PUSH layer; why `pushgateway_reap.py` is safe here;
// why a dedicated metrics port was considered and rejected) is written out once,
// at length, in `lib/deblock-action-metrics.ts`. It is NOT restated here —
// two copies of a rationale drift, and the next reader should meet the argument
// in one place. What follows is only what is specific to THIS family.
//
// ⛔ JOB NAME COLLISION — CHECKED LIVE, NOT ASSUMED. A push REPLACES the metric
// families inside its own group, so a job name already in use would clobber
// somebody else's data. The live pushgateway registry (`GET /api/v1/metrics` on
// `pushgateway.example.com:9091`, enumerated 2026-09-08) holds
// 14 job values: aa-conveyor-stats, alert-vacuity-audit, ambient_mesh_repair,
// ci-deploy, detector-scan-streams, exec_ready_signoff_callback,
// fr-approval-horizon, fr-deblock-actions, fr-scheduled-trigger-health,
// license-authz, node_mac, redis-backup-verify, redis-backup-verify-ok,
// verdaccio-uplink-reconcile. `fr-roster-discharge` is none of them.
//
// ⛔ AND IT IS NOT FOLDED INTO `fr-deblock-actions`. That group would have cost
// nothing to reuse and it is refused: its job name asserts what the group is
// about, and a reader who selects `exported_job="fr-deblock-actions"` to ask a
// deblock question must not silently receive an approvals-quorum family. Two
// unrelated concerns in one group also means either concern's emitter can no
// longer be removed without taking the other's retention with it.
//
// ⚠️ CONSUMER CONTRACT — `increase()` / `rate()`, NEVER a raw `sum()`, and select
// on `exported_job`, NEVER on `job` (`{job="fr-roster-discharge"}` matches ZERO
// series and RAISES NOTHING — PromQL has no unknown-label error, so a rule
// written that way is permanently green). Copy-pasteable, in the spelling that
// returns series — the ratio is the question #1059 actually asked:
//
//   sum by (outcome) (increase(fr_approval_roster_discharge_total{exported_job="fr-roster-discharge"}[1h]))
//   sum(increase(fr_approval_roster_discharge_total{exported_job="fr-roster-discharge",outcome="named_other"}[24h]))
//     / clamp_min(sum(increase(fr_approval_roster_discharge_total{exported_job="fr-roster-discharge"}[24h])), 1)
//   absent(fr_approval_roster_discharge_push_timestamp_seconds{exported_job="fr-roster-discharge"})
//
// ⛔ WHAT THIS DOES NOT ANSWER, stated rather than implied. It does not say
// whether a divergent discharge COMPLETED an approval, and it cannot: quorum is
// computed after the insert from every decision on the row, and reaching across
// to it would put this counter inside the code path #1059 forbids touching. It
// also does not say whether the decider HELD the role that matched — that claim
// lives in a Keycloak `realm_access` claim which fr never writes down, and which
// #1059 already records as the thing it could not verify.

/** Pushgateway grouping key, JOB half. Collides with none of the 14 live values. */
export const ROSTER_DISCHARGE_PUSHGATEWAY_JOB = 'fr-roster-discharge';

/**
 * Wall-clock bound on the pushgateway POST. NOT tuning — see the
 * `publishRosterDischargeMetrics` docblock: it is what makes the failure path
 * reachable at all when the socket never settles. Same value and same reasoning
 * as `DEBLOCK_PUSH_TIMEOUT_MS`, kept local for the same cycle reason.
 */
export const ROSTER_DISCHARGE_PUSH_TIMEOUT_MS = 10_000;

/** Heartbeat family — the `absent()`/staleness partner. Without it a dead emitter
 * and a genuinely-zero counter are byte-identical. */
export const ROSTER_DISCHARGE_PUSH_TIMESTAMP_METRIC =
  'fr_approval_roster_discharge_push_timestamp_seconds';

/**
 * Grouping key, INSTANCE half. Refuses rather than guesses, for the reason
 * `resolveDeblockPushInstance` documents: a shared constant fallback would merge
 * every pod into one group and let two processes silently overwrite each other.
 */
export function resolveRosterDischargePushInstance(
  env: Record<string, string | undefined>,
  fallbackHostname: string,
): string | null {
  const candidate = (env.POD_NAME ?? env.HOSTNAME ?? fallbackHostname ?? '').trim();
  if (candidate === '') return null;
  return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : null;
}

/** The pushgateway body: every series (INCLUDING the zeros) plus the heartbeat. */
export function renderRosterDischargePushBody(nowSeconds: number): string {
  const lines = [...renderRosterDischargeMetrics()];
  lines.push(
    `# HELP ${ROSTER_DISCHARGE_PUSH_TIMESTAMP_METRIC} Unix time this fr-backend process last published approval roster-discharge counters.`,
  );
  lines.push(`# TYPE ${ROSTER_DISCHARGE_PUSH_TIMESTAMP_METRIC} gauge`);
  lines.push(`${ROSTER_DISCHARGE_PUSH_TIMESTAMP_METRIC} ${Math.floor(nowSeconds)}`);
  return lines.join('\n') + '\n';
}

/**
 * Publish the roster-discharge counters to the pushgateway.
 *
 * NEVER throws — this hangs off a worker tick and a pushgateway outage must not
 * stop that tick. NEVER silent either: every failure path logs
 * `[roster-discharge-metrics]` with the reason, because "nothing said anything"
 * is the failure mode this counter exists to remove.
 *
 * NEVER HANGS, a third and independent property: the catch below is AFTER the
 * await, so an untimed `fetch` onto a silently-dropped connection is not a
 * caught failure but a promise that never settles, and it would take its
 * awaiting tick with it. `ROSTER_DISCHARGE_PUSH_TIMEOUT_MS` makes the catch
 * reachable.
 *
 * ⛔ POST only. See the #3490 note in `lib/deblock-action-metrics.ts`.
 */
export async function publishRosterDischargeMetrics(): Promise<void> {
  const env = process.env;
  const logger = console;
  const nowSeconds = Date.now() / 1000;

  const pushgatewayUrl = (env.PUSHGATEWAY_URL ?? '').trim();
  if (pushgatewayUrl === '') {
    // No hardcoded fallback, per config-externalization-policy.md — same as the
    // horizon and deblock emitters. The `absent()` half of the alert pair catches
    // this where the push was expected.
    return;
  }

  const instance = resolveRosterDischargePushInstance(env, hostname());
  if (instance === null) {
    logger.error(
      '[roster-discharge-metrics] no usable pushgateway instance identity ' +
        '(POD_NAME/HOSTNAME/os.hostname all empty or not [A-Za-z0-9._-]); ' +
        'NOT pushing, because a shared fallback group would let two processes ' +
        'overwrite each other',
    );
    return;
  }

  const url =
    `${pushgatewayUrl.replace(/\/+$/, '')}` +
    `/metrics/job/${encodeURIComponent(ROSTER_DISCHARGE_PUSHGATEWAY_JOB)}` +
    `/instance/${encodeURIComponent(instance)}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: renderRosterDischargePushBody(nowSeconds),
      // See the docblock: without this the catch below is unreachable on a
      // silent drop, and this call is awaited by a worker tick.
      signal: AbortSignal.timeout(ROSTER_DISCHARGE_PUSH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.error(
        `[roster-discharge-metrics] pushgateway returned ${resp.status}; roster-discharge ` +
          `counters NOT updated (job=${ROSTER_DISCHARGE_PUSHGATEWAY_JOB} instance=${instance})`,
      );
    }
  } catch (err) {
    logger.error(
      `[roster-discharge-metrics] push failed, roster-discharge counters NOT updated ` +
        `(job=${ROSTER_DISCHARGE_PUSHGATEWAY_JOB} instance=${instance}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
