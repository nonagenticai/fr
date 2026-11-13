// src/lib/andon-halt-metrics.ts
//
// ⛔ WHAT THIS COUNTS: work fr REFUSED TO START because of the global andon cord,
// at the chokepoint that refused it — and, in the same series family, the calls it
// LET THROUGH. One counter, one label axis, halts and denominator together.
//
// WHY IT EXISTS. The cord's own read is already counted by
// `lib/andon-gate-metrics.ts`, but that counts ANSWERS of the interlock endpoint
// (`GET /api/internal/andon`) — how often the switch was consulted and what it
// said. It cannot say how much WORK the answer stopped. The AA conveyor's brake
// now lives server-side, inside `POST /api/webhooks/n8n/router-dedupe`
// (routes/webhooks.ts): every Planka card move makes exactly one such call, so
// this counter is the number of card moves the cord halted. The n8n side
// therefore needs no metric node of its own — which is the point: a metric node
// in the workflow would be one more thing to trip the workflow scorecard ratchet,
// and it could not observe a refusal fr made before the workflow was consulted.
//
// ⛔ THE DENOMINATOR IS NOT OPTIONAL. `outcome="proceeded"` is in the same
// counter on purpose. A halt count alone cannot tell a released cord apart from a
// dead exporter or a conveyor with no traffic, and the interesting alert is a
// RATIO (halts / all brake decisions), not an absolute. Every key is pre-seeded
// to zero for the same reason: a series that only appears once it fires is
// indistinguishable from an exporter that was never wired up.
//
// ⭐ THE LABEL VALUE IS THE WIRE CODE, VERBATIM. `andon_engaged`,
// `andon_unreadable`, `andon_uninitialised` and `andon_check_failed` are exactly
// the `reason` strings the refusal returns to n8n (`{routed:false, reason:<code>}`),
// so an alert, a pod log line and the JSON body an n8n execution shows all use
// one vocabulary. Renaming one of these is renaming the API.
//
// Cardinality: surface x outcome, both CLOSED sets (1 x 6 = 6 series today). An
// unrecognised value collapses to `other` rather than minting a series.
//
// Lives in `lib/` for the same reason `conveyor-refusal-metrics.ts` does: its
// caller is unit-tested without a database, so this module must not transitively
// import `db/client`.

export const ANDON_HALT_SURFACES = [
  /** POST /api/webhooks/n8n/router-dedupe — the AA router's per-card-move claim. */
  'router_dedupe',
] as const;
export type AndonHaltSurface = (typeof ANDON_HALT_SURFACES)[number];

export const ANDON_HALT_OUTCOMES = [
  /**
   * The cord was EXPLICITLY released and the work went ahead. The denominator.
   * ⚠️ Not a halt — do not sum the whole metric and call the result halts.
   */
  'proceeded',
  /** A definite read of `engaged=true` — a super-admin pulled the cord. */
  'andon_engaged',
  /** The cord state is UNKNOWN: the read threw, or the two reads disagreed. */
  'andon_unreadable',
  /**
   * A DEFINITE read of an ABSENT `andon_state` singleton. Migration 065 inserts
   * it, so a nonzero count here is a broken install, not a pulled cord.
   *
   * ⚠️ This chokepoint HALTS on it, while `GET /api/internal/andon` answers
   * `engaged:false` for the same state. That asymmetry is deliberate and is
   * documented at the call site in routes/webhooks.ts — do not "reconcile" it
   * here by folding this value into `proceeded`.
   */
  'andon_uninitialised',
  /** The consult itself failed or answered in a shape this caller cannot read. */
  'andon_check_failed',
  'other',
] as const;
export type AndonHaltOutcome = (typeof ANDON_HALT_OUTCOMES)[number];

const key = (s: AndonHaltSurface, o: AndonHaltOutcome): string => `${s}|${o}`;

const decisions = new Map<string, number>();
for (const s of ANDON_HALT_SURFACES) {
  for (const o of ANDON_HALT_OUTCOMES) decisions.set(key(s, o), 0);
}

/**
 * ⛔ THE UNKNOWN-VALUE FALLBACK IS `other`, NOT `proceeded`, AND THE DIRECTION IS
 * THE POINT. Collapsing an unrecognised outcome into the permissive bucket would
 * bury a halt inside the denominator, where nothing distinguishes it from
 * ordinary traffic — the same mistake `andon-gate-metrics.ts` pins in the other
 * direction for its answer axis.
 */
function normaliseOutcome(outcome: string): AndonHaltOutcome {
  return (ANDON_HALT_OUTCOMES as readonly string[]).includes(outcome)
    ? (outcome as AndonHaltOutcome)
    : 'other';
}

/** Increment only. Exported for callers that emit their own log line. */
export function recordAndonBrakeDecision(
  surface: AndonHaltSurface,
  outcome: AndonHaltOutcome,
): void {
  const k = key(surface, normaliseOutcome(outcome));
  decisions.set(k, (decisions.get(k) ?? 0) + 1);
}

