// andon-cord-helpers.ts — pure presentation logic for the GLOBAL andon cord
// header control (AndonCord.svelte). Kept side-effect-free so it can be
// unit-tested in isolation (the .svelte file is not test-mounted; see
// settings/admin/andon/page-helpers.ts for the same split).
//
// `durationText` is imported rather than re-implemented: it already renders
// seconds as "12s" / "5m" / "2h 5m" and already refuses to render a negative
// or non-numeric span (grep `durationText` in components/verification/logic.ts).
// A second relative-time formatter here would be the same rounding rules with
// a different set of bugs.
//
// ⭐ THE ACTUATOR CHANGED. The cord no longer deactivates workflows; it scales
// the `n8n/n8n-worker` Deployment to 0 (engaged) or 1 (released). In queue mode
// the worker is the only executor of automatic work, so 0 stops every workflow
// while the editor, REST API and n8n-mcp stay up (backend/src/lib/k8s-scale.ts).
// That removes the whole "N workflows paused / M failed to reactivate" family of
// fields from the API — grep `paused_count` here and you will find nothing,
// because a count of workflows is no longer a fact this contract carries.

import { durationText } from './verification/logic';

/**
 * What the LAST fr→n8n scale attempt recorded (backend migration 226 columns).
 *
 * ⚠️ `attempted_at` is OVERLOADED in the DB: the disengage path reuses the same
 * column to mean "the release scale ran at". So this block only describes a
 * PAUSE when the intent is `engaged` — {@link andonPauseAttempt} enforces that
 * and returns `n/a` otherwise. Never read it directly.
 */
export interface AndonPauseEvidence {
  attempted_at: string | null;
  error: string | null;
  /**
   * ⭐ THREE FACTS, NEVER TWO. `null` = NOT MEASURED (no attempt is recorded, or
   * the API-server call failed); `0` = the attempt ran and the worker is
   * stopped; `1` = the attempt ran and the worker is up. Mirrors
   * `AndonPauseEvidence` in backend/src/routes/andon.ts.
   *
   * ⛔ Rendering `null` as `0` would report a halt that landed when nothing was
   * measured. Render this one only through
   * {@link pauseEvidenceWorkerReplicas} — a bare `?? 0` reintroduces the
   * collapse the three-valued struct exists to prevent.
   */
  worker_replicas: number | null;
}

/**
 * A bounded live measurement of what the API server reports right now.
 *
 * ⭐ `n8n_live === null` (the field itself) means NOT PROBED.
 * ⭐ `worker_replicas === null` means PROBED AND FAILED.
 * They are different facts and neither is "the worker is stopped". A count of 0
 * is a measurement; a failed probe is the absence of one.
 *
 * `available_replicas` is how many worker pods are actually Ready. A worker
 * scaled back up takes tens of seconds to become available, so 0 here right
 * after a release is a fact about the rollout, NOT a failed release.
 */
export interface AndonLiveProbe {
  measured_at: string;
  worker_replicas: number | null;
  available_replicas: number | null;
  error: string | null;
}

/** Shape returned by GET /api/andon (the header poll). */
export interface AndonGlobalState {
  engaged: boolean;
  engaged_at: string | null;
  engaged_by: string | null;
  /**
   * `spec.replicas` of `n8n-worker` as fr last MEASURED it. `0` = every
   * automatic execution is stopped; `1` = the worker is running; `null` = not
   * measured. ⛔ Never render `null` as either number — see
   * {@link workerReplicasLabel}.
   */
  worker_replicas: number | null;
  /**
   * What a human asked for. `unreadable` = the singleton row could not be read,
   * which the old shape reported indistinguishably from `released`.
   * OPTIONAL: absent from a pre-upgrade backend, and during a rolling deploy.
   */
  intent?: AndonIntent;
  /** OPTIONAL — absent from a pre-upgrade backend. */
  n8n_pause?: AndonPauseEvidence | null;
  /**
   * The kata projects holding the conveyor n8n instance. Non-empty = the worker
   * stays at 0 even with this cord released; it comes back when the last kata
   * releases. OPTIONAL: absent from a pre-upgrade backend.
   */
  kata_holders?: string[];
  /** OPTIONAL — absent from a pre-upgrade backend. `null` = not probed. */
  n8n_live?: AndonLiveProbe | null;
}

/**
 * Shape returned by POST /api/andon/engage|disengage. A superset of
 * AndonGlobalState — engage adds `worker_scale_error` (+ `already_engaged` on a
 * no-op re-pull); disengage adds `worker_scale_error`, `release_status`, and
 * `cleared_pause_evidence`: the pause facts as they stood BEFORE the release
 * overwrote them — `null` when the disengage released nothing (a redundant
 * release describes no pause), absent from a pre-upgrade backend. READER:
 * {@link clearedPauseNote}, appended to the {@link pullFeedback} disengage line.
 */
