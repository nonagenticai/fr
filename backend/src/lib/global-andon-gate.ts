// src/lib/global-andon-gate.ts
//
// The GLOBAL andon cord, read-side. When a super-admin engages the cord
// (POST /api/andon/engage) the system must initiate NO new automated work
// until they disengage it. This leaf module is the single read used by every
// fr work-initiation chokepoint (n8n trigger dispatch, macro phase advance,
// project intake automation, the scheduled-trigger tick) to refuse fail-closed.
//
// Leaf on purpose — depends only on the db client + the singleton table — so
// any route/service/worker can import it without forming a cycle. The hard
// stop for n8n's OWN autonomous loops is workflow deactivation done in
// routes/andon.ts; this gate is the fr-side guarantee that no fr code path
// (and therefore no tenant-admin action routed through fr) restarts work while
// the cord is engaged.

import { db as defaultDb } from '../db/client';
import { andonState } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../utils/errors';
// Pure metrics leaf — imports nothing itself, so this stays acyclic and
// `andon-halt-metrics.ts` keeps its "must not transitively import db/client"
// property (its own header explains why). The DB read lives HERE; that module
// only caches and renders.
import {
  publishAndonKataHoldersForMetrics,
  publishAndonRowPresenceForMetrics,
  publishAndonStateForMetrics,
  publishKataFailedHoldersForMetrics,
} from './andon-halt-metrics';

/** The one place this status is written. `status` and `statusCode` cannot drift. */
const ANDON_FROZEN_STATUS = 409;

/**
 * Thrown by work-initiation chokepoints that refuse to act while the global
 * andon cord is engaged.
 *
 * ⚠️ This class used to extend bare `Error` while its own doc-comment said it
 * "Carries an HTTP-friendly 409 so route layers can map it" -- and MEASURED
 * 2026-09-03, ZERO route layers ever did (`grep -rn 'instanceof AndonFrozenError'`
 * returned nothing). `handleError` matches only the AppError family, so a
 * deliberate system-wide emergency stop reached the caller as
 * `500 {"error":"Internal server error"}`: indistinguishable from fr being
 * broken, and retried forever by the n8n modules that retry on `status >= 500`.
 * The intent was written down; the mechanism was never built. Extending
 * AppError IS the mechanism -- no route needs to know about this class now.
 */
export class AndonFrozenError extends AppError {
  /** Legacy alias for `statusCode`; same constant, so they cannot disagree. */
  readonly status = ANDON_FROZEN_STATUS;
  constructor(message = 'Global andon cord is engaged — work is frozen system-wide until a super-admin disengages it.') {
    super(ANDON_FROZEN_STATUS, message);
    // ⛔ after super(): AppError's constructor sets name = 'AppError'.
    this.name = 'AndonFrozenError';
    this.code = 'ANDON_FROZEN';
  }
}

// ─────────────────────── THE ANDON POLICY, STATED ONCE ───────────────────────
//
// fr#1208: FIVE consumers of this one cord had each invented their own answer
// for a MISSING `andon_state` singleton (migration 065's row). `isGlobalAndonEngaged`
// read `row?.engaged === true`, so an absent row meant RELEASED and card moves
// plus n8n dispatch ran freely; `consultAndonForRouterDedupe` in routes/webhooks.ts
// and `coding-github`'s `services/andon.py` both REFUSED on the same absence. A
// mix of fail-open and fail-closed on one emergency brake is not a policy: an
// operator reading either surface could not predict what the other would do.
//
// The owner's standing ruling settles it: "the andon cord/button is an emergency
// brake on the entire system and should always work". Hence the statement below,
// which lives HERE — in the leaf module every gate can already import — so a
// SIXTH consumer inherits it instead of inventing a sixth answer.

/**
 * ⭐ THE ONE ANDON POLICY. Quote this; do not restate it.
 *
 * Read it as two clauses that are deliberately different, because they are
 * different KINDS of surface:
 *
 *   * A GATE — anything that decides whether work may START (this module, the
 *     router-dedupe brake in routes/webhooks.ts, coding-github's mutating-op
 *     guard) — proceeds ONLY on a definite, readable RELEASE. A missing
 *     singleton and a read that throws are both treated as ENGAGED. A gate may
 *     not act on not knowing.
 *
 *   * A DISPLAY surface — `readAndon` / `GET /api/internal/andon`, which halts
 *     nothing and only reports — keeps `engaged:false` for an absent row and
 *     NAMES the absence (`intent:'unreadable'`, interlock `reason:'uninitialised'`).
 *     That is not a fail-open preference; it is how a UI gets to say "the switch
 *     itself is broken" instead of silently drawing a released cord. Display may
 *     be honest about not knowing.
 *
 * The split is display-vs-gate and nothing else. Do not "reconcile" the two by
 * making a gate permissive, and do not make the display refuse — the interlock
 * is what gates READ, so a 500 there would starve them of the reason axis.
 */