export interface AndonBrakeDecisionDetail {
  surface: AndonHaltSurface;
  outcome: AndonHaltOutcome;
  /** The card the brake acted on. Named in the log line, never in a label. */
  subject_id?: string | null;
  /** Free-form, log-only. Keep it short and factual. */
  detail?: Record<string, unknown>;
}

/**
 * Count the decision, and emit one structured line for the HALTS only.
 *
 * ⛔ Never throws. This runs on the path that decides whether a card move may be
 * dispatched; a throw here would turn a correct refusal into an undiagnosable
 * 500 — and, worse, an undiagnosable 500 that the n8n modules retry, which is
 * precisely the shape the fail-closed brake exists to avoid.
 *
 * `proceeded` is counted but NOT logged: it is every card move in the estate.
 */
export function reportAndonBrakeDecision(d: AndonBrakeDecisionDetail): void {
  try {
    const outcome = normaliseOutcome(d.outcome);
    recordAndonBrakeDecision(d.surface, outcome);
    if (outcome === 'proceeded') return;
    console.error(
      JSON.stringify({
        telemetry: 'andon_halted_work',
        surface: d.surface,
        outcome,
        subject_id: d.subject_id ?? null,
        ...(d.detail ?? {}),
      }),
    );
  } catch {
    // Deliberately silent: see above.
  }
}

// ───────────────────────────── ANDON STATE, AS A GAUGE ─────────────────────────
//
// ⭐ WHY A GAUGE EXISTS AT ALL, GIVEN EVERYTHING ABOVE IS A COUNTER. The counters
// say the brake ENGAGED; nothing in them can say the brake IS engaged. Two alerts
// the owner's condition actually needs are unexpressible without a state series:
//   * "the cord is still engaged N hours after somebody said they released it" —
//     a counter that stopped climbing looks identical to a released cord and to a
//     conveyor with no traffic.
//   * "fr cannot be reached at all" — the case the fail-closed trade was accepted
//     FOR. A counter cannot fire when the process that owns it is gone; only the
//     ABSENCE of a sample can, and absence needs a series that is normally there.
//
// ⛔ IT IS A CACHE, NOT A READ, AND THAT IS FORCED. `renderPromExporter` in
// routes/metrics.ts is SYNCHRONOUS and `SELECT`ing `andon_state` is not; making
// the renderer async would ripple through every caller and test of the exporter
// for a metric. So the code paths that ALREADY read the cord publish what they
// saw and the renderer reports the cache. No timer: a background ticker in fr is
// a separate design decision.
//
// ⛔ AND THE COVERAGE THAT BUYS IS BOUNDED — DO NOT READ IT AS CONTINUOUS. There
// are exactly three readers that publish, all REQUEST-DRIVEN and none periodic:
// the router-dedupe brake (once per Planka card move, plus a `null` observation
// when its consult fails), `GET /api/internal/andon` — which in production is
// reached only through that same brake — and `GET /api/andon`, the route
// `AndonCord.svelte` polls every 30 s per open operator tab. So freshness is
// bounded by CARD-MOVE TRAFFIC PLUS OPERATOR UI POLLING and by nothing else: a
// quiet board with no browser open, or a pod that has just restarted, leaves
// these series at "never observed" for as long as that lasts.
// `fr_andon_state_age_seconds` is therefore not a nicety — it is what makes the
// cache honest, and the field a rule MUST bound before it trusts
// `fr_andon_engaged`. See the renderer.

/**
 * What a publisher saw. `null` means "we tried and got no answer at all" (the
 * consult threw, or answered in a shape nobody can read).
 *
 * `reason` is the wire code, same vocabulary as {@link ANDON_HALT_OUTCOMES} and
 * as the interlock's own `reason` axis. It is kept for the test reader and for
 * humans; it is deliberately NOT a label (see the renderer).
 */
export interface AndonStateObservation {
  engaged: boolean;
  reason: string;
  /**
   * How many katas hold the conveyor n8n instance (`andon_state.kata_holders`), when this
   * publisher read the row. Omitted by a publisher that did not read it (the previous count is
   * kept); see {@link renderAndonHaltMetrics} `fr_andon_kata_holders`.
   */
  kataHolders?: number;
}

interface CachedAndonState {
  /** `null` = OBSERVED, but the observation cannot name the cord state. */
  engaged: boolean | null;
  reason: string;
  observedAtMs: number;
}

/** `null` = never observed, which is a THIRD thing and renders differently. */
let cachedAndonState: CachedAndonState | null = null;

/**
 * Kata holders of the conveyor n8n instance as last read. `null` = unknown (never read, or the
 * last observation of the cord could not name it) — rendered as NO SAMPLE, never 0.
 */
let cachedKataHolders: number | null = null;

const nowMs: () => number = () => Date.now();

