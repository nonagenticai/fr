// U11 / D2 — plan conformance read model. A PURE function over the three
// migration-148 tables; GET /api/cards/:id/plan-conformance is a thin route
// over it (routes/cards/plan-pin.ts).
//
// Rules:
//   * No pin ⇒ 'unproven'. Never 'conforms': the absence of a pin is the absence
//     of the yardstick, not a pass.
//   * ONE CLOCK: every ordering and every "before/after" below uses the server-
//     stamped `recorded_at` (DB DEFAULT now(); no caller can set it), ties broken
//     by NUMERIC id. The caller's `at` is informational only — a backdated `at`
//     must not be able to place a re-plan before an activity it would excuse.
//   * An executed activity whose name is NOT in the effective plan's
//     `activity_sequence` for the list it ran in ⇒ a deviation. A list the plan
//     does not name at all has an empty plan, so anything run there deviates.
//     Membership only: the ORDER of execution is not judged (the pin is the set
//     the minter allowed; retries and re-entries legitimately repeat steps).
//   * An excusing event never excuses wholesale. A card_plan_events row that
//     EXCUSING_PLAN_EVENTS admits for its (computed_by, kind, list) RE-PLANS the
//     card, and only if it is VALID:
//       - `detail.new_plan` hashes to `new_plan_sha` (planPinSha256, the pin's
//         own canonicaliser), else `excuse_without_verifiable_plan`;
//       - `prev_plan_sha` equals the sha of the plan in force at its
//         recorded_at (the pin, or the previous VALID re-plan), else
//         `excuse_prev_plan_mismatch`;
//       - the declared `list` is consistent with the recorded activity log
//         (EXCUSE_LIST_RULES), else `excuse_list_inconsistent` — e.g. a `ready`
//         split recorded after DOING activity is a DOING split in disguise.
//     A valid event governs only activities recorded STRICTLY after it; those
//     are judged against its new plan (replace, not union). An invalid one
//     re-plans nothing and is itself a deviation.
//   * An event recorded before the pin cannot exist in normal flow; if one does
//     it re-plans nothing and is a deviation `event_before_pin`.
//   * Every other event — an llm one, a split from `doing`, a reclassify at
//     `ready` — is listed with excuses:false and changes nothing.
//   * LATE-RECORDED ACTIVITY: an activity whose caller `at` precedes a VALID
//     re-plan's recorded_at but whose own recorded_at follows it ⇒ deviation
//     `activity_recorded_after_excuse` ("run X, post the re-plan, then post X").
//     It only ADDS deviations; an honest logger lag across a re-plan is flagged
//     too, deliberately (the logger cannot prove it ran X under the new plan).
//   * ACCEPTED LIMIT (validator, 10-01): the executed-activity logger is
//     best-effort, so plain OMISSION of an activity cannot be detected server-
//     side — a run that never posts X leaves nothing to judge. Today only `doing`
//     activities are logged at all (ncn doing-orchestrate); ready/qa/blocked/done
//     activity is therefore invisible here, which also means the qa/blocked
//     "requires prior doing" rule below is the only list rule with real input.
//   * Verdict, in order: any deviation ⇒ 'deviates'; a pin with ZERO executed
//     activities ⇒ 'unproven' (reason `no_executed_activities`: the executed-
//     activity logger is best-effort, so observing nothing proves nothing);
//     otherwise 'conforms'.

import {
  PlanPinSchema,
  planPinSha256,
  type ExecutedActivityRow,
  type PlanEventComputedBy,
  type PlanEventKind,
  type PlanEventList,
  type PlanEventRow,
  type PlanPinRow,
} from './plan-pin';

/** computed_by → kind → the lists an event of that shape may be emitted from and still excuse. */
export type ExcusingPlanEvents = Readonly<
  Record<PlanEventComputedBy, Readonly<Record<PlanEventKind, readonly PlanEventList[]>>>
>;

/**
 * ⭐ THE RULING, as one table (RULING 10-01 movies-ab, "U11b superseded";
 * ~/.claude/plans/program/20-designs/U2-U11-report-artifact-and-plan-pinning.md).
 * The sequence may change ONLY at Readying (split) and at QA/BLOCKED (split or
 * reclassify); DOING never splits. So an event excuses a deviation only when
 *   computed_by = 'rule' AND
 *     (kind = 'split'      AND list ∈ {ready, qa, blocked}
 *   OR kind = 'reclassify' AND list ∈ {qa, blocked}).
 * `llm` excuses nothing ("no judge can move a card", REALIGN:14). List keys are
 * the plan's own (ncn card_type_descriptions.json; workflows/cells/<list>.json).
 * A later ruling edits THIS DATA and nothing else; the unit test pins it.
 */