export interface AndonToggleResult extends AndonGlobalState {
  /**
   * Why the scale write failed, or `null` when it landed. ⚠️ It can also carry a
   * follow-up READ failure after a successful PATCH (backend k8s-scale.ts), so a
   * non-null value is not by itself proof the replica count did not change —
   * pair it with `worker_replicas`.
   */
  worker_scale_error?: string | null;
  already_engaged?: boolean;
  cleared_pause_evidence?: AndonPauseEvidence | null;
  /**
   * AUTHORITATIVE release outcome — `POST /api/andon/disengage` ONLY. See
   * {@link AndonReleaseStatus}.
   *
   * OPTIONAL: absent from a pre-upgrade backend and from the other half of a
   * rolling deploy, which is an ABSENCE of evidence and must not read as
   * `released`.
   *
   * ⛔ Read it through {@link andonReleaseVerdict}, never with an inline
   * `=== 'released_incomplete'`. A value outside the union has to land in
   * `unknown`, and an inline comparison cannot express that — it silently maps
   * every unrecognised status to the success arm.
   */
  release_status?: AndonReleaseStatus;
}

/**
 * How the RELEASE went — the AUTHORITATIVE field, mirroring
 * `AndonReleaseStatus` in backend/src/routes/andon.ts. Its COMPLETE value set,
 * quoted from that source, is `'released' | 'released_incomplete' |
 * 'released_kata_holds'`, and it is carried on the disengage response at TOP
 * LEVEL only. `'released_kata_holds'`: the operator's flag is cleared but a kata
 * still holds the instance, so the worker was deliberately NOT scaled up.
 *
 * ⭐ WHAT `'released'` MEANS: the API server ACCEPTED the scale-up to 1
 * replica. It does NOT mean the worker is serving again — the replacement pod
 * still has to start, and the Deployment is `strategy: Recreate` on a
 * ReadWriteOnce volume. `n8n_live.available_replicas` is the honest measure of
 * whether it came back; never translate `'released'` into "n8n is running".
 *
 * ⛔ NOT a widening of {@link AndonIntent}. The backend's own comment explains
 * why the third value lives on the RELEASE (a thing that happened) and not on
 * the CORD (a state): `engaged` stays `false` and `fr_andon_engaged` stays `0`
 * for a `released_incomplete`, because the cord genuinely is released.
 */
export type AndonReleaseStatus = 'released' | 'released_incomplete' | 'released_kata_holds';

/**
 * What this surface may CLAIM about a release.
 *
 *   'complete'     the backend said `released` — the scale-up was ACCEPTED.
 *   'incomplete'   the backend said `released_incomplete` — the scale-up was
 *                  not confirmed, so automatic execution cannot be assumed back.
 *   'kata_holds'   the backend said `released_kata_holds` — the brake is off but
 *                  a kata holds the instance: the worker stays at 0 until the
 *                  last kata releases. Expected, not a failure.
 *   'unknown'      the field was PRESENT carrying a value this page does not
 *                  recognise (a newer backend, a third status). Unknown is its
 *                  own third thing and must NEVER render as 'complete'.
 *   'not_reported' the field was ABSENT — a pre-upgrade backend, or a rolling
 *                  deploy. Nothing was said, so nothing may be claimed from it;
 *                  callers fall back to the measured replica count, which is
 *                  then the only evidence that exists.
 *
 * ⛔ 'unknown' and 'not_reported' must not collapse into one another: one is a
 * backend that told us something we cannot read, the other a backend that told
 * us nothing. Neither is 'complete'.
 */
export type AndonReleaseVerdict = 'complete' | 'incomplete' | 'kata_holds' | 'unknown' | 'not_reported';

/**
 * The value set, as a runtime list, because the check has to happen at runtime:
 * a union type cannot narrow a string that arrived over the wire.
 */
const KNOWN_RELEASE_STATUSES: readonly string[] = ['released', 'released_incomplete', 'released_kata_holds'];

/**
 * The reader for `release_status` — WRITE-ONLY UNTIL 2026-09-25.
 *
 * ⭐ WHY IT HAS TO EXIST. The backend computes the authoritative answer to "did
 * the brake's release actually bring the estate back" and, until this, its only
 * readers in the whole repo were four backend test assertions. Zero frontend
 * references. An operator pulled the cord, released it, was told "released", and
 * could not see that the worker had not come back.
 *
 * ⚠️ The parameter is typed `unknown` DELIBERATELY. This value crosses the
 * wire, so the arm that handles a value outside the union must be REACHABLE —
 * narrowing the parameter to {@link AndonReleaseStatus} would make the
 * 'unknown' arm dead code and the defect it exists to prevent unfalsifiable.
 *
 * ⛔ The mutation this forbids is a `default:`/`else` returning 'complete'.
 */