/**
 * Publish what a reader just saw about the cord, for the state gauges.
 *
 * ⭐ THE KNOWN/UNKNOWN RULE LIVES HERE, ONCE, AND IT IS THE BRAKE'S RULE — NOT
 * THE RAW BOOLEAN. `GET /api/internal/andon` always returns a definite `engaged`
 * because `isGlobalAndonEngaged` fail-closes a read error to `true`; that boolean
 * is therefore a SAFETY DEFAULT, not an observation, whenever the reason axis
 * says the switch could not be named. Rendering `fr_andon_engaged 1` for it would
 * report "a super-admin pulled the cord" when the truth is "fr cannot read its
 * own cord", and rendering `0` for an `uninitialised` singleton would report
 * "released" while the brake is halting every card move in the estate. Both are
 * the exact lie this whole change exists to remove.
 *
 * So the state is KNOWN only for the two definite answers, with both axes
 * agreeing — the same conjunction `consultAndonForRouterDedupe` requires before
 * it will let work start. Callers hand over what they read and do not decide
 * this; a second copy of the rule is a second thing to drift.
 *
 * ⛔ Never throws, for the same reason {@link reportAndonBrakeDecision} does not:
 * it runs on the path that decides whether a card may be dispatched.
 */
export function publishAndonStateForMetrics(observation: AndonStateObservation | null): void {
  try {
    if (observation === null) {
      // We asked and got nothing back. `andon_check_failed` is the wire code the
      // brake returns for exactly this, reused verbatim.
      cachedAndonState = { engaged: null, reason: 'andon_check_failed', observedAtMs: nowMs() };
      cachedKataHolders = null;
      return;
    }
    const { engaged, reason, kataHolders } = observation;
    const known =
      (engaged === false && reason === 'released') || (engaged === true && reason === 'engaged');
    cachedAndonState = {
      engaged: known ? engaged : null,
      reason,
      observedAtMs: nowMs(),
    };
    // Same omission rule as `fr_andon_engaged`: an observation that cannot name the cord cannot
    // name its holders either. A known observation that did not read them keeps the last count.
    if (!known) cachedKataHolders = null;
    else if (kataHolders !== undefined) cachedKataHolders = Number.isInteger(kataHolders) && kataHolders >= 0 ? kataHolders : null;
  } catch {
    // Deliberately silent: see above.
  }
}

// ──────── SINGLETON PRESENCE, AS A STANDING GAUGE (fr#1208) ─────────────────
//
// ⭐ WHY A FOURTH SERIES. Every andon signal above is TRAFFIC-DRIVEN. The two
// counters move only when something consults the cord, and the state gauges are
// published by request handlers, so a `andon_state` singleton that has gone
// MISSING is INVISIBLE until the next card move — and a conveyor that is already
// halted generates no card moves. The observability hole fr#1208 names is exactly
// that: the condition suppresses the traffic that would reveal it.
//
// So this one is refreshed on the SCRAPE, not on a consult. Its publisher is
// `refreshAndonStateInitialisedGauge` in lib/global-andon-gate.ts (that module
// already owns the singleton read; this one must never import db/client — see the
// file header), called from the `/api/metrics/prom` branch in server.ts. Zero
// conveyor traffic is required for it to be correct.
//
// ⛔ AND IT IS A NEW SERIES RATHER THAN A NEW MEANING FOR AN OLD ONE, DELIBERATELY.
// `fr_andon_engaged` means "is the cord pulled" and nothing else: two live
// Prometheus rules consume it, one of which GATES a second alert on `== 1`, so
// widening it to carry "the switch is missing" would silently suppress the alert
// it exists to gate, with no diff in the rule. Same argument as
// `fr_andon_unrestored_workflows` above. Never overload; always add.

/** `null` = the presence of the singleton has not been determined. */
let cachedAndonRowPresent: boolean | null = null;

/**
 * Publish whether the `andon_state` singleton (id=1) exists.
 *
 * `null` means the probe could not determine it (the read threw). Under
 * {@link ANDON_GATE_POLICY} that is not a third operational state as far as this
 * series is concerned: a missing row and an unreadable row make every GATE halt
 * identically, so both render as `0`. See the renderer for why `0` is the honest
 * value here and not a fabricated one.
 *
 * ⛔ Never throws — same reason as {@link publishAndonStateForMetrics}.
 */
/**
 * Publish the kata holder count read straight from the singleton (the scrape-time refresher in
 * lib/global-andon-gate.ts, so the gauge is right with zero traffic and after a pod restart).
 * `null` = the row is absent or unreadable: NO SAMPLE. ⛔ Never throws.
 */
/**
 * FAILED katas still holding the cord (George 2026-11-04: a failed kata keeps the cord until a
 * super-admin releases it). Read at scrape time by lib/global-andon-gate.ts. `null` = unknown:
 * NO SAMPLE. ⛔ Never throws.
 */
let cachedKataFailedHolders: number | null = null;
export function publishKataFailedHoldersForMetrics(count: number | null): void {
  try {
    cachedKataFailedHolders = count !== null && Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    // Deliberately silent: see publishAndonStateForMetrics.
  }
}

export function publishAndonKataHoldersForMetrics(count: number | null): void {
  try {
    cachedKataHolders = count !== null && Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    // Deliberately silent: see publishAndonStateForMetrics.
  }
}

export function publishAndonRowPresenceForMetrics(present: boolean | null): void {
  try {
    cachedAndonRowPresent = present;
  } catch {
    // Deliberately silent: see above.
  }
}