export const EXCUSING_PLAN_EVENTS: ExcusingPlanEvents = Object.freeze({
  rule: Object.freeze({
    split: Object.freeze(['ready', 'qa', 'blocked'] as const),
    reclassify: Object.freeze(['qa', 'blocked'] as const),
  }),
  llm: Object.freeze({
    split: Object.freeze([] as const),
    reclassify: Object.freeze([] as const),
  }),
});

/** Does the ruling table admit this event as an excuse? (Timing is checked separately.) */
export function planEventCanExcuse(
  ev: Pick<PlanEventRow, 'computed_by' | 'kind' | 'list'>,
  table: ExcusingPlanEvents = EXCUSING_PLAN_EVENTS,
): boolean {
  const lists = table[ev.computed_by]?.[ev.kind];
  return Array.isArray(lists) && lists.includes(ev.list);
}

/**
 * The declared list must be consistent with the RECORDED activity log, or the
 * event excuses nothing (`excuse_list_inconsistent`). Keyed by the event's
 * `list`; a list absent here has no precondition (it is not admitted anyway).
 *   * forbid_prior_activity_in — invalid if ANY activity in one of these lists
 *     was recorded before OR AT THE SAME INSTANT as the event (`<=`: a tie is
 *     not proof the activity came after, so it does not get the benefit) (a `ready` re-plan after DOING work is a
 *     DOING split in disguise, and DOING never splits).
 *   * require_prior_activity_in — invalid unless at least one activity in one of
 *     these lists was recorded STRICTLY before it (`<`: a tie does not prove it) (a card cannot reach QA/BLOCKED without
 *     having done anything).
 * Data, like EXCUSING_PLAN_EVENTS: a later ruling edits THIS and nothing else.
 */
export interface ExcuseListRule {
  forbid_prior_activity_in: readonly string[];
  require_prior_activity_in: readonly string[];
}
export type ExcuseListRules = Readonly<Partial<Record<PlanEventList, Readonly<ExcuseListRule>>>>;

export const EXCUSE_LIST_RULES: ExcuseListRules = Object.freeze({
  ready: Object.freeze({
    forbid_prior_activity_in: Object.freeze(['doing', 'qa', 'done'] as const),
    require_prior_activity_in: Object.freeze([] as const),
  }),
  qa: Object.freeze({
    forbid_prior_activity_in: Object.freeze([] as const),
    require_prior_activity_in: Object.freeze(['doing'] as const),
  }),
  blocked: Object.freeze({
    forbid_prior_activity_in: Object.freeze([] as const),
    require_prior_activity_in: Object.freeze(['doing'] as const),
  }),
});

/**
 * Is the event's declared list consistent with the recorded activity log?
 * `atOrBefore` = lists with activity recorded_at <= the event's (the FORBID
 * input); `before` = lists with activity recorded_at < the event's (the
 * REQUIRE input). The asymmetry is the point: a same-instant tie never helps
 * the event pass.
 */
export function excuseListConsistent(
  list: PlanEventList,
  prior: { atOrBefore: ReadonlySet<string>; before: ReadonlySet<string> },
  rules: ExcuseListRules = EXCUSE_LIST_RULES,
): boolean {
  const r = rules[list];
  if (!r) return true;
  if (r.forbid_prior_activity_in.some((l) => prior.atOrBefore.has(l))) return false;
  if (r.require_prior_activity_in.length > 0 && !r.require_prior_activity_in.some((l) => prior.before.has(l))) {
    return false;
  }
  return true;
}

export type ConformanceStatus = 'conforms' | 'deviates' | 'unproven';
export type UnprovenReason = 'no_pin' | 'no_executed_activities';
export type EventDeviationReason =
  | 'excuse_without_verifiable_plan'
  | 'excuse_prev_plan_mismatch'
  | 'excuse_list_inconsistent'
  | 'event_before_pin';
export type DeviationReason = 'not_in_effective_plan' | 'activity_recorded_after_excuse' | EventDeviationReason;

export interface Deviation {
  reason: DeviationReason;
  /** The executed activity (not_in_effective_plan, activity_recorded_after_excuse), else null. */
  executed_id: string | null;
  /** The plan event (event reasons, and the re-plan an activity_recorded_after_excuse straddles), else null. */
  event_id: string | null;
  list: string;
  pattern: string | null;
  activity: string | null;
  execution_id: string | null;
  /** The caller's `at` (informational). */
  at: string;
  /** Server-stamped; the clock the verdict was computed on. */
  recorded_at: string;
  /** The effective sequence for that list (empty when the effective plan does not name the list, or for an event deviation). */
  allowed: string[];
  /** sha256 of the plan in force for the row (for an event: the sha its prev_plan_sha had to equal). */
  judged_against_sha: string;
}