export function andonReleaseVerdict(
  result: { release_status?: unknown } | null | undefined,
): AndonReleaseVerdict {
  if (result === null || result === undefined) return 'not_reported';
  const raw = result.release_status;
  if (raw === undefined || raw === null) return 'not_reported';
  if (typeof raw === 'string' && KNOWN_RELEASE_STATUSES.includes(raw)) {
    if (raw === 'released_incomplete') return 'incomplete';
    if (raw === 'released_kata_holds') return 'kata_holds';
    return 'complete';
  }
  return 'unknown';
}

/**
 * Operator copy for a `spec.replicas` reading.
 *
 * ⭐ The THREE arms are three different facts and each says exactly one:
 *   0        execution is STOPPED (the worker is scaled to 0)
 *   1+       the worker is running
 *   null     NOT MEASURED — unknown, never 0 and never "running"
 *
 * ⛔ The mutation this exists to forbid is `replicas ?? 0` at a call site: it
 * turns "fr could not measure" into "execution stopped", which on a safety
 * interlock reports a halt that may not exist.
 */
export function workerReplicasLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) {
    return 'worker state NOT MEASURED (n8n-worker replica count unknown)';
  }
  if (n === 0) return 'execution STOPPED (n8n-worker scaled to 0)';
  if (n === 1) return 'worker running (n8n-worker at 1 replica)';
  return `worker running (n8n-worker at ${n} replicas)`;
}

/** `workerReplicasLabel` with the leading "n8n-worker" noun, for a table cell. */
export function workerReplicasShortLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'not measured';
  return `${n} — ${n === 0 ? 'execution STOPPED' : 'worker running'}`;
}

// ---------------------------------------------------------------------------
// The three INDEPENDENT axes, and the verdict derived from them.
//
// The defect this replaced: the page rendered "halts all new work system-wide"
// out of a success count alone, so with n8n unreachable the count was 0 and the
// page asserted a system-wide halt anyway. Intent, scale-attempt and liveness
// are three different questions and collapsing them into one boolean is what
// produced a confident false statement on a safety surface.
// ---------------------------------------------------------------------------

export type AndonIntent = 'engaged' | 'released' | 'unreadable';
export type AndonPauseAttempt = 'applied' | 'failed' | 'never_attempted' | 'n/a';
export type AndonLiveness = 'stopped' | 'running' | 'unmeasured' | 'absent';

export type AndonVerdict =
  | 'UNREADABLE'
  | 'CONTRADICTED'
  | 'HALF_ENGAGED'
  | 'STOPPED_UNVERIFIED'
  | 'STOPPED_CONFIRMED'
  | 'RUNNING';

/**
 * True when the backend sent the enriched (post-fix) shape at all.
 *
 * A pre-upgrade backend — or the other half of a rolling deploy — sends only
 * `{engaged, engaged_at, engaged_by, worker_replicas}`. That is an ABSENCE of
 * evidence, not evidence of failure, so it must land in STOPPED_UNVERIFIED and
 * must NOT be reported as "the n8n scale never ran".
 */
function hasVerificationEvidence(state: AndonGlobalState): boolean {
  return (
    state.intent !== undefined ||
    state.n8n_pause !== undefined ||
    state.n8n_live !== undefined
  );
}

/** Axis 1 — what a human asked for. Falls back to the legacy boolean. */
export function andonIntent(state: AndonGlobalState): AndonIntent {
  if (state.intent) return state.intent;
  return state.engaged ? 'engaged' : 'released';
}

/**
 * Axis 2 — did the scale fr attempted actually land?
 *
 * `n/a` covers BOTH "not engaged, so there is no scale to describe" and "the
 * backend told us nothing", because in neither case is there an attempt fact to
 * report. Only a PRESENT block with no timestamp and no error means
 * `never_attempted`.
 */
export function andonPauseAttempt(state: AndonGlobalState): AndonPauseAttempt {
  if (andonIntent(state) !== 'engaged') return 'n/a';
  const p = state.n8n_pause;
  if (p === undefined || p === null) return 'n/a';
  if (p.error) return 'failed';
  if (!p.attempted_at) return 'never_attempted';
  return 'applied';
}