// ──────────────── THE ESTATE GAUGE IS DELETED — DO NOT RE-ADD IT ─────────────
//
// `fr_andon_worker_replicas` lived here until 2026-11-02. It was a MODULE CACHE
// fed only by request-driven publishers — `GET /api/andon` (a live probe, so only
// while an operator tab is open), the engage/release transitions, and the card-move
// interlock (which published the STORED row value). Measured after the worker4
// migration restored the database: `andon_state.worker_replicas` was NULL, the
// card-move publisher therefore emitted no sample, and the only publisher left was
// a human with the admin page open. Both alerts that read the series
// (`FrAndonReleasedWorkerStillStopped`, `FrAndonEngagedWorkerStillRunning`)
// evaluated over an empty vector and COULD NOT FIRE — the exact condition they
// exist for.
//
// ⛔ The alternative was to fix the publisher. It was rejected on purpose: an
// actuator-divergence alert must not depend on the process that also holds the
// cord. The signal now comes from kube-state-metrics
// (`kube_deployment_spec_replicas{namespace="n8n",deployment="n8n-worker"}`), which
// reads the same `spec.replicas` field fr reads and is present with fr down and
// with nobody watching. Do not reintroduce a fr-side copy: a gauge that is usually
// absent is worse than no gauge, because the rule that reads it looks armed.

/** Prometheus text-exposition lines. Rendered by routes/metrics.ts. */
export function renderAndonHaltMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_andon_brake_total Work-initiation decisions made by the global andon brake, by chokepoint and outcome. `outcome="proceeded"` is the denominator; every other value is a refusal.',
    '# TYPE fr_andon_brake_total counter',
  ];
  for (const s of ANDON_HALT_SURFACES) {
    for (const o of ANDON_HALT_OUTCOMES) {
      lines.push(
        `fr_andon_brake_total{surface="${s}",outcome="${o}"} ${decisions.get(key(s, o)) ?? 0}`,
      );
    }
  }

  // ⛔ THE SAMPLE IS OMITTED WHEN THE STATE IS UNKNOWN, AND THAT OMISSION IS THE
  // FEATURE. DO NOT "FIX" IT BY EMITTING 0. There are THREE observations to
  // distinguish and a boolean gauge can carry only two: `0` means RELEASED to
  // every reader and every rule, so publishing `0` for "nobody can say" is the
  // fabricated-zero defect — the same one `fr_kanban_liveness_lag_seconds` in
  // routes/metrics.ts omits its sample to avoid, and the same class as the
  // absent-singleton-reads-as-released bug the interlock's `uninitialised` code
  // exists to name. With the sample absent, `absent(fr_andon_engaged)` is TRUE
  // and an alert can fire on it; with a fabricated `0` nothing can.
  //
  // The HELP/TYPE lines are emitted UNCONDITIONALLY so the metric is
  // discoverable — and so its absence in a scrape means "fr said it cannot tell",
  // never "this build has no such metric".
  lines.push(
    '# HELP fr_andon_engaged 1 when the global andon cord is definitely engaged, 0 when it is definitely released. NO SAMPLE when fr cannot tell — read fr_andon_state_readable for that case; a 0 here always means released.',
  );
  lines.push('# TYPE fr_andon_engaged gauge');
  if (cachedAndonState !== null && cachedAndonState.engaged !== null) {
    lines.push(`fr_andon_engaged ${cachedAndonState.engaged ? 1 : 0}`);
  }

  // George 2026-11-03: a kata holds the conveyor n8n instance by scaling the worker to 0 while
  // the operator's cord stays released, so `FrAndonReleasedWorkerStillStopped`
  // (kube_deployment_spec_replicas{n8n-worker} == 0 AND fr_andon_engaged == 0) would page for
  // every kata. This is the series the rule excludes on (`unless on() (max(fr_andon_kata_holders) > 0)`).
  // ⛔ NO SAMPLE when unknown, never 0 — a fabricated 0 would re-arm that alert for a hold fr
  // simply could not read.
  lines.push(
    '# HELP fr_andon_kata_holders Number of katas holding the conveyor n8n instance (andon_state.kata_holders); while > 0 the n8n-worker is deliberately at 0 even with the operator cord released. NO SAMPLE when fr cannot read the cord.',
  );
  lines.push('# TYPE fr_andon_kata_holders gauge');
  if (cachedKataHolders !== null) lines.push(`fr_andon_kata_holders ${cachedKataHolders}`);

  // George 2026-11-04: a failed kata keeps the cord until a super-admin releases it, so a failed
  // holder is a standing page: both the execution system and the kata system failed. The replica
  // count is NOT copied here (the andon safety alerts read kube-state-metrics on purpose).
  lines.push(
    '# HELP fr_kata_failed_holders Number of FAILED katas still holding the conveyor n8n cord; only a super-admin Release (POST /api/katas/:id/release) frees them. NO SAMPLE when fr cannot read it.',
  );
  lines.push('# TYPE fr_kata_failed_holders gauge');
  if (cachedKataFailedHolders !== null) lines.push(`fr_kata_failed_holders ${cachedKataFailedHolders}`);

  // The positive signal that tells UNKNOWN apart from RELEASED. An alert keyed
  // only on `absent(fr_andon_engaged)` cannot fire while fr is up and answering
  // "I cannot tell" — which is a real, actionable, fail-closed-brake-engaging
  // condition and the one the owner's alert condition names first.
  lines.push(
    '# HELP fr_andon_state_readable 1 when fr could name the cord state at its last read, 0 when it could not and 0 when it has never read it.',
  );
  lines.push('# TYPE fr_andon_state_readable gauge');
  lines.push(
    `fr_andon_state_readable ${cachedAndonState !== null && cachedAndonState.engaged !== null ? 1 : 0}`,
  );

  // ⭐ WITHOUT THIS, THE GAUGE ABOVE IS CONFIDENTLY WRONG. The cache is only as
  // true as its last publisher, and both publishers are request-driven: a
  // conveyor that stopped calling, or an andon endpoint nobody polls, freezes a
  // stale `fr_andon_engaged 0` that an alert will believe for days. The age is
  // what lets a rule require `fr_andon_state_age_seconds < X` before trusting the
  // state at all. Omitted when there has never been an observation — there is no
  // honest number for that, and `_readable 0` already reports it.
  lines.push(
    '# HELP fr_andon_state_age_seconds Seconds since fr last read the cord state. No sample when it has never read it. A rule that trusts fr_andon_engaged must bound this.',
  );
  lines.push('# TYPE fr_andon_state_age_seconds gauge');
  if (cachedAndonState !== null) {
    // Clamped at 0: the clock can step backwards (NTP), and a
    // negative age is a nonsense an alert would silently treat as "very fresh".
    const ageSeconds = Math.max(0, (nowMs() - cachedAndonState.observedAtMs) / 1000);
    lines.push(`fr_andon_state_age_seconds ${ageSeconds}`);
  }

  // ⛔ NO `fr_andon_worker_replicas` HERE, DELIBERATELY. The series was deleted on
  // 2026-11-02; the header comment above this renderer says why. The estate signal
  // is kube-state-metrics.

  // ⭐ THE ONE SERIES IN THIS FILE THAT IS ALWAYS EMITTED, AND THAT IS THE WHOLE
  // POINT (fr#1208). Every other andon signal here needs somebody to consult the
  // cord first, and an `andon_state` singleton that has gone missing halts the
  // conveyor — which removes the traffic that would have published it. A gauge
  // that appears only under load cannot report a condition that stops the load.
  //
  // ⛔ AND `0` IS NOT THE FABRICATED ZERO THE COMMENTS ABOVE REFUSE. There, `0`
  // was the REASSURING value ("released", "nothing held down") and publishing it
  // for an unknown would have invented an all-clear. Here the polarity is
  // inverted: `0` is the ALARM. It states one proposition — "a gate consulting
  // this cord right now would HALT on the switch itself" — which is true for an
  // absent row AND for a read that threw, because ANDON_GATE_POLICY makes both
  // fail closed. An unknown therefore renders as the LOUD value, never the quiet
  // one, so a never-probed cold start cannot suppress the alert; it can at worst
  // fire it one scrape early. `fr_andon_state_readable` remains the series that
  // separates "absent" from "fr cannot read it" when that distinction matters.
  lines.push(
    '# HELP fr_andon_state_initialised 1 when the andon_state singleton (id=1) is present, so the cord can be read at all. 0 when it is ABSENT or fr could not determine it — under fr#1208 policy every gate HALTS in both cases, so 0 is the alarm value and is always emitted. Refreshed on each scrape, independently of any cord consult: this series is correct with zero conveyor traffic. Does NOT say whether the cord is pulled — that is fr_andon_engaged.',
  );
  lines.push('# TYPE fr_andon_state_initialised gauge');
  lines.push(`fr_andon_state_initialised ${cachedAndonRowPresent === true ? 1 : 0}`);

  return lines;
}