export interface PlanConformance {
  status: ConformanceStatus;
  /** Why the verdict is 'unproven'; null otherwise. */
  unproven_reason: UnprovenReason | null;
  pinned: { plan_sha256: string; plan: unknown; created_at: string } | null;
  executed: Array<
    Omit<ExecutedActivityRow, 'at' | 'recorded_at'> & {
      at: string;
      recorded_at: string;
      in_plan: boolean;
      judged_against_sha: string | null;
      /** The plan event whose re-plan was in force, or null when the pin was. */
      judged_against_event_id: string | null;
    }
  >;
  deviations: Deviation[];
  excused_by_events: Array<
    Omit<PlanEventRow, 'at' | 'recorded_at'> & {
      at: string;
      recorded_at: string;
      /** A VALID re-plan: admitted, plan verified, prev_plan_sha matched, list consistent, recorded after the pin. */
      excuses: boolean;
      /** Why this event re-plans nothing although it was admitted (or recorded before the pin); null otherwise. */
      invalid_reason: EventDeviationReason | null;
      /** detail.new_plan present, a valid plan, and its sha equals new_plan_sha. */
      new_plan_verified: boolean;
      /** Activities in this event's plan that the plan before it would NOT have allowed. */
      excused_executed_ids: string[];
    }
  >;
}

/**
 * A timestamp AT THE PRECISION IT CARRIES: `micros` is the value with the
 * missing digits zero-filled, `unknownTail` the largest value those missing
 * digits could add. Six fractional digits ⇒ exact (tail 0); a JS Date, or a
 * string with three, ⇒ tail 999µs; none ⇒ tail 999 999µs. The tail depends
 * only on the digits present, never on the JS type, so a Date and the string
 * `…​.592Z` read identically.
 */
export interface Instant {
  micros: bigint;
  unknownTail: bigint;
}

// ISO-8601 (`T`) or postgres text (` `), 0–6 fractional digits, Z or a numeric offset.
const TIMESTAMP = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d(?::?\d\d)?)$/;

function tailFor(digits: number): bigint {
  return 10n ** BigInt(6 - digits) - 1n;
}

/**
 * Parse a Date or a timestamp string to an Instant. A string that is not one
 * of the accepted shapes THROWS: there is no fallback through `new Date()`,
 * which would silently truncate to milliseconds (the defect this replaced).
 */
export function parseInstant(v: Date | string): Instant {
  if (v instanceof Date) {
    const t = v.getTime();
    if (!Number.isFinite(t)) throw new Error('plan-conformance: invalid Date');
    return { micros: BigInt(t) * 1000n, unknownTail: tailFor(3) };
  }
  const m = typeof v === 'string' ? TIMESTAMP.exec(v) : null;
  if (!m) throw new Error(`plan-conformance: unreadable timestamp ${String(v)}`);
  const [, day, time, frac = '', zone] = m;
  const offset =
    zone === 'Z' ? 'Z' : `${zone!.slice(0, 3)}:${zone!.length > 3 ? zone!.slice(-2) : '00'}`;
  const secs = Date.parse(`${day}T${time}${offset}`);
  if (!Number.isFinite(secs)) throw new Error(`plan-conformance: unreadable timestamp ${v}`);
  return { micros: BigInt(secs) * 1000n + BigInt(frac.padEnd(6, '0')), unknownTail: tailFor(frac.length) };
}

/**
 * A recorded_at as integer MICROSECONDS since the epoch. The ledger reads
 * recorded_at as `YYYY-MM-DDTHH:MM:SS.ffffffZ` so postgres's precision is kept
 * (a JS Date would truncate to ms and make two distinct instants tie).
 */
export function recordedMicros(v: Date | string): bigint {
  return parseInstant(v).micros;
}

/**
 * The latest instant a caller's `at` can denote: its value plus everything its
 * missing digits could add. THE TIE RULE for the late-recorded check: an
 * activity is flagged only when even this latest value is STRICTLY before the
 * re-plan's recorded_at, i.e. when no reading consistent with the digits it
 * carries puts it at or after the re-plan. The ledger reads `at` with six
 * digits (tail 0), so in production this is an exact µs comparison; the tail
 * only matters for lower-precision inputs, and treats them all alike.
 */
export function latestPossibleMicros(v: Date | string): bigint {
  const i = parseInstant(v);
  return i.micros + i.unknownTail;
}

const pad = (n: bigint, w: number): string => n.toString().padStart(w, '0');