export const ANDON_GATE_POLICY =
  'The global andon cord is an emergency brake on the entire system and must always work. ' +
  'Every GATE fails CLOSED: work may start only on a definite, readable RELEASE, so a missing ' +
  'andon_state singleton and a read that throws both HALT. The one deliberate exception is the ' +
  'DISPLAY surface (readAndon / GET /api/internal/andon), which halts nothing and therefore keeps ' +
  'engaged:false while naming the absence honestly. Display may be honest about not knowing; a ' +
  'gate may not act on not knowing.';

/**
 * What a gate's own read of the cord amounted to, normalised.
 *
 * Every gate maps its read onto this before deciding, so the decision itself is
 * made in exactly one function ({@link andonPermitsWork}).
 *
 *   `released`   — a definite read saying the cord is NOT pulled. The ONLY value
 *                  that lets work start.
 *   `engaged`    — a definite read saying a super-admin pulled it.
 *   `missing`    — a definite read of an ABSENT singleton (fr#1208's defect).
 *   `unreadable` — the read failed, or the answer had a shape this gate cannot
 *                  interpret. Includes drift between a consult and its caller.
 */
export type AndonReadVerdict = 'released' | 'engaged' | 'missing' | 'unreadable';

/**
 * ⭐ THE SINGLE POLICY DECISION, for every gate. {@link ANDON_GATE_POLICY} in one
 * expression.
 *
 * ⛔ It is an ALLOWLIST OF ONE on purpose, and that is the whole mechanism: a
 * seventh verdict added to {@link AndonReadVerdict} later — or a value that
 * reaches here from a caller that has drifted — is not `'released'`, so it HALTS
 * by construction. A `verdict !== 'engaged'` formulation would have been the same
 * function today and would silently fail OPEN on the next value added, which is
 * precisely how fr#1208 happened (`row?.engaged === true` is that shape).
 */
export function andonPermitsWork(verdict: AndonReadVerdict): boolean {
  return verdict === 'released';
}

/**
 * Normalise the two axes of `GET /api/internal/andon` onto an
 * {@link AndonReadVerdict}, for the gates that consult the cord over HTTP rather
 * than by reading the row (the router-dedupe brake in routes/webhooks.ts, and
 * `coding-github`'s `services/andon.py`, which reads the same wire shape).
 *
 * ⛔ BOTH axes are required for a release, and the interlock's `uninitialised`
 * becomes `missing` — NOT `released`. Absence is named, never laundered: that
 * mapping is the fr#1208 fix expressed for the HTTP shape, and it is here rather
 * than in each caller so a later consumer cannot quietly re-decide it.
 */
export function andonVerdictFromInterlockAnswer(
  engaged: unknown,
  reason: unknown,
): AndonReadVerdict {
  if (engaged === false && reason === 'released') return 'released';
  if (reason === 'engaged') return 'engaged';
  if (reason === 'uninitialised') return 'missing';
  // `unreadable`, an unrecognised reason, and a non-boolean `engaged` all land
  // here: the consult and this caller cannot agree on what the cord says, and an
  // answer nobody can read is not a release.
  return 'unreadable';
}

/**
 * Is the global andon cord currently engaged?
 *
 * Reads the `andon_state` singleton (id=1) — a local, PK-indexed lookup — and
 * hands the result to {@link andonPermitsWork}, which is where the policy lives.
 *
 * ⚠️ fr#1208: this used to `return row?.engaged === true`, so an ABSENT singleton
 * reported RELEASED and every chokepoint behind this gate (n8n trigger dispatch
 * via integrations/n8n.ts, macro phase advance, the scheduled-trigger tick, and
 * routes/andon.ts :452/:492/:974) let work start while the router-dedupe brake
 * and coding-github were refusing the same absence. That was the DEFECT, not a
 * deliberate availability trade: a `missing` row means the switch is broken, and
 * a broken emergency stop is an engaged one.
 *
 * A read ERROR has always failed closed here and still does: an UNKNOWN state
 * must be treated as engaged rather than letting new work start while a
 * super-admin believes the platform is frozen. The narrow availability cost (a
 * transient fr-DB blip briefly refuses NEW work) is acceptable: the same blip
 * would fail the work's own DB writes anyway, and this read is a fast PK lookup.
 */
export async function isGlobalAndonEngaged(
  dbToUse: typeof defaultDb = defaultDb,
): Promise<boolean> {
  return !andonPermitsWork(await readAndonVerdict(dbToUse));
}

/**
 * The same read as {@link isGlobalAndonEngaged}, before the policy collapses it
 * to a boolean.
 *
 * ⭐ IT EXISTS FOR ONE CALLER AND ONE REASON. `GET /api/internal/andon`
 * (routes/andon.ts) must distinguish `missing` from `unreadable`, because it is
 * the surface that supplies gates with their REASON axis — the boolean throws that
 * distinction away, and `uninitialised` laundered into `unreadable` would kill
 * `fr_andon_brake_total{outcome="andon_uninitialised"}` and
 * `fr_andon_gate_total{reason="uninitialised"}`, the two series an operator uses
 * to tell a broken install from a DB blip.
 *
 * ⛔ A GATE MUST NOT USE THIS TO RE-DECIDE THE POLICY. Pass what it returns to
 * {@link andonPermitsWork}, or call {@link isGlobalAndonEngaged}. Branching on the
 * verdict yourself is how fr#1208 got five answers to one question.
 */