// ════════════════ THE CHOKEPOINT BRAKE'S OWN HEALTH (fr#1195) ════════════════
//
// WHAT THIS IS FOR. The andon cord is enforced per-workflow today and 24 of 27
// dispatcher workflows have no brake at all. The chosen design puts ONE brake
// subworkflow in n8n that consults `GET /api/internal/andon` and fails CLOSED
// after a grace window — i.e. a cord it CANNOT READ eventually halts the fleet
// just as a pulled cord does. That trade is only acceptable if the "cannot read"
// regime is VISIBLE, because it is the one regime in which the estate stops for a
// reason no operator chose.
//
// ⛔ AND fr CANNOT OBSERVE IT ITSELF. Every existing andon series is published by
// a reader that SUCCEEDED in reaching fr: `fr_andon_gate_total` counts answers fr
// GAVE, `fr_andon_brake_total` counts decisions fr MADE. A read that never
// arrived — fr unreachable, the pod rolling, DNS gone, the mesh denying — is by
// construction invisible to all of them. Only the CALLER knows it happened, and
// only the caller knows how many times in a row. So the streak is REPORTED to fr
// (`POST /api/internal/andon/read-failure`), not derived by fr. That is why
// `consecutive` is in the wire body and is not a number this module counts: fr
// counting its own missed requests is the thing that cannot work.
//
// ⭐ THE ENDPOINT IS A REPORT SINK, NEVER AN INPUT TO A HALT. A rejected or failed
// report must not read back to the brake as a failed read of the cord — that
// would let a validation bug or an fr blip halt the fleet through the very
// telemetry path built to explain halts. Hence: no auth (same posture as the
// interlock it accompanies), lenient about unknown keys, and a 400 that names
// itself so the n8n side can tell "fr rejected my report" from "fr could not
// answer about the cord".
//
// ⛔ THESE ARE NEW SERIES AND THAT IS NOT A STYLE CHOICE. `fr_andon_engaged` means
// EXACTLY "is the cord pulled": two live Prometheus rules consume it and one GATES
// a second alert on `== 1`, so a third value or a new label there would silently
// suppress the alert it exists to gate, with NO DIFF IN THE RULE FILE. Same
// argument as `fr_andon_unrestored_workflows` and `fr_andon_state_initialised`
// above; this is the third time it has been made in this file. Never overload;
// always add.
//
// ⛔ CARDINALITY IS THE ONE REAL HAZARD HERE, AND AN ALLOWLIST IS THE WRONG FIX.
// `caller` arrives over the wire from n8n and a Prometheus label fed from an
// untrusted string is a cardinality bomb. A CLOSED set — the pattern the two
// counters above use — cannot be it: the callers are ~27 dispatcher workflow
// names that change without fr shipping, so an allowlist would silently collapse
// every real caller to `other` and destroy the axis exactly when a new workflow
// starts failing. So the bound is STRUCTURAL instead, three independent limits:
//
//   1. CHARSET — anything outside `[A-Za-z0-9_.:-]` becomes `_`. This is also the
//      escaping story: a value that cannot contain `"`, `\` or a newline cannot
//      break the exposition format or forge a second label, so there is no
//      escape function to get wrong.
//   2. LENGTH — clamped to `ANDON_CALLER_MAX_LENGTH`.
//   3. DISTINCT VALUES — a registry capped at `MAX_ANDON_PROBE_CALLERS`. Once
//      full, every NEW value collapses to `other`. The total series count is
//      therefore bounded by `(MAX + 2) x (1 + |causes|)` no matter what is POSTed,
//      and the cap is a CEILING rather than a filter: the first 32 real callers
//      keep their own axis.
//
// ⭐ `other` GROWING IS ITSELF THE SIGNAL that the cap was reached, which an
// allowlist-based design cannot distinguish from "no unusual callers". Both it and
// `unknown` (a report with no usable caller) are pre-seeded, so each is a series
// that exists at zero rather than one that appears from nowhere.