/**
 * The pause-evidence replica count, kept three-valued.
 *
 * Returns `null` when there is nothing to print — the block is absent (an older
 * backend), or present with `worker_replicas: null` (nothing was measured). It
 * returns `0` unchanged, because a scale attempt that genuinely measured the
 * worker at 0 replicas is a real measurement and must stay distinguishable from
 * "no attempt". Callers render the `null` through {@link workerReplicasLabel}
 * ("NOT MEASURED"), never as `0`.
 *
 * ⛔ The mutation this exists to forbid is `?? 0` at the call site.
 */
export function pauseEvidenceWorkerReplicas(
  p: AndonPauseEvidence | null | undefined,
): number | null {
  if (p === undefined || p === null) return null;
  return p.worker_replicas ?? null;
}

/** `pauseEvidenceWorkerReplicas` as operator-facing copy. `null` → "not recorded". */
export function pauseEvidenceWorkerReplicasLabel(
  p: AndonPauseEvidence | null | undefined,
): string {
  const n = pauseEvidenceWorkerReplicas(p);
  if (n === null) return 'no n8n-worker replica count recorded';
  return workerReplicasLabel(n);
}

/**
 * Axis 3 — what the API server says the worker is doing right now.
 *
 * ⛔ `absent` (not probed) and `unmeasured` (probed, failed) must never collapse
 * into `stopped`. Only a successful probe returning 0 is `stopped`.
 */
export function andonLiveness(state: AndonGlobalState): AndonLiveness {
  const l = state.n8n_live;
  if (l === undefined || l === null) return 'absent';
  const replicas = l.worker_replicas;
  if (replicas === null || replicas === undefined) return 'unmeasured';
  return replicas === 0 ? 'stopped' : 'running';
}

/**
 * The rendered verdict. Precedence is top-down and deliberate:
 *
 *   UNREADABLE          the switch could not be read — or was never read at all
 *   CONTRADICTED        engaged, but the live probe still measures a worker
 *   HALF_ENGAGED        engaged, but the scale failed / never ran
 *   STOPPED_UNVERIFIED  engaged + scale applied, but nothing re-checked the worker
 *   STOPPED_CONFIRMED   engaged + scale applied + a live probe measured 0 replicas
 *   RUNNING             the cord is released
 *
 * ⭐ Only STOPPED_CONFIRMED may carry the "halts all new work system-wide"
 * claim. ⭐ And the INTENT stays `engaged` in every stopped variant — the
 * operator's button must keep reading "Disengage". Presenting a half-landed
 * pull as un-pulled would be a DIFFERENT lie, and a worse one: it invites an
 * operator to re-pull a cord that is already down.
 *
 * ⚠️ 'RUNNING' is a statement about the CORD, not about the worker. A released
 * cord whose scale-up never landed still has the worker at 0; that contradiction
 * is named by {@link workerReplicasLabel} / `globalCordStatus`, which carry the
 * measured replica count alongside this verdict.
 */
export function andonVerdict(state: AndonGlobalState | null): AndonVerdict {
  // ⭐ `null` means we hold NO cord state: the GET has not landed yet, or it
  // failed. That is the SAME epistemic state the backend already names
  // `intent: 'unreadable'` (see the `if (!row)` branch in
  // backend/src/routes/andon.ts — grep `intent: 'unreadable'` there), one layer
  // further out: there the singleton row could not be read, here the response
  // could not be.
  //
  // ⚠️ This line used to be `return 'RUNNING'`, commented "keep the
  // long-standing fail-open bias so a network blip never paints a false halt".
  // The bias is right; siting it HERE was the defect. Fail-open belongs in what
  // the system DOES — the backend keeps surfacing `engaged: false` so
  // production keeps running when the switch is broken — never in what the UI
  // CLAIMS. Via globalCordStatus (andon/page-helpers.ts) 'RUNNING' printed a
  // green "✓ Running / All automation active — no global halt in effect." over
  // a cord nobody had successfully read, on a safety-interlock surface: the
  // page knew nothing and told the operator every automation was healthy.
  //
  // ⛔ And it must NOT become a STOPPED_* verdict either. That is the
  // mirror-image lie: it tells an operator the cord is pulled when it may not
  // be, which invites them to walk away from a running line. Unknown is its own
  // third thing, and UNREADABLE is that thing — it is rendered as
  // "⚠ UNKNOWN" and claims nothing in either direction.
  if (!state) return 'UNREADABLE';
  const intent = andonIntent(state);
  if (intent === 'unreadable') return 'UNREADABLE';
  if (intent === 'released') return 'RUNNING';
  // Engaged from here down.
  if (!hasVerificationEvidence(state)) return 'STOPPED_UNVERIFIED';
  if (andonLiveness(state) === 'running') return 'CONTRADICTED';
  const pause = andonPauseAttempt(state);
  if (pause === 'failed' || pause === 'never_attempted') return 'HALF_ENGAGED';
  if (pause === 'n/a') return 'STOPPED_UNVERIFIED';
  return andonLiveness(state) === 'stopped'
    ? 'STOPPED_CONFIRMED'
    : 'STOPPED_UNVERIFIED';
}