/** ISO-8601 UTC at the precision the value carries (3 digits minimum, like toISOString). */
const iso = (d: Date | string): string => {
  if (d instanceof Date) return d.toISOString();
  const { micros, unknownTail } = parseInstant(d);
  const fracMicros = ((micros % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const secs = (micros - fracMicros) / 1000n;
  const carried = 6 - (unknownTail === 0n ? 0 : unknownTail.toString().length);
  const digits = Math.max(3, carried);
  return `${new Date(Number(secs)).toISOString().slice(0, 19)}.${pad(fracMicros, 6).slice(0, digits)}Z`;
};
const recIso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

/** Ids are bigserial read as text: compare NUMERICALLY ("9" < "10"), never as text. */
export function compareLedgerIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function allowedIn(plan: unknown, list: string): string[] {
  const lists = (plan as { plan?: Record<string, { activity_sequence?: unknown }> } | null)?.plan ?? {};
  const seq = lists[list]?.activity_sequence;
  return Array.isArray(seq) ? seq.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * The verified new plan an event carries, or null. Verified = `detail.new_plan`
 * parses as a pin-shaped plan AND planPinSha256(new_plan) === new_plan_sha.
 * Shared with the plan-event webhook so the write side and the read side can
 * never disagree on what "verified" means.
 */
export function verifiedNewPlan(ev: Pick<PlanEventRow, 'new_plan_sha' | 'detail'>): unknown | null {
  const newPlan = (ev.detail as Record<string, unknown> | null | undefined)?.new_plan;
  if (newPlan === undefined || newPlan === null) return null;
  if (typeof ev.new_plan_sha !== 'string') return null;
  if (!PlanPinSchema.safeParse(newPlan).success) return null;
  return planPinSha256(newPlan) === ev.new_plan_sha ? newPlan : null;
}

interface Segment {
  /** recorded_at (µs) of the event that opened it; null for the pin. */
  from: bigint | null;
  plan: unknown;
  sha: string;
  eventId: string | null;
}

function byRecorded<T extends { key: bigint; id: string }>(a: T, b: T): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : compareLedgerIds(a.id, b.id);
}

export function computePlanConformance(input: {
  pin: PlanPinRow | null;
  events: readonly PlanEventRow[];
  executed: readonly ExecutedActivityRow[];
  excusingPlanEvents?: ExcusingPlanEvents;
  excuseListRules?: ExcuseListRules;
}): PlanConformance {
  const table = input.excusingPlanEvents ?? EXCUSING_PLAN_EVENTS;
  const listRules = input.excuseListRules ?? EXCUSE_LIST_RULES;
  const admitted = (ev: PlanEventRow): boolean => planEventCanExcuse(ev, table);
  const events = input.events
    .map((ev) => ({ ev, id: ev.id, key: recordedMicros(ev.recorded_at) }))
    .sort(byRecorded);
  const acts = input.executed
    .map((e) => ({ e, id: e.id, key: recordedMicros(e.recorded_at) }))
    .sort(byRecorded);
  const verified = new Map<string, unknown>();
  for (const { ev } of events) {
    const p = verifiedNewPlan(ev);
    if (p !== null) verified.set(ev.id, p);
  }
  const valid = new Set<string>();
  const invalid = new Map<string, EventDeviationReason>();
  const excusedIds = new Map<string, string[]>();
  const eventsOut = (): PlanConformance['excused_by_events'] =>
    events.map(({ ev }) => ({
      ...ev,
      at: iso(ev.at),
      recorded_at: recIso(ev.recorded_at),
      excuses: valid.has(ev.id),
      invalid_reason: invalid.get(ev.id) ?? null,
      new_plan_verified: verified.has(ev.id),
      excused_executed_ids: excusedIds.get(ev.id) ?? [],
    }));

  if (!input.pin) {
    return {
      status: 'unproven',
      unproven_reason: 'no_pin',
      pinned: null,
      executed: acts.map(({ e }) => ({
        ...e,
        at: iso(e.at),
        recorded_at: recIso(e.recorded_at),
        in_plan: false,
        judged_against_sha: null,
        judged_against_event_id: null,
      })),
      deviations: [],
      excused_by_events: eventsOut(),
    };
  }

  const pin = input.pin;
  const pinKey = recordedMicros(pin.created_at);
  const deviations: Array<{ key: bigint; d: Deviation }> = [];

  // The effective-plan timeline, walked in recorded_at order: the pin, then
  // each VALID re-plan replaces it. `current` is the plan in force at the
  // event's recorded_at, which is what its prev_plan_sha must name.
  const segments: Segment[] = [{ from: null, plan: pin.plan, sha: pin.plan_sha256, eventId: null }];
  for (const { ev, key } of events) {
    const current = segments[segments.length - 1]!;
    const refuse = (reason: EventDeviationReason): void => {
      invalid.set(ev.id, reason);
      deviations.push({
        key,
        d: {
          reason,
          executed_id: null,
          event_id: ev.id,
          list: ev.list,
          pattern: null,
          activity: null,
          execution_id: ev.actor_execution_id,
          at: iso(ev.at),
          recorded_at: recIso(ev.recorded_at),
          allowed: [],
          judged_against_sha: current.sha,
        },
      });
    };
    if (key < pinKey) {
      refuse('event_before_pin');
      continue;
    }
    if (!admitted(ev)) continue;
    const plan = verified.get(ev.id);
    if (plan === undefined) {
      refuse('excuse_without_verifiable_plan');
      continue;
    }
    if (ev.prev_plan_sha !== current.sha) {
      refuse('excuse_prev_plan_mismatch');
      continue;
    }
    const prior = {
      atOrBefore: new Set(acts.filter((a) => a.key <= key).map((a) => a.e.list)),
      before: new Set(acts.filter((a) => a.key < key).map((a) => a.e.list)),
    };
    if (!excuseListConsistent(ev.list, prior, listRules)) {
      refuse('excuse_list_inconsistent');
      continue;
    }
    valid.add(ev.id);
    segments.push({ from: key, plan, sha: ev.new_plan_sha as string, eventId: ev.id });
  }
  // The segment governing an activity: the last one opened STRICTLY before it.
  const segmentAt = (t: bigint): { seg: Segment; prev: Segment | null } => {
    let i = 0;
    for (let k = 1; k < segments.length; k += 1) if ((segments[k]!.from as bigint) < t) i = k;
    return { seg: segments[i]!, prev: i > 0 ? segments[i - 1]! : null };
  };

  // Valid re-plans in recorded order, for the late-recorded check.
  const replans = segments.slice(1);

  const executed: PlanConformance['executed'] = [];
  for (const { e, key } of acts) {
    const { seg, prev } = segmentAt(key);
    const allowed = allowedIn(seg.plan, e.list);
    const inPlan = allowed.includes(e.activity);
    // Claimed to have run before a re-plan, recorded after it. Tie rule:
    // latestPossibleMicros (flag only if every reading of `at` precedes the
    // re-plan). An honest `at` stamped by the same now() as its recorded_at is
    // never flagged, whatever shape it arrives in.
    const atLatest = latestPossibleMicros(e.at);
    const straddled = replans.find((r) => atLatest < (r.from as bigint) && (r.from as bigint) < key);
    if (straddled) {
      deviations.push({
        key,
        d: {
          reason: 'activity_recorded_after_excuse',
          executed_id: e.id,
          event_id: straddled.eventId,
          list: e.list,
          pattern: e.pattern,
          activity: e.activity,
          execution_id: e.execution_id,
          at: iso(e.at),
          recorded_at: recIso(e.recorded_at),
          allowed,
          judged_against_sha: seg.sha,
        },
      });
    }
    executed.push({
      ...e,
      at: iso(e.at),
      recorded_at: recIso(e.recorded_at),
      in_plan: inPlan,
      judged_against_sha: seg.sha,
      judged_against_event_id: seg.eventId,
    });
    if (inPlan) {
      if (seg.eventId && prev && !allowedIn(prev.plan, e.list).includes(e.activity)) {
        const ids = excusedIds.get(seg.eventId) ?? [];
        ids.push(e.id);
        excusedIds.set(seg.eventId, ids);
      }
      continue;
    }
    deviations.push({
      key,
      d: {
        reason: 'not_in_effective_plan',
        executed_id: e.id,
        event_id: null,
        list: e.list,
        pattern: e.pattern,
        activity: e.activity,
        execution_id: e.execution_id,
        at: iso(e.at),
        recorded_at: recIso(e.recorded_at),
        allowed,
        judged_against_sha: seg.sha,
      },
    });
  }
  // Stable: equal instants keep event-then-activity insertion order.
  deviations.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const status: ConformanceStatus =
    deviations.length > 0 ? 'deviates' : acts.length === 0 ? 'unproven' : 'conforms';
  return {
    status,
    unproven_reason: status === 'unproven' ? 'no_executed_activities' : null,
    pinned: { plan_sha256: pin.plan_sha256, plan: pin.plan, created_at: iso(pin.created_at) },
    executed,
    deviations: deviations.map((x) => x.d),
    excused_by_events: eventsOut(),
  };
}