/**
 * Why a halt happened, from the BRAKE's point of view. A closed 2-set, and the
 * distinction is the whole point of the chokepoint design:
 *
 *   `pulled`     — the cord was read and it said engaged. A human chose this.
 *   `unreadable` — the cord could not be read and the grace window expired, so
 *                  the brake failed CLOSED. NOBODY chose this, and it is the
 *                  regime the fail-closed trade was accepted on condition of
 *                  being able to see.
 *
 * ⛔ Not folded into `fr_andon_brake_total{outcome}`: that counter's surface axis
 * is fr's own chokepoints and it has no caller axis at all, so it cannot name
 * WHICH workflow halted — and its `andon_unreadable` value means "fr could not
 * read the row", a different event from "the caller could not reach fr".
 */
export const ANDON_HALT_CAUSES = ['pulled', 'unreadable'] as const;
export type AndonHaltCause = (typeof ANDON_HALT_CAUSES)[number];

/** Limit 2 of 3 on the `caller` label. See the section header. */
export const ANDON_CALLER_MAX_LENGTH = 64;

/**
 * Limit 3 of 3: how many DISTINCT `caller` values may ever own their own series.
 *
 * 32 is chosen against a measured population — 27 dispatcher workflows — plus
 * headroom, not picked round. Raising it raises the series ceiling linearly; it
 * is exported so a test can pin the bound rather than trust this comment.
 */
export const MAX_ANDON_PROBE_CALLERS = 32;

/** A report with no usable caller. Pre-seeded so it exists at zero. */
export const ANDON_CALLER_UNKNOWN = 'unknown';
/** The overflow bucket once the registry is full. Pre-seeded for the same reason. */
export const ANDON_CALLER_OVERFLOW = 'other';

/** Everything the exposition format could choke on, in one class. */
const CALLER_UNSAFE_RE = /[^A-Za-z0-9_.:-]+/g;

/**
 * Insertion-ordered registry of every REPORTED caller that has its own series.
 *
 * A Set rather than a count so the cap is a CEILING on distinct values and not a
 * rate limit: a caller already admitted keeps its axis forever, and only a value
 * that would be one past the cap collapses.
 *
 * ⛔ IT STARTS EMPTY, AND THE TWO SYNTHETIC CALLERS ARE NOT IN IT. They are added
 * by the RENDERER instead, for two independent reasons. (1) Provability: seeded
 * here they would be re-added by the (since removed) test-only probe reset too, so the
 * zero baseline had TWO guarantors and deleting EITHER left the suite green —
 * measured, both mutations passed. One guarantor, in the renderer, is a guarantee
 * a test can actually kill. (2) Budget: `unknown` and `other` are fr's own
 * bookkeeping, so letting them consume 2 of the caller slots would silently shrink
 * the real-workflow budget from 32 to 30.
 */