/**
 * Skew tolerance. Two clocks (fr's server, the operator's browser) produce the
 * probe timestamp and the "now" it is compared against, so a measurement taken
 * one second ago can legitimately read as being in the future. Inside this
 * band the age is reported as "just now"; beyond it the skew is SAID, never
 * silently rendered as a negative age.
 */
const PROBE_SKEW_TOLERANCE_MS = 2_000;

/**
 * How old the live worker probe is — the READER for `AndonLiveProbe.measured_at`.
 *
 * ⭐ WHY IT HAS TO BE RENDERED. `n8n_live` exists so this surface can say
 * whether "the worker is stopped" was actually VERIFIED. A verification with no
 * timestamp cannot be judged for freshness: an operator cannot tell a
 * measurement from ten seconds ago from one from ten minutes ago, and on a
 * safety-interlock surface that difference decides whether they trust it.
 * Consumed by `globalCordStatus` (andon/page-helpers.ts) into the
 * `data-testid="andon-global-verification"` line.
 *
 * Returns `null` when there is NOTHING TO SAY — the probe is absent or `null`,
 * i.e. NOT PROBED. Absence of a measurement is not a stale measurement, and
 * callers must not invent an age for it.
 *
 * ⛔ The four things this must never print, each of which a naive
 * `measured ${(Date.now() - Date.parse(live.measured_at)) / 1000}s ago` does:
 *   * a NEGATIVE age from clock skew ("measured -3s ago"),
 *   * `NaN` from an absent / unparseable timestamp,
 *   * a bare `0` for a probe taken this instant,
 *   * `undefined` for a backend that sent `n8n_live` without `measured_at`.
 * ABSENT (the field is missing — an older backend), NULL (sent as null) and an
 * UNPARSEABLE string are three different facts and get three different phrases;
 * none of them is a duration.
 */
export function liveProbeAgeLabel(live: AndonLiveProbe | null | undefined): string | null {
  if (live === undefined || live === null) return null;
  // Typed as a required `string`, but this crosses the wire: a pre-upgrade
  // backend, or a rolling deploy, can send the block without it.
  const raw = (live as { measured_at?: string | null }).measured_at;
  if (raw === undefined) return 'probe time not reported';
  if (raw === null) return 'probe time not recorded';
  if (typeof raw !== 'string' || raw.trim() === '') return 'probe time unreadable';
  const measured = Date.parse(raw);
  if (Number.isNaN(measured)) return 'probe time unreadable';
  const ageMs = Date.now() - measured;
  if (ageMs < -PROBE_SKEW_TOLERANCE_MS) {
    return 'probe time is AHEAD of this clock — age unknown';
  }
  // Covers both a sub-second age and the tolerated skew band, so no caller ever
  // sees "0s" or a minus sign.
  if (ageMs < 1_000) return 'measured just now';
  // ≥ 1 s by the branch above, so `durationText` cannot return its no-data
  // sentinel here — the only input for which it would.
  return `measured ${durationText(Math.round(ageMs / 1_000))} ago`;
}

export type FeedbackTone = 'ok' | 'warn';