export async function readAndonVerdict(
  dbToUse: typeof defaultDb = defaultDb,
): Promise<AndonReadVerdict> {
  let verdict: AndonReadVerdict;
  try {
    const [row] = await dbToUse
      .select({ engaged: andonState.engaged })
      .from(andonState)
      .where(eq(andonState.id, 1))
      .limit(1);
    // ⛔ Three cases, and the middle one is fr#1208. `row === undefined` is a
    // DEFINITE read of an absent singleton — a different fact from a read that
    // threw, and the gate treats both as engaged while the metrics series
    // (`fr_andon_state_initialised`) keeps them tellable apart.
    if (row === undefined) {
      console.error(
        '[global-andon-gate] andon_state singleton (id=1) is ABSENT; failing CLOSED (treating as ENGAGED). Migration 065 inserts this row — restore it.',
      );
      verdict = 'missing';
    } else {
      verdict = row.engaged === true ? 'engaged' : 'released';
    }
  } catch (err) {
    console.error(
      '[global-andon-gate] failed to read andon_state; failing CLOSED (treating as ENGAGED) until the read recovers:',
      err instanceof Error ? err.message : err,
    );
    verdict = 'unreadable';
  }
  return verdict;
}

/**
 * Refresh the STANDING `fr_andon_state_initialised` gauge: does the singleton
 * exist at all?
 *
 * ⭐ WHY THIS IS NOT PART OF {@link isGlobalAndonEngaged} (fr#1208). Every other
 * andon signal fr exports is traffic-driven — the counters move only when
 * something consults the cord, and the state gauges are published by request
 * handlers. But a MISSING singleton now HALTS the conveyor, which removes the card
 * moves that would have published it: the condition suppresses its own evidence.
 * So this is called from the `/api/metrics/prom` scrape branch in server.ts,
 * where the standing traffic is Prometheus itself, and the gauge is therefore
 * correct with zero conveyor traffic.
 *
 * ⛔ NEVER THROWS, and never affects a gate decision. It is an observation of the
 * switch, not a use of it. A scrape must not be able to fail because the andon
 * table is unreachable — the exporter carries dozens of other series.
 */
export async function refreshAndonStateInitialisedGauge(
  dbToUse: typeof defaultDb = defaultDb,
): Promise<void> {
  try {
    const [row] = await dbToUse
      .select({ engaged: andonState.engaged, kata_holders: andonState.kata_holders })
      .from(andonState)
      .where(eq(andonState.id, 1))
      .limit(1);
    publishAndonRowPresenceForMetrics(row !== undefined);
    // `fr_andon_engaged` + `fr_andon_kata_holders` from the same scrape-time read: correct with
    // zero traffic and straight after a pod restart (a deliberate operator stop generates no
    // consults, and an alert keyed on an ABSENT `fr_andon_engaged` would page for it). An absent
    // row is the interlock's `uninitialised`: not a known state, so no sample for either.
    if (row) {
      publishAndonStateForMetrics({
        engaged: row.engaged,
        reason: row.engaged ? 'engaged' : 'released',
        kataHolders: (row.kata_holders ?? []).length,
      });
    } else {
      publishAndonStateForMetrics({ engaged: true, reason: 'uninitialised' });
      publishAndonKataHoldersForMetrics(null);
    }
  } catch {
    // `null` = could not determine. The renderer maps it to the ALARM value (0),
    // because a read that throws and an absent row halt every gate identically.
    publishAndonRowPresenceForMetrics(null);
    publishAndonStateForMetrics(null);
  }
  // `fr_kata_failed_holders`: failed katas in the holder set (its own read, so a failure here
  // never blanks the two series above).
  try {
    const rows = (await dbToUse.execute(sql`
      SELECT count(*)::int AS n
        FROM andon_state a
        JOIN katas k ON k.id = ANY(a.kata_holders)
       WHERE a.id = 1 AND k.state = 'failed'
    `)) as unknown as Array<{ n: number }>;
    publishKataFailedHoldersForMetrics(rows.length === 1 ? Number(rows[0]!.n) : null);
  } catch {
    publishKataFailedHoldersForMetrics(null);
  }
}

/**
 * Throw {@link AndonFrozenError} when the global cord is engaged. Convenience
 * for chokepoints whose natural failure mode is to refuse (e.g. triggerWorkflow,
 * project creation) rather than silently no-op.
 */
export async function assertGlobalAndonReleased(
  dbToUse: typeof defaultDb = defaultDb,
): Promise<void> {
  if (await isGlobalAndonEngaged(dbToUse)) {
    throw new AndonFrozenError();
  }
}