const probeCallers = new Set<string>();

const unreadableByCaller = new Map<string, number>();
const haltsByCauseCaller = new Map<string, number>();

const haltKey = (c: AndonHaltCause, caller: string): string => `${c}|${caller}`;

/**
 * Turn an untrusted wire string into a bounded, exposition-safe label value.
 *
 * ⛔ THE THREE LIMITS ARE APPLIED IN THIS ORDER ON PURPOSE. Sanitise BEFORE
 * clamping (so a 64-char prefix of junk cannot smuggle a quote past the clamp)
 * and clamp BEFORE the registry check (so `x…64chars…A` and `x…64chars…B` are ONE
 * registry entry rather than two, which is what stops a long-prefix caller from
 * eating the whole cap).
 *
 * ⚠️ Exported for the route AND for tests. A cardinality bound that lives only
 * inside a private function is a bound nothing can pin, and this one is the
 * difference between a label and an outage.
 */
export function normaliseAndonCaller(raw: unknown): string {
  if (typeof raw !== 'string') return ANDON_CALLER_UNKNOWN;
  const sanitised = raw.trim().replace(CALLER_UNSAFE_RE, '_').replace(/^_+|_+$/g, '');
  if (sanitised.length === 0) return ANDON_CALLER_UNKNOWN;
  const clamped = sanitised.slice(0, ANDON_CALLER_MAX_LENGTH);
  // ⛔ THE TWO SYNTHETIC NAMES ARE RESERVED AND NEVER ENTER THE REGISTRY. They are
  // fr's own bookkeeping, emitted by the renderer, and a caller that happens to be
  // called `unknown` (or a re-normalisation of a value this function already
  // returned — it is applied twice on the interlock path) must not spend a slot on
  // one. MEASURED: without this, one consult carrying no caller header registered
  // `unknown` and shrank the real-workflow budget by one.
  if (clamped === ANDON_CALLER_UNKNOWN || clamped === ANDON_CALLER_OVERFLOW) return clamped;
  if (probeCallers.has(clamped)) return clamped;
  if (probeCallers.size >= MAX_ANDON_PROBE_CALLERS) return ANDON_CALLER_OVERFLOW;
  probeCallers.add(clamped);
  return clamped;
}

/**
 * The shared streak, in reports rather than in observations fr made.
 *
 * ⚠️ `0` is a real value here, not a "never observed" placeholder: see the
 * renderer for why this gauge has the OPPOSITE polarity to `fr_andon_engaged` and
 * is therefore always emitted.
 */
let probeUnreadableStreak = 0;

/**
 * Count a HALT, by cause and by the caller that halted.
 *
 * ⛔ Never throws, for the same reason {@link reportAndonBrakeDecision} does not:
 * one of its call sites is on the interlock that decides whether work may start.
 */