export interface AndonFeedback {
  tone: FeedbackTone;
  text: string;
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

/** Confirm copy shown BEFORE engaging — a system-wide freeze is irreversible-ish. */
export function confirmEngageMessage(): string {
  return (
    'Pull the GLOBAL andon cord?\n\n' +
    'This scales the n8n-worker Deployment to 0, which STOPS all automatic ' +
    'execution across every workspace until a super-admin disengages it. ' +
    'The n8n editor, REST API and MCP stay up. In-flight runs drain; no new work starts.'
  );
}

/**
 * Confirm copy shown BEFORE disengaging.
 *
 * ⛔ It does NOT say "work resumes". `release_status: 'released'` means the
 * scale-up was ACCEPTED — the worker pod still has to start, and it is a
 * Recreate deployment on a ReadWriteOnce volume, so that can take a while.
 */
export function confirmDisengageMessage(): string {
  return (
    'Release the global andon cord?\n\n' +
    'This scales the n8n-worker Deployment back to 1. Automatic execution ' +
    'resumes only once the worker pod has started — an accepted scale-up is ' +
    'not the same as n8n running again.'
  );
}

/**
 * What the release just ERASED, as one operator-facing clause — the READER for
 * `AndonToggleResult.cleared_pause_evidence`.
 *
 * ⭐ WHY THIS IS THE ONLY PLACE IT CAN BE SAID. A release NULLs the pause
 * columns and rewrites `worker_scale_error` with the RELEASE outcome, so the
 * moment the operator clicks Disengage the page's verification line drops from
 * "⚠ Half-engaged — the scale FAILED" to a plain "✓ Running" and the fact is
 * gone from every endpoint. The header cord (AndonCord.svelte) has no
 * verification line at all, so for an operator who releases from there this
 * clause is the ONLY surface that can ever carry it.
 *
 * ⭐ It reports only what CONTRADICTS the freeze the operator believed in:
 *   * `error` set                 → the scale had not been confirmed to land.
 *   * `worker_replicas > 0`       → the worker was MEASURED STILL RUNNING.
 *   * `worker_replicas: null`     → nothing was ever measured.
 * A recorded `worker_replicas: 0` returns `null`: the freeze was real and
 * re-stating it would be noise.
 *
 * ⛔ `worker_replicas: 0` is NOT an absence — it is a measured "the worker is
 * stopped" and it stays silent. Reading it as "never attempted" is the exact
 * collapse {@link pauseEvidenceWorkerReplicas} exists to prevent.
 *
 * ABSENT vs NULL, and why both are silent rather than reassuring: `undefined`
 * means a pre-upgrade backend never sent the field — nothing is known, and
 * printing "no scale was recorded" would be inventing a finding. `null` means a
 * CURRENT backend sent it explicitly, which it does only when this disengage
 * released nothing (see `clearedPauseEvidenceForRelease` in
 * backend/src/routes/andon.ts) — there is no pause to describe. Neither is a
 * warning, and neither may be rendered as one.
 */
export function clearedPauseNote(
  ev: AndonPauseEvidence | null | undefined,
): AndonFeedback | null {
  if (ev === undefined || ev === null) return null;
  if (typeof ev.error === 'string' && ev.error.trim() !== '') {
    return {
      tone: 'warn',
      text: `⚠ the halt this released was NOT confirmed — the n8n-worker scale did not land cleanly (${ev.error}); automatic execution may have continued during the freeze`,
    };
  }
  if (ev.worker_replicas === null || ev.worker_replicas === undefined) {
    return {
      tone: 'warn',
      text: '⚠ no n8n-worker scale attempt was ever recorded for the halt this released — the freeze may never have reached n8n',
    };
  }
  if (ev.worker_replicas > 0) {
    return {
      tone: 'warn',
      text: `⚠ the halt this released had NOT landed — n8n-worker was measured at ${ev.worker_replicas} replica${plural(ev.worker_replicas)}, so automatic execution continued during the freeze`,
    };
  }
  return null;
}

/**
 * Human feedback for a completed engage/disengage POST. `ok` = the scale landed
 * and was confirmed; `warn` = fr's side flipped but the worker's replica count
 * is running, failed, or NOT MEASURED (surfaced so the operator knows to retry
 * / check the Deployment).
 *
 * ⛔ Every line here states a MEASUREMENT. `null` is spelled "NOT MEASURED",
 * never 0, and an accepted release is never spelled "n8n is back".
 */
export function pullFeedback(
  action: 'engage' | 'disengage',
  result: AndonToggleResult,
): AndonFeedback {
  const err = result.worker_scale_error ?? null;
  const replicas = result.worker_replicas ?? null;

  // ⭐ THE LIVE PROBE OUTRANKS THE STORED READING. `worker_replicas` is what the
  // PATCH answered for THIS call; on a re-pull of an already-engaged cord it is
  // the stored row value and nothing was written. The live probe independently
  // re-reads the Deployment, so a PATCH that was accepted while the worker kept
  // running shows up here as a contradiction — the one line the operator
  // actually reads after pulling must not stay calm in that case.
  //
  // Only a MEASURED positive count contradicts. `worker_replicas === null`
  // (probe failed) and `n8n_live` absent (not probed) are unknowns, and are left
  // to the page's verification line rather than overstated here.
  const live = result.n8n_live ?? null;
  const liveReplicas = live?.worker_replicas ?? null;
  // A string only when the probe MEASURED a count; `null` keeps "not measured"
  // out of the contradiction branch rather than rendering it as 0.
  const liveShown = liveReplicas === null ? null : `${liveReplicas}`;

  if (action === 'engage') {
    if (liveShown !== null && liveReplicas !== null && liveReplicas > 0) {
      return {
        tone: 'warn',
        text: `⚠ Flag set, but n8n-worker still reports ${liveShown} replica${plural(liveReplicas)} — automatic execution is NOT stopped${err ? `: ${err}` : ''}`,
      };
    }
    if (replicas === 0) {
      if (result.already_engaged) {
        return { tone: 'ok', text: 'Already stopped — n8n-worker is at 0 replicas' };
      }
      // A non-null `err` here can only be the follow-up READ failing after a
      // successful PATCH (k8s-scale.ts), so the scale DID land; say both facts
      // rather than calling the halt failed.
      return err
        ? { tone: 'warn', text: `⚠ Stopped — n8n-worker scaled to 0, but the confirming read failed: ${err}` }
        : { tone: 'ok', text: '🛑 Stopped — execution STOPPED (n8n-worker scaled to 0)' };
    }
    if (replicas === null) {
      return {
        tone: 'warn',
        text: result.already_engaged
          ? '⚠ Already engaged — but the n8n-worker replica count is NOT MEASURED'
          : `⚠ fr is frozen, but the n8n-worker replica count is NOT MEASURED — the halt is unverified${err ? `: ${err}` : ''}`,
      };
    }
    return {
      tone: 'warn',
      text: `⚠ fr is frozen, but n8n-worker reports ${replicas} replica${plural(replicas)} — automatic execution is NOT stopped${err ? `: ${err}` : ''}`,
    };
  }

  // disengage — ⭐ `release_status` DECIDES, the replica count only DESCRIBES.
  //
  // ⚠️ WHAT THIS REPLACED, and why it was a defect rather than a shortcut:
  // the old code RE-DERIVED the release verdict from a workflow count that
  // arrived from a DIFFERENT read than the authoritative field. A verdict
  // assembled from one field while the authoritative answer sits unread in the
  // same response is the composite-from-two-sources defect this module warns
  // about three times over; and a `?? 0` made an ABSENT count render as
  // "nothing failed", i.e. an absence rendering as a result, on the one line an
  // operator reads after letting the emergency brake off.
  //
  // The replica count is KEPT because it is the detail the operator needs next
  // ("is the worker actually up"), but it does not decide the verdict.
  const verdict = andonReleaseVerdict(result);
  // ⭐ TWO DIFFERENT CYCLES IN ONE LINE, deliberately. `err`/`replicas` describe
  // the release that just ran; `cleared` describes the PAUSE it released, whose
  // evidence this response is the last carrier of. A release can succeed
  // perfectly while revealing that the freeze it ended had never landed, so the
  // note is appended to EVERY arm and can turn an otherwise-clean release amber
  // — the tone follows the worst fact stated, not the last one computed.
  const cleared = clearedPauseNote(result.cleared_pause_evidence);
  const clearedNote = cleared ? ` · ${cleared.text}` : '';

  if (verdict === 'incomplete') {
    return {
      tone: 'warn',
      text: `⚠ Brake OFF but the n8n-worker scale-up was NOT confirmed — do NOT assume automatic execution has resumed${err ? `: ${err}` : ''}${clearedNote}`,
    };
  }
  if (verdict === 'kata_holds') {
    const n = result.kata_holders?.length ?? 0;
    return {
      tone: 'warn',
      text: `⚠ Brake OFF, but ${n > 0 ? `${n} kata${plural(n)}` : 'a kata'} still hold${n === 1 ? 's' : ''} the conveyor n8n — n8n-worker stays at 0 until the last kata releases${clearedNote}`,
    };
  }
  if (verdict === 'unknown') {
    // A status the backend sent and this page cannot read. Unknown is not
    // success: claiming the worker is coming back would be the original defect
    // with a newer payload.
    return {
      tone: 'warn',
      text: `⚠ Brake OFF but the release status is UNRECOGNISED — treat the n8n-worker state as UNKNOWN${err ? `: ${err}` : ''}${clearedNote}`,
    };
  }
  if (verdict === 'complete' && err) {
    // The authoritative field says the scale was accepted and its sibling says
    // the call failed. Reporting the reassuring half is exactly the collapse
    // this change removes, so the CONTRADICTION is what gets said.
    return {
      tone: 'warn',
      text: `⚠ Brake OFF and reported accepted, but the scale reported an error: ${err} — treat the worker state as UNKNOWN${clearedNote}`,
    };
  }
  if (replicas === 0) {
    return {
      tone: cleared ? cleared.tone : 'warn',
      text: `⚠ Brake OFF, but n8n-worker is still at 0 replicas — automatic execution is STOPPED${clearedNote}`,
    };
  }
  if (replicas === null) {
    return {
      tone: cleared ? cleared.tone : 'warn',
      text: `▶ Release accepted — n8n-worker scale-up sent, but the replica count is NOT MEASURED — the worker state is unknown${clearedNote}`,
    };
  }
  return {
    tone: cleared ? cleared.tone : 'ok',
    // ⛔ NOT "Running" and not "n8n is back": an accepted scale-up means the pod
    // has been asked to start, not that it is serving.
    text: `▶ Release accepted — n8n-worker scaled to ${replicas}; the worker pod still has to start${clearedNote}`,
  };
}

/**
 * WHAT THE CORD COVERS, in its visible label. FR-PROJECT-HOME-REDESIGN D2: the
 * header used to read "LINE RUNNING" inside a project — on a CLOSED project too —
 * so the tenant-wide cord read as that project's status. It is the stop for every
 * automation across every project, and its label now says so. One source for the
 * header button and the dashboard's read-only mirror (OperateSummaryCard).
 */
export const ANDON_SCOPE_LABEL = 'Conveyor';

/**
 * Visible state label for the cord — SHORT, because it lives in the top navigation
 * beside the tab strip and a sentence there pushes the navigation off the bar.
 *
 * The word names the STATE OF THE LINE; the qualifiers that used to be spelled out
 * here (why it is stopped, what was measured) moved to {@link andonTitle}, which is
 * the button's tooltip and the one place a full sentence costs nothing.
 *
 *   engaged  + worker > 0    → "stopped ⚠"   (stop did not hold — worker running)
 *   engaged  + anything else → "stopped"
 *   released + worker === 0  → "stopped ⚠"   (released, but the line is still down)
 *   released + worker null   → "running ?"   (nothing measured — do not claim alive)
 *   released + worker === 1  → "running"     (the only unqualified "running")
 *
 * ⛔ A released cord with an UNMEASURED worker must not print a bare "running":
 * null is not a measurement, and that word is how the header claims the line is
 * alive. The `?` is the whole signal and the tooltip says which.
 *
 * `workerReplicas` is optional so a caller that genuinely has no reading does not
 * have to invent one.
 */
export function andonStateLabel(
  engaged: boolean,
  workerReplicas?: number | null,
): string {
  const measured = workerReplicas === null || workerReplicas === undefined ? null : workerReplicas > 0;
  if (engaged) return measured === true ? `${ANDON_SCOPE_LABEL}: stopped ⚠` : `${ANDON_SCOPE_LABEL}: stopped`;
  if (measured === false) return `${ANDON_SCOPE_LABEL}: stopped ⚠`;
  if (measured === null) return `${ANDON_SCOPE_LABEL}: running ?`;
  return `${ANDON_SCOPE_LABEL}: running`;
}

/**
 * Button tooltip. Preserves the "STOPPED by X (5m)" head (the duration label is
 * computed in the component from engaged_at), states the measured worker state,
 * and appends a verification suffix ONLY when the backend actually sent
 * verification evidence.
 *
 * ⭐ Every engaged variant still begins "STOPPED". The tooltip sits on the
 * toggle button, and a half-landed pull is still a PULLED cord: re-labelling it
 * as running would invite an operator to pull it again.
 *
 * A legacy/pre-upgrade payload gets no verification suffix — silence about
 * verification is honest there; inventing "not verified" would not be.
 */
export function andonTitle(state: AndonGlobalState, durationLabel = ''): string {
  const verdict = andonVerdict(state);
  if (verdict === 'UNREADABLE') {
    return 'ANDON STATE UNREADABLE — the cord state could not be read; treat the halt status as UNKNOWN';
  }
  if (!state.engaged) {
    // The label is deliberately two words (it lives in the top navigation); the
    // scope and the measurement live HERE, where a sentence costs no width.
    return `${andonStateLabel(false, state.worker_replicas)} — ${workerReplicasLabel(
      state.worker_replicas,
    )}. Click to stop every workspace's automation.`;
  }
  const by = state.engaged_by ? ` by ${state.engaged_by}` : '';
  const dur = durationLabel ? ` (${durationLabel})` : '';
  const head = `STOPPED${by}${dur} — ${workerReplicasLabel(state.worker_replicas)}`;
  if (!hasVerificationEvidence(state)) return head;
  switch (verdict) {
    case 'CONTRADICTED': {
      const live = state.n8n_live!;
      const n = live.worker_replicas;
      // Unreachable through andonVerdict (CONTRADICTED requires a measured
      // positive count), but the guard keeps "not measured" from ever printing
      // as the number 0.
      if (n === null || n === undefined) return `${head} · n8n-worker state UNMEASURED`;
      return `${head} · n8n-worker still reports ${n} replica${plural(n)} — the halt did NOT land`;
    }
    case 'HALF_ENGAGED':
      return andonPauseAttempt(state) === 'failed'
        ? `${head} · n8n-worker scale FAILED`
        : `${head} · n8n-worker scale never ran`;
    case 'STOPPED_CONFIRMED':
      return `${head} · verified: n8n-worker at 0 replicas`;
    default:
      return `${head} · not verified`;
  }
}