export function recordAndonHalt(cause: AndonHaltCause, caller: unknown): void {
  try {
    const c = (ANDON_HALT_CAUSES as readonly string[]).includes(cause as string)
      ? cause
      : 'unreadable';
    const k = haltKey(c, normaliseAndonCaller(caller));
    haltsByCauseCaller.set(k, (haltsByCauseCaller.get(k) ?? 0) + 1);
  } catch (err) {
    // ⚠️ LOGGED, not swallowed. A metrics write that fails silently is the exact
    // silent-swallow shape, and a halt counter
    // that quietly stopped counting halts is worse than one that never existed.
    console.error(
      '[andon-probe] failed to record a halt; the counter is now under-reporting:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** What the n8n brake reported about a failed read of the cord. */
export interface AndonProbeUnreadableReport {
  /** Already-normalised or raw; {@link normaliseAndonCaller} is idempotent. */
  caller: unknown;
  /**
   * How many failed reads IN A ROW the caller has now seen. Owned by the caller,
   * not derived here — fr cannot count requests that never reached it.
   */
  consecutive: number;
  /** Did the caller HALT on this one (grace window expired)? */
  halted: boolean;
}

/**
 * Record one failed read of the cord, as reported by the caller.
 *
 * The streak is a MAX, not a last-write: several brake instances share one
 * `fr_andon_probe_unreadable_streak`, and taking the max means the gauge answers
 * "how bad is it right now" rather than "what did the most recent reporter
 * happen to see". A definite readable answer from the interlock is what clears it
 * ({@link resetAndonProbeStreak}) — never the passage of time, because a streak
 * that decays on its own would go quiet exactly while the fleet stayed halted.
 *
 * ⛔ Never throws. Same reason as {@link recordAndonHalt}.
 */
export function reportAndonProbeUnreadable(report: AndonProbeUnreadableReport): void {
  try {
    const caller = normaliseAndonCaller(report.caller);
    unreadableByCaller.set(caller, (unreadableByCaller.get(caller) ?? 0) + 1);
    const consecutive = Number.isFinite(report.consecutive)
      ? Math.max(0, Math.floor(report.consecutive))
      : 0;
    probeUnreadableStreak = Math.max(probeUnreadableStreak, consecutive);
    if (report.halted === true) recordAndonHalt('unreadable', caller);
    console.error(
      JSON.stringify({
        telemetry: 'andon_probe_unreadable',
        caller,
        consecutive,
        halted: report.halted === true,
        streak: probeUnreadableStreak,
      }),
    );
  } catch (err) {
    console.error(
      '[andon-probe] failed to record an unreadable-cord report; the streak gauge is now stale:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Clear the shared streak — the cord was definitely readable.
 *
 * ⭐ ONLY A DEFINITE ANSWER CLEARS IT, and `uninitialised`/`unreadable` do NOT.
 * The gauge's proposition is "callers currently cannot read the cord", and fr
 * answering "I cannot name my own cord state" does not refute it. Using the same
 * two-state conjunction as {@link publishAndonStateForMetrics} keeps the two
 * series from disagreeing about what "readable" means.
 *
 * ⛔ Never throws.
 */
export function resetAndonProbeStreak(): void {
  try {
    probeUnreadableStreak = 0;
  } catch (err) {
    console.error(
      '[andon-probe] failed to clear the unreadable streak; the gauge may read high:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The three fr#1195 series. Pushed by routes/metrics.ts alongside
 * {@link renderAndonHaltMetrics}.
 *
 * ⛔ IT TOUCHES NOTHING THAT ALREADY EXISTS. No line here names
 * `fr_andon_engaged`, `fr_andon_state_readable`, `fr_andon_state_age_seconds`,
 * `fr_andon_unrestored_workflows`, `fr_andon_state_initialised` or
 * `fr_andon_brake_total`, and this function cannot reach their caches. That
 * separation is the fr#1195 constraint expressed as code rather than as a promise.
 */
export function renderAndonProbeMetrics(): string[] {
  const lines: string[] = [];
  // ⭐ THE RENDERER IS THE GUARANTOR OF THE ZERO BASELINE, NOT THE REGISTRY'S
  // INITIALISER — and this is a MEASURED correction, not a preference. The seeds
  // were originally only in `probeCallers`'s initialiser, and a mutation that
  // deleted them left the whole suite GREEN: the (since removed) test-only probe reset
  // re-added them, so every test observed the RESET and no test could ever observe
  // the initialiser. The guarantee has to live where the exposition is produced,
  // which is here; unioning the two constants in makes it provable (deleting this
  // union reddens the cold-start test) and makes the initialiser redundant rather
  // than load-bearing. Same conclusion `andon-gate-metrics.ts` records for its own
  // seed loop.
  //
  // Sorted so a scrape diff is readable and a test can assert the exposition
  // without sorting it first.
  const callers = [
    ...new Set<string>([ANDON_CALLER_UNKNOWN, ANDON_CALLER_OVERFLOW, ...probeCallers]),
  ].sort();

  lines.push(
    '# HELP fr_andon_halt_total Halts of autonomous work by the andon chokepoint brake, by CAUSE and by the caller that halted. `cause="pulled"` is an operator decision; `cause="unreadable"` is the brake failing CLOSED because it could not read the cord, which nobody chose. Does NOT say whether the cord is pulled right now — that is fr_andon_engaged.',
  );
  lines.push('# TYPE fr_andon_halt_total counter');
  for (const cause of ANDON_HALT_CAUSES) {
    for (const caller of callers) {
      lines.push(
        `fr_andon_halt_total{cause="${cause}",caller="${caller}"} ${haltsByCauseCaller.get(haltKey(cause, caller)) ?? 0}`,
      );
    }
  }

  lines.push(
    '# HELP fr_andon_probe_unreadable_total Failed reads of the andon cord, as REPORTED by the caller that failed. fr cannot observe these itself — a request that never arrived leaves no trace in any series fr publishes — so this counter only moves when a caller reports it via POST /api/internal/andon/read-failure.',
  );
  lines.push('# TYPE fr_andon_probe_unreadable_total counter');
  for (const caller of callers) {
    lines.push(
      `fr_andon_probe_unreadable_total{caller="${caller}"} ${unreadableByCaller.get(caller) ?? 0}`,
    );
  }

  // ⭐ ALWAYS EMITTED, AND 0 IS THE HEALTHY VALUE — the opposite polarity to
  // `fr_andon_engaged`, whose sample is OMITTED for an unknown precisely because
  // its `0` is a claim about the cord. Here `0` claims only "no caller has
  // reported a current run of failed reads", which is true on a cold start and
  // stays true until somebody reports otherwise. A gauge that appeared only once
  // the fleet was already failing could not be alerted on with `> N` before the
  // first failure, which is the whole use.
  lines.push(
    '# HELP fr_andon_probe_unreadable_streak Consecutive failed reads of the cord currently reported by the worst-off caller, 0 when healthy. Cleared only when the interlock gives a DEFINITE answer (released or engaged) — never by time, so it cannot go quiet while the fleet stays halted.',
  );
  lines.push('# TYPE fr_andon_probe_unreadable_streak gauge');
  lines.push(`fr_andon_probe_unreadable_streak ${probeUnreadableStreak}`);

  return lines;
}
