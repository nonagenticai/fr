// U11 / D2 — the pure plan-conformance read model and the pin preparation.
//
// The DB-backed behaviour (pin at mint, insert-once, UPDATE/DELETE refused by
// the trigger, cross-tenant 404, the webhooks, the thin conformance route) was
// proved against a real Postgres by the plan-pinning integration suite, deleted
// 2026-10-29 — no longer in the suite. This file
// pins the RULES, which need no database.

import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  EXCUSE_LIST_RULES,
  EXCUSING_PLAN_EVENTS,
  compareLedgerIds,
  computePlanConformance,
  planEventCanExcuse,
  latestPossibleMicros,
  parseInstant,
  recordedMicros,
} from '../../../src/services/improvement-cards/plan-conformance';
import {
  PLAN_PIN_MAX_BYTES,
  buildPlanPinPointer,
  planPinSha256,
  preparePlanPin,
  type ExecutedActivityRow,
  type PlanEventRow,
  type PlanPinRow,
} from '../../../src/services/improvement-cards/plan-pin';

const PLAN = {
  rule_version: 1,
  card_type: 'development_bug_fix',
  plan: {
    doing: { activity_sequence: ['p.doing.prefetch', 'p.doing.execute', 'p.doing.persist'] },
    qa: { activity_sequence: ['p.qa.lint', 'p.qa.tests'] },
  },
};

const pin: PlanPinRow = {
  card_id: 'c1',
  tenant_id: '00000000-0000-4000-8000-000000000001',
  plan: PLAN as PlanPinRow['plan'],
  plan_sha256: planPinSha256(PLAN),
  created_at: new Date('2026-10-01T10:00:00Z'),
};

let n = 0;
/** `recorded` is the server clock; it defaults to the caller's `at` (the honest case). */
function act(list: string, activity: string, at: string, recorded: string = at): ExecutedActivityRow {
  n += 1;
  return {
    id: `a${n}`,
    card_id: 'c1',
    list,
    pattern: `pattern.${list}`,
    activity,
    execution_id: `ex${n}`,
    at: new Date(at),
    recorded_at: recorded,
    trace_id: null,
  };
}
type Replan = { new_plan?: unknown; new_plan_sha?: string | null; prev_plan_sha?: string | null; recorded?: string };
function ev(
  computed_by: 'rule' | 'llm',
  at: string,
  id = `e-${computed_by}-${at}`,
  kind: PlanEventRow['kind'] = 'reclassify',
  list: PlanEventRow['list'] = 'qa',
  replan: Replan = {},
): PlanEventRow {
  return {
    id,
    card_id: 'c1',
    kind,
    computed_by,
    list,
    actor_execution_id: null,
    prev_plan_sha: replan.prev_plan_sha ?? null,
    new_plan_sha: replan.new_plan_sha ?? null,
    detail: replan.new_plan === undefined ? {} : { new_plan: replan.new_plan },
    at: new Date(at),
    recorded_at: replan.recorded ?? at,
    trace_id: null,
  };
}

/**
 * The plan a split re-plans to. It ADDS p.doing.llm_judge and DROPS
 * p.doing.execute, so a "replace" and a "union" read differently.
 */
const NEW_PLAN = {
  rule_version: 1,
  card_type: 'development_bug_fix',
  plan: {
    doing: { activity_sequence: ['p.doing.prefetch', 'p.doing.llm_judge'] },
    qa: { activity_sequence: ['p.qa.lint', 'p.qa.tests'] },
  },
};
const NEW_PLAN_SHA = planPinSha256(NEW_PLAN);
/** A valid re-plan away from the PIN: verified plan + prev_plan_sha = the pin's sha. */
const VERIFIED = { new_plan: NEW_PLAN, new_plan_sha: NEW_PLAN_SHA, prev_plan_sha: planPinSha256(PLAN) };

const IN_PLAN = [
  act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z'),
  act('doing', 'p.doing.execute', '2026-10-01T10:02:00Z'),
  act('qa', 'p.qa.tests', '2026-10-01T10:03:00Z'),
];
const OUT_OF_PLAN = act('doing', 'p.doing.llm_judge', '2026-10-01T10:05:00Z');

describe('computePlanConformance', () => {
  it('EXCUSING_PLAN_EVENTS is the ruling (10-01 movies-ab): rule split@ready/qa/blocked, rule reclassify@qa/blocked, llm nothing; frozen', () => {
    expect(JSON.parse(JSON.stringify(EXCUSING_PLAN_EVENTS))).toEqual({
      rule: { split: ['ready', 'qa', 'blocked'], reclassify: ['qa', 'blocked'] },
      llm: { split: [], reclassify: [] },
    });
    expect(JSON.parse(JSON.stringify(EXCUSE_LIST_RULES))).toEqual({
      ready: { forbid_prior_activity_in: ['doing', 'qa', 'done'], require_prior_activity_in: [] },
      qa: { forbid_prior_activity_in: [], require_prior_activity_in: ['doing'] },
      blocked: { forbid_prior_activity_in: [], require_prior_activity_in: ['doing'] },
    });
    expect(Object.isFrozen(EXCUSE_LIST_RULES.ready)).toBe(true);
    expect(Object.isFrozen(EXCUSING_PLAN_EVENTS)).toBe(true);
    expect(Object.isFrozen(EXCUSING_PLAN_EVENTS.rule)).toBe(true);
    expect(Object.isFrozen(EXCUSING_PLAN_EVENTS.rule.split)).toBe(true);
  });

  it('no pin ⇒ unproven, never a pass — even with executed rows', () => {
    const r = computePlanConformance({ pin: null, events: [], executed: IN_PLAN });
    expect(r.status).toBe('unproven');
    expect(r.pinned).toBeNull();
    expect(r.deviations).toEqual([]);
    expect(r.executed).toHaveLength(3);
  });

  it('an in-plan sequence conforms', () => {
    const r = computePlanConformance({ pin, events: [], executed: IN_PLAN });
    expect(r.status).toBe('conforms');
    expect(r.deviations).toEqual([]);
    expect(r.executed.every((e) => e.in_plan)).toBe(true);
    expect(r.pinned?.plan_sha256).toBe(pin.plan_sha256);
  });

  it('an out-of-plan activity deviates, naming what the pin allowed for that list', () => {
    const r = computePlanConformance({ pin, events: [], executed: [...IN_PLAN, OUT_OF_PLAN] });
    expect(r.status).toBe('deviates');
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0]!.activity).toBe('p.doing.llm_judge');
    expect(r.deviations[0]!.allowed).toEqual(PLAN.plan.doing.activity_sequence);
    expect(r.deviations[0]!.reason).toBe('not_in_effective_plan');
    expect(r.deviations[0]!.judged_against_sha).toBe(pin.plan_sha256);
  });

  it('an activity in a list the pin does not name deviates (empty allowed set)', () => {
    const r = computePlanConformance({ pin, events: [], executed: [act('done', 'p.qa.tests', '2026-10-01T10:04:00Z')] });
    expect(r.status).toBe('deviates');
    expect(r.deviations[0]!.allowed).toEqual([]);
  });

  it('a RULE event recorded strictly before the activity re-plans to its VERIFIED new plan ⇒ conforms', () => {
    const rule = ev('rule', '2026-10-01T10:04:00Z', undefined, undefined, undefined, VERIFIED);
    const r = computePlanConformance({ pin, events: [rule], executed: [...IN_PLAN, OUT_OF_PLAN] });
    expect(r.status).toBe('conforms');
    expect(r.deviations).toEqual([]);
    const judged = r.executed.find((e) => e.id === OUT_OF_PLAN.id)!;
    expect(judged.in_plan).toBe(true);
    expect(judged.judged_against_event_id).toBe(rule.id);
    expect(judged.judged_against_sha).toBe(NEW_PLAN_SHA);
    expect(r.excused_by_events[0]!.excuses).toBe(true);
    expect(r.excused_by_events[0]!.new_plan_verified).toBe(true);
    expect(r.excused_by_events[0]!.excused_executed_ids).toEqual([OUT_OF_PLAN.id]);
  });

  it('an LLM event does NOT excuse — even carrying a verified plan; it is listed, with excuses:false', () => {
    const llm = ev('llm', '2026-10-01T10:04:00Z', undefined, undefined, undefined, VERIFIED);
    const r = computePlanConformance({ pin, events: [llm], executed: [...IN_PLAN, OUT_OF_PLAN] });
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => [d.reason, d.activity])).toEqual([['not_in_effective_plan', 'p.doing.llm_judge']]);
    expect(r.excused_by_events).toHaveLength(1);
    expect(r.excused_by_events[0]!.excuses).toBe(false);
  });

  it('a RULE event recorded AFTER the deviation cannot retro-excuse it', () => {
    const late = ev('rule', '2026-10-01T10:06:00Z', undefined, undefined, undefined, VERIFIED);
    const r = computePlanConformance({ pin, events: [late], executed: [...IN_PLAN, OUT_OF_PLAN] });
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => d.executed_id)).toEqual([OUT_OF_PLAN.id]);
    expect(r.deviations[0]!.judged_against_sha).toBe(pin.plan_sha256);
  });

  it('the excusing table is a parameter, so a ruling flip is data, not logic (control)', () => {
    const llm = ev('llm', '2026-10-01T10:04:00Z', undefined, undefined, undefined, VERIFIED);
    const r = computePlanConformance({
      pin,
      events: [llm],
      executed: [...IN_PLAN, OUT_OF_PLAN],
      excusingPlanEvents: { ...EXCUSING_PLAN_EVENTS, llm: { split: [], reclassify: ['qa'] } },
    });
    expect(r.status).toBe('conforms');
  });
});

// The validator's two false-pass routes (U11 fix): a vacuous pass on zero
// observations, and one excuse covering every later deviation wholesale.
describe('no vacuous pass, no wholesale excuse', () => {
  // A QA split: IN_PLAN recorded doing work before it, so the declared list is
  // consistent with the log (a READY split after doing work would not be).
  const SPLIT_AT = '2026-10-01T10:04:00Z';
  const split = (replan: Replan = VERIFIED) => ev('rule', SPLIT_AT, 'e-split-qa', 'split', 'qa', replan);

  it('a pin with ZERO executed activities ⇒ unproven (no_executed_activities), never conforms', () => {
    const r = computePlanConformance({ pin, events: [], executed: [] });
    expect(r.status).toBe('unproven');
    expect(r.unproven_reason).toBe('no_executed_activities');
    expect(r.deviations).toEqual([]);
    expect(r.pinned?.plan_sha256).toBe(pin.plan_sha256);
    // Control: one in-plan activity and the same pin conforms.
    const c = computePlanConformance({ pin, events: [], executed: [IN_PLAN[0]!] });
    expect([c.status, c.unproven_reason]).toEqual(['conforms', null]);
  });

  it('no pin ⇒ unproven with reason no_pin', () => {
    expect(computePlanConformance({ pin: null, events: [], executed: [] }).unproven_reason).toBe('no_pin');
  });

  it('rule split at qa with a verified new plan, then an activity INSIDE the new plan ⇒ conforms', () => {
    const after = act('doing', 'p.doing.llm_judge', '2026-10-01T10:05:00Z');
    const r = computePlanConformance({ pin, events: [split()], executed: [...IN_PLAN, after] });
    expect(r.status).toBe('conforms');
    expect(r.deviations).toEqual([]);
    // Activities BEFORE the split were judged against the pin.
    expect(r.executed.filter((e) => e.id !== after.id).every((e) => e.judged_against_event_id === null)).toBe(true);
    expect(r.executed.find((e) => e.id === after.id)!.judged_against_event_id).toBe('e-split-qa');
  });

  it('the same split, then an activity OUTSIDE the new plan ⇒ deviates — even one the PIN allowed (replace, not union)', () => {
    const offBoth = act('doing', 'p.doing.off_plan', '2026-10-01T10:05:00Z');
    const pinOnly = act('doing', 'p.doing.execute', '2026-10-01T10:06:00Z');
    const r = computePlanConformance({ pin, events: [split()], executed: [...IN_PLAN, offBoth, pinOnly] });
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => [d.reason, d.activity, d.judged_against_sha])).toEqual([
      ['not_in_effective_plan', 'p.doing.off_plan', NEW_PLAN_SHA],
      ['not_in_effective_plan', 'p.doing.execute', NEW_PLAN_SHA],
    ]);
    expect(r.deviations[0]!.allowed).toEqual(NEW_PLAN.plan.doing.activity_sequence);
    // The same p.doing.execute BEFORE the split was in plan (the pin's).
    expect(r.executed.find((e) => e.id === IN_PLAN[1]!.id)!.in_plan).toBe(true);
  });

  it('an excusing event WITHOUT a plan excuses nothing and is itself a deviation excuse_without_verifiable_plan', () => {
    const r = computePlanConformance({ pin, events: [split({})], executed: [...IN_PLAN, OUT_OF_PLAN] });
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => [d.reason, d.event_id, d.executed_id])).toEqual([
      ['excuse_without_verifiable_plan', 'e-split-qa', null],
      ['not_in_effective_plan', null, OUT_OF_PLAN.id],
    ]);
    expect(r.excused_by_events[0]!.excuses).toBe(false);
    expect(r.excused_by_events[0]!.new_plan_verified).toBe(false);
  });

  it('an excusing event whose plan does not hash to new_plan_sha (or is malformed) is the same deviation', () => {
    for (const replan of [
      { new_plan: NEW_PLAN, new_plan_sha: 'f'.repeat(64) },
      { new_plan: NEW_PLAN, new_plan_sha: null },
      { new_plan_sha: NEW_PLAN_SHA },
      { new_plan: { plan: { doing: { activity_sequence: 'x' } } }, new_plan_sha: planPinSha256({ plan: { doing: { activity_sequence: 'x' } } }) },
    ]) {
      const r = computePlanConformance({ pin, events: [split(replan)], executed: [...IN_PLAN] });
      expect([r.status, r.deviations.map((d) => d.reason)]).toEqual(['deviates', ['excuse_without_verifiable_plan']]);
    }
  });

  it('a NON-excusing event without a plan is not a deviation (only listed)', () => {
    const doingSplit = ev('rule', SPLIT_AT, 'e-doing', 'split', 'doing');
    const r = computePlanConformance({ pin, events: [doingSplit], executed: [...IN_PLAN] });
    expect(r.status).toBe('conforms');
    expect(r.excused_by_events[0]!.excuses).toBe(false);
  });

  it('two re-plans chain: each activity is judged against the plan in force at its own time', () => {
    const PLAN3 = { plan: { doing: { activity_sequence: ['p.doing.third'] } } };
    const second = ev('rule', '2026-10-01T10:10:00Z', 'e-qa2', 'split', 'qa', {
      new_plan: PLAN3,
      new_plan_sha: planPinSha256(PLAN3),
      prev_plan_sha: NEW_PLAN_SHA, // the plan in force: the FIRST re-plan, not the pin
    });
    const a1 = act('doing', 'p.doing.llm_judge', '2026-10-01T10:05:00Z'); // plan 2: ok
    const a2 = act('doing', 'p.doing.llm_judge', '2026-10-01T10:11:00Z'); // plan 3: deviates
    const a3 = act('doing', 'p.doing.third', '2026-10-01T10:12:00Z'); // plan 3: ok
    const r = computePlanConformance({ pin, events: [second, split()], executed: [...IN_PLAN, a1, a2, a3] });
    expect(r.deviations.map((d) => d.executed_id)).toEqual([a2.id]);
    expect(r.excused_by_events.map((e) => [e.id, e.excused_executed_ids])).toEqual([
      ['e-split-qa', [a1.id]],
      ['e-qa2', [a3.id]],
    ]);
  });
});

// RULING 10-01 (movies-ab): the sequence changes ONLY at Readying (split) and at
// QA/BLOCKED (split or reclassify); DOING never splits. The list keys are the
// plan's own: ncn card_type_descriptions.json + workflows/cells/<list>.json.
describe('which plan events excuse a deviation (list × kind × computed_by)', () => {
  const AT = '2026-10-01T10:04:00Z';
  function verdict(computed_by: 'rule' | 'llm', kind: PlanEventRow['kind'], list: PlanEventRow['list']) {
    // Every event carries a VERIFIED plan that would allow the deviation, so only
    // the (computed_by, kind, list) ruling decides the verdict.
    const e = ev(computed_by, AT, `e-${computed_by}-${kind}-${list}`, kind, list, VERIFIED);
    // The log is made consistent with the declared list so ONLY the ruling
    // decides: no prior activity for `ready`, prior doing work otherwise.
    const prior = list === 'ready' ? [] : [IN_PLAN[0]!];
    const r = computePlanConformance({ pin, events: [e], executed: [...prior, OUT_OF_PLAN] });
    return { r, e };
  }

  it('a RULE split at Readying (ready) ⇒ excused', () => {
    const { r, e } = verdict('rule', 'split', 'ready');
    expect(r.status).toBe('conforms');
    expect(r.excused_by_events[0]!.excused_executed_ids).toEqual([OUT_OF_PLAN.id]);
    expect(r.excused_by_events[0]!.id).toBe(e.id);
    expect(r.excused_by_events[0]!.excuses).toBe(true);
  });

  it('a RULE split at DOING ⇒ UNEXCUSED (DOING never splits), still listed', () => {
    const { r } = verdict('rule', 'split', 'doing');
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => d.executed_id)).toEqual([OUT_OF_PLAN.id]);
    expect(r.excused_by_events).toHaveLength(1);
    expect(r.excused_by_events[0]!.excuses).toBe(false);
  });

  it('a RULE reclassify at qa ⇒ excused', () => {
    const { r, e } = verdict('rule', 'reclassify', 'qa');
    expect(r.status).toBe('conforms');
    expect(r.executed.find((x) => x.id === OUT_OF_PLAN.id)!.judged_against_event_id).toBe(e.id);
  });

  it('a RULE reclassify at Readying (ready) ⇒ UNEXCUSED', () => {
    const { r } = verdict('rule', 'reclassify', 'ready');
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => d.executed_id)).toEqual([OUT_OF_PLAN.id]);
    expect(r.excused_by_events[0]!.excuses).toBe(false);
  });

  it('an LLM split at Readying (ready) ⇒ UNEXCUSED', () => {
    const { r } = verdict('llm', 'split', 'ready');
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => d.executed_id)).toEqual([OUT_OF_PLAN.id]);
    expect(r.excused_by_events[0]!.excuses).toBe(false);
  });

  it('the full grid matches the ruling, cell by cell', () => {
    const lists = ['todo', 'ready', 'doing', 'qa', 'blocked', 'done'] as const;
    const expected = new Set(['rule/split/ready', 'rule/split/qa', 'rule/split/blocked', 'rule/reclassify/qa', 'rule/reclassify/blocked']);
    for (const computed_by of ['rule', 'llm'] as const) {
      for (const kind of ['split', 'reclassify'] as const) {
        for (const list of lists) {
          expect([`${computed_by}/${kind}/${list}`, planEventCanExcuse({ computed_by, kind, list })]).toEqual([
            `${computed_by}/${kind}/${list}`,
            expected.has(`${computed_by}/${kind}/${list}`),
          ]);
        }
      }
    }
  });
});

// The validator's second round (U11 fix 2): four more false-pass routes.
//   1. a caller-supplied `at` placed the re-plan (backdating);
//   2. prev_plan_sha was never checked;
//   3. the declared list was never checked against the log;
//   4. SQL ordered ids as TEXT ("10" < "9").
describe('one server clock, a checked prev_plan_sha, a list consistent with the log, numeric order', () => {
  const PIN_SHA = planPinSha256(PLAN);
  /** Re-plan allowing qa:[p.qa.x]; doing kept as the pin's. */
  const QA_X = { ...PLAN, plan: { ...PLAN.plan, qa: { activity_sequence: ['p.qa.x'] } } };
  const QA_X_SHA = planPinSha256(QA_X);
  const QA_X_REPLAN = { new_plan: QA_X, new_plan_sha: QA_X_SHA, prev_plan_sha: PIN_SHA };

  it('EXPLOIT 1: a split RECORDED after the activity but claiming an earlier `at` does not excuse it', () => {
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const x = act('qa', 'p.qa.x', '2026-10-01T10:03:00Z'); // T1
    // Posted LATER (recorded 10:09) with at = T0 (10:02) < T1.
    const backdated = ev('rule', '2026-10-01T10:02:00Z', 'e-back', 'split', 'qa', { ...QA_X_REPLAN, recorded: '2026-10-01T10:09:00Z' });
    const r = computePlanConformance({ pin, events: [backdated], executed: [doing, x] });
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => [d.reason, d.executed_id, d.judged_against_sha])).toEqual([
      ['not_in_effective_plan', x.id, PIN_SHA],
    ]);
    // The event IS valid — it just governs nothing recorded before it.
    expect(r.excused_by_events.map((e) => [e.id, e.excuses, e.excused_executed_ids])).toEqual([['e-back', true, []]]);
    // Control: the SAME event recorded honestly at T0 does excuse it.
    const honest = ev('rule', '2026-10-01T10:02:00Z', 'e-honest', 'split', 'qa', QA_X_REPLAN);
    const c = computePlanConformance({ pin, events: [honest], executed: [doing, x] });
    expect([c.status, c.excused_by_events[0]!.excused_executed_ids]).toEqual(['conforms', [x.id]]);
  });

  it('EXPLOIT 1b: an event whose `at` precedes the pin but RECORDED after it does not replace the pin outright', () => {
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const x = act('qa', 'p.qa.x', '2026-10-01T10:03:00Z');
    // at 09:00 < pin.created_at 10:00, recorded 10:09 (after every activity).
    const early = ev('rule', '2026-10-01T09:00:00Z', 'e-early-at', 'split', 'qa', { ...QA_X_REPLAN, recorded: '2026-10-01T10:09:00Z' });
    const r = computePlanConformance({ pin, events: [early], executed: [doing, x] });
    expect(r.status).toBe('deviates');
    expect(r.executed.map((e) => e.judged_against_event_id)).toEqual([null, null]);
    expect(r.deviations.map((d) => [d.reason, d.executed_id])).toEqual([['not_in_effective_plan', x.id]]);
  });

  it('an event RECORDED before the pin re-plans nothing and is a deviation event_before_pin', () => {
    const x = act('qa', 'p.qa.x', '2026-10-01T10:03:00Z');
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T09:58:00Z');
    const pre = ev('rule', '2026-10-01T09:59:00Z', 'e-pre', 'split', 'qa', QA_X_REPLAN); // pin is 10:00
    const r = computePlanConformance({ pin, events: [pre], executed: [doing, x] });
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => [d.reason, d.event_id ?? d.executed_id])).toEqual([
      ['event_before_pin', 'e-pre'],
      ['not_in_effective_plan', x.id],
    ]);
    expect(r.excused_by_events.map((e) => [e.excuses, e.invalid_reason])).toEqual([[false, 'event_before_pin']]);
  });

  it('EXPLOIT 2: prev_plan_sha that is not the plan in force ⇒ excuses nothing, deviation excuse_prev_plan_mismatch', () => {
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const x = act('qa', 'p.qa.x', '2026-10-01T10:05:00Z');
    for (const prev of ['f'.repeat(64), null, QA_X_SHA]) {
      const bad = ev('rule', '2026-10-01T10:02:00Z', 'e-prev', 'split', 'qa', { ...QA_X_REPLAN, prev_plan_sha: prev });
      const r = computePlanConformance({ pin, events: [bad], executed: [doing, x] });
      expect([prev, r.status, r.deviations.map((d) => [d.reason, d.event_id ?? d.executed_id])]).toEqual([
        prev,
        'deviates',
        [
          ['excuse_prev_plan_mismatch', 'e-prev'],
          ['not_in_effective_plan', x.id],
        ],
      ]);
      expect(r.deviations[0]!.judged_against_sha).toBe(PIN_SHA);
    }
  });

  it('EXPLOIT 2b: a second re-plan naming the PIN (not the first re-plan) as prev is a mismatch', () => {
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const first = ev('rule', '2026-10-01T10:02:00Z', 'e-1', 'split', 'qa', VERIFIED); // pin → NEW_PLAN
    const second = ev('rule', '2026-10-01T10:03:00Z', 'e-2', 'split', 'qa', QA_X_REPLAN); // prev = PIN, stale
    const x = act('qa', 'p.qa.x', '2026-10-01T10:04:00Z');
    const r = computePlanConformance({ pin, events: [first, second], executed: [doing, x] });
    expect(r.deviations.map((d) => [d.reason, d.event_id ?? d.executed_id, d.judged_against_sha])).toEqual([
      ['excuse_prev_plan_mismatch', 'e-2', NEW_PLAN_SHA],
      ['not_in_effective_plan', x.id, NEW_PLAN_SHA],
    ]);
  });

  it('EXPLOIT 3: a READY split recorded after a DOING activity is a DOING split in disguise ⇒ excuse_list_inconsistent', () => {
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const after = act('doing', 'p.doing.llm_judge', '2026-10-01T10:05:00Z');
    const ready = ev('rule', '2026-10-01T10:02:00Z', 'e-ready', 'split', 'ready', VERIFIED);
    const r = computePlanConformance({ pin, events: [ready], executed: [doing, after] });
    expect(r.status).toBe('deviates');
    expect(r.deviations.map((d) => [d.reason, d.event_id ?? d.executed_id])).toEqual([
      ['excuse_list_inconsistent', 'e-ready'],
      ['not_in_effective_plan', after.id],
    ]);
    expect(r.excused_by_events[0]!.invalid_reason).toBe('excuse_list_inconsistent');
    // qa and done activity before it are just as disqualifying.
    for (const list of ['qa', 'done']) {
      const prior = act(list, 'p.qa.tests', '2026-10-01T10:01:00Z');
      const q = computePlanConformance({ pin, events: [ready], executed: [prior] });
      expect([list, q.excused_by_events[0]!.invalid_reason]).toEqual([list, 'excuse_list_inconsistent']);
    }
    // Control: the same READY split with NO prior activity is valid.
    const c = computePlanConformance({ pin, events: [ready], executed: [after] });
    expect([c.status, c.excused_by_events[0]!.excuses]).toEqual(['conforms', true]);
  });

  it('EXPLOIT 3b: a QA (or BLOCKED) split with no doing activity recorded before it ⇒ excuse_list_inconsistent', () => {
    for (const list of ['qa', 'blocked'] as const) {
      const x = act('qa', 'p.qa.x', '2026-10-01T10:05:00Z');
      // A doing activity AFTER the split does not count as "before".
      const laterDoing = act('doing', 'p.doing.prefetch', '2026-10-01T10:06:00Z');
      const split = ev('rule', '2026-10-01T10:02:00Z', `e-${list}`, 'split', list, QA_X_REPLAN);
      const r = computePlanConformance({ pin, events: [split], executed: [x, laterDoing] });
      expect([list, r.status, r.deviations.map((d) => [d.reason, d.event_id ?? d.executed_id])]).toEqual([
        list,
        'deviates',
        [
          [`excuse_list_inconsistent`, `e-${list}`],
          ['not_in_effective_plan', x.id],
        ],
      ]);
      // Control: one doing activity recorded before it makes it valid.
      const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
      const c = computePlanConformance({ pin, events: [split], executed: [doing, x] });
      expect([list, c.status]).toEqual([list, 'conforms']);
    }
  });

  it('an activity recorded at the SAME instant as the event is not governed by it (strictly later only)', () => {
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const x = act('qa', 'p.qa.x', '2026-10-01T10:02:00.000001Z');
    const split = ev('rule', '2026-10-01T10:02:00Z', 'e-same', 'split', 'qa', { ...QA_X_REPLAN, recorded: '2026-10-01T10:02:00.000001Z' });
    const r = computePlanConformance({ pin, events: [split], executed: [doing, x] });
    expect(r.deviations.map((d) => d.executed_id)).toEqual([x.id]);
    // One microsecond later IS governed: postgres precision is kept, not truncated to ms.
    const x2 = act('qa', 'p.qa.x', '2026-10-01T10:02:00.000002Z');
    expect(computePlanConformance({ pin, events: [split], executed: [doing, x2] }).status).toBe('conforms');
  });

  it('SAME INSTANT, forbid side: a doing activity recorded at the READY split\'s exact recorded_at disqualifies it (<=)', () => {
    const T = '2026-10-01T10:02:00.000001Z';
    const tie = act('doing', 'p.doing.prefetch', '2026-10-01T10:02:00Z', T);
    const after = act('doing', 'p.doing.llm_judge', '2026-10-01T10:05:00Z');
    const ready = ev('rule', '2026-10-01T10:02:00Z', 'e-ready-tie', 'split', 'ready', { ...VERIFIED, recorded: T });
    const r = computePlanConformance({ pin, events: [ready], executed: [tie, after] });
    expect(r.status).toBe('deviates');
    expect(r.excused_by_events.map((e) => [e.id, e.excuses, e.invalid_reason])).toEqual([
      ['e-ready-tie', false, 'excuse_list_inconsistent'],
    ]);
    expect(r.deviations.map((d) => [d.reason, d.event_id ?? d.executed_id])).toEqual([
      ['excuse_list_inconsistent', 'e-ready-tie'],
      ['not_in_effective_plan', after.id],
    ]);
    // Control: the same doing activity ONE microsecond later does not disqualify it.
    const later = act('doing', 'p.doing.prefetch', '2026-10-01T10:02:00Z', '2026-10-01T10:02:00.000002Z');
    const c = computePlanConformance({ pin, events: [ready], executed: [later, after] });
    expect([c.status, c.excused_by_events[0]!.excuses]).toEqual(['conforms', true]);
  });

  it('SAME INSTANT, require side: a doing activity at the QA split\'s exact recorded_at does NOT satisfy it (<)', () => {
    const T = '2026-10-01T10:02:00.000001Z';
    const tie = act('doing', 'p.doing.prefetch', '2026-10-01T10:02:00Z', T);
    const x = act('qa', 'p.qa.x', '2026-10-01T10:05:00Z');
    const split = ev('rule', '2026-10-01T10:02:00Z', 'e-qa-tie', 'split', 'qa', { ...QA_X_REPLAN, recorded: T });
    const r = computePlanConformance({ pin, events: [split], executed: [tie, x] });
    expect(r.excused_by_events.map((e) => [e.excuses, e.invalid_reason])).toEqual([[false, 'excuse_list_inconsistent']]);
    // Control: one microsecond earlier satisfies it.
    const before = act('doing', 'p.doing.prefetch', '2026-10-01T10:02:00Z', '2026-10-01T10:02:00Z');
    const c = computePlanConformance({ pin, events: [split], executed: [before, x] });
    expect([c.status, c.excused_by_events[0]!.excuses]).toEqual(['conforms', true]);
  });

  it('LATE-RECORDED: an activity claiming `at` before a re-plan but RECORDED after it ⇒ activity_recorded_after_excuse', () => {
    // "Run X, post the re-plan, then post X": X ran at 10:03 under the pin (which
    // forbids it), the split is recorded 10:04, X is posted 10:06 so it lands
    // inside the new plan.
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const split = ev('rule', '2026-10-01T10:04:00Z', 'e-cover', 'split', 'qa', QA_X_REPLAN);
    const x = act('qa', 'p.qa.x', '2026-10-01T10:03:00Z', '2026-10-01T10:06:00Z');
    const r = computePlanConformance({ pin, events: [split], executed: [doing, x] });
    expect(r.status).toBe('deviates');
    expect(r.executed.find((e) => e.id === x.id)!.in_plan).toBe(true); // the cover would have worked
    expect(r.deviations.map((d) => [d.reason, d.executed_id, d.event_id])).toEqual([
      ['activity_recorded_after_excuse', x.id, 'e-cover'],
    ]);
    // Control: the same X with an honest `at` after the split conforms.
    const honest = act('qa', 'p.qa.x', '2026-10-01T10:05:00Z', '2026-10-01T10:06:00Z');
    expect(computePlanConformance({ pin, events: [split], executed: [doing, honest] }).status).toBe('conforms');
    // Control: an INVALID event (llm) re-plans nothing, so nothing is straddled.
    const llm = ev('llm', '2026-10-01T10:04:00Z', 'e-llm', 'split', 'qa', QA_X_REPLAN);
    const l = computePlanConformance({ pin, events: [llm], executed: [doing, x] });
    expect(l.deviations.map((d) => d.reason)).toEqual(['not_in_effective_plan']);
  });

  it('EXPLOIT 4: ids order NUMERICALLY at equal recorded_at — eleven events, "10" after "9"', () => {
    const doing = act('doing', 'p.doing.prefetch', '2026-10-01T10:01:00Z');
    const T = '2026-10-01T10:02:00Z';
    const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
    const shuffled = [...ids].sort(); // text order: 1,10,11,2,…
    expect(shuffled.slice(0, 3)).toEqual(['1', '10', '11']);
    const events = shuffled.map((id) => ev('llm', T, id, 'split', 'qa'));
    const r = computePlanConformance({ pin, events, executed: [doing] });
    expect(r.excused_by_events.map((e) => e.id)).toEqual(ids);
    // And it MATTERS: a chain at one instant only validates in numeric order.
    // Event 9 re-plans pin → NEW_PLAN; event 10 re-plans NEW_PLAN → QA_X.
    const QA_X2 = { ...NEW_PLAN, plan: { ...NEW_PLAN.plan, qa: { activity_sequence: ['p.qa.x'] } } };
    const nine = ev('rule', T, '9', 'split', 'qa', VERIFIED);
    const ten = ev('rule', T, '10', 'split', 'qa', { new_plan: QA_X2, new_plan_sha: planPinSha256(QA_X2), prev_plan_sha: NEW_PLAN_SHA });
    const x = act('qa', 'p.qa.x', '2026-10-01T10:03:00Z');
    const chain = computePlanConformance({ pin, events: [ten, nine], executed: [doing, x] });
    expect([chain.status, chain.excused_by_events.map((e) => [e.id, e.excuses])]).toEqual([
      'conforms',
      [
        ['9', true],
        ['10', true],
      ],
    ]);
    expect(compareLedgerIds('9', '10')).toBeLessThan(0);
    expect(compareLedgerIds('100000000000000000001', '99999999999999999999')).toBeGreaterThan(0);
  });

  it('recordedMicros keeps microseconds and agrees with Date at ms precision', () => {
    expect(recordedMicros('2026-10-01T10:02:00.000001Z') - recordedMicros('2026-10-01T10:02:00Z')).toBe(1n);
    expect(recordedMicros('2026-10-01T10:02:00.5Z')).toBe(recordedMicros(new Date('2026-10-01T10:02:00.500Z')));
  });

  it('SAME MILLISECOND: an activity recorded after a re-plan in the same ms is never activity_recorded_after_excuse, whatever shape `at` has', () => {
    // The integration flake (fr 85597dfc, 3 of 6): re-plan recorded .592134,
    // activity recorded .592634 with an honest `at` = its own now(). postgres.js
    // handed `at` back as a ms Date OR as raw postgres text; the text fell
    // through `new Date()` to .592000 < .592134 and was flagged.
    const REPLAN_AT = '2026-10-01T10:00:30.592134Z';
    const ACT_AT = '2026-10-01T10:00:30.592634Z';
    const ready = ev('rule', REPLAN_AT, 'e-same-ms', 'split', 'ready', VERIFIED);
    const reasons = (at: Date | string): string[] => {
      const a = { ...act('doing', 'p.doing.llm_judge', ACT_AT), at };
      return computePlanConformance({ pin, events: [ready], executed: [a] }).deviations.map((d) => d.reason);
    };
    // Honest same-ms `at`, in every shape it can arrive in ⇒ no deviation.
    expect(reasons(new Date('2026-10-01T10:00:30.592Z'))).toEqual([]); // ms Date
    expect(reasons('2026-10-01T10:00:30.592Z')).toEqual([]); // ms string — same rule as the Date
    expect(reasons(ACT_AT)).toEqual([]); // the ledger's µs ISO shape
    expect(reasons('2026-10-01 10:00:30.592634+00')).toEqual([]); // raw postgres text
    // Controls: the rule still fires, identically for both ms shapes, and exactly at µs.
    expect(reasons(new Date('2026-10-01T10:00:30.591Z'))).toEqual(['activity_recorded_after_excuse']);
    expect(reasons('2026-10-01T10:00:30.591Z')).toEqual(['activity_recorded_after_excuse']);
    expect(reasons('2026-10-01T10:00:30.592133Z')).toEqual(['activity_recorded_after_excuse']);
    expect(reasons('2026-10-01T10:00:30.592134Z')).toEqual([]); // a tie is not "strictly before"
  });

  it('parseInstant: precision comes from the digits carried, not the JS type; unknown shapes throw', () => {
    const d = parseInstant(new Date('2026-10-01T10:00:30.592Z'));
    expect(parseInstant('2026-10-01T10:00:30.592Z')).toEqual(d);
    expect(d.unknownTail).toBe(999n);
    expect(parseInstant('2026-10-01T10:00:30.592634Z').unknownTail).toBe(0n);
    expect(parseInstant('2026-10-01 12:00:30.592634+02').micros).toBe(recordedMicros('2026-10-01T10:00:30.592634Z'));
    expect(parseInstant('2026-10-01T10:00:30+05:30').unknownTail).toBe(999_999n);
    expect(latestPossibleMicros('2026-10-01T10:00:30.5Z') - recordedMicros('2026-10-01T10:00:30.5Z')).toBe(99_999n);
    expect(() => parseInstant('Oct 1 2026 10:00')).toThrow(/unreadable timestamp/);
  });

  it('the valid re-plan case still conforms (ready split before any work, then the new plan runs)', () => {
    const ready = ev('rule', '2026-10-01T10:00:30Z', 'e-ready-ok', 'split', 'ready', VERIFIED);
    const a = act('doing', 'p.doing.llm_judge', '2026-10-01T10:01:00Z');
    const b = act('qa', 'p.qa.tests', '2026-10-01T10:02:00Z');
    const r = computePlanConformance({ pin, events: [ready], executed: [a, b] });
    expect(r.status).toBe('conforms');
    expect(r.deviations).toEqual([]);
    expect(r.excused_by_events.map((e) => [e.excuses, e.invalid_reason, e.excused_executed_ids])).toEqual([[true, null, [a.id]]]);
  });
});

describe('preparePlanPin', () => {
  it('sha256 is over CANONICAL json, computed server-side; pointer is {"store":"fr","sha256"}', () => {
    const reordered = { plan: { qa: PLAN.plan.qa, doing: PLAN.plan.doing }, card_type: PLAN.card_type, rule_version: 1 };
    const a = preparePlanPin(PLAN);
    const b = preparePlanPin(reordered);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.pin.sha256).toBe(b.pin.sha256);
    expect(a.pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    const canonical =
      '{"card_type":"development_bug_fix","plan":{"doing":{"activity_sequence":["p.doing.prefetch","p.doing.execute","p.doing.persist"]},"qa":{"activity_sequence":["p.qa.lint","p.qa.tests"]}},"rule_version":1}';
    expect(a.pin.sha256).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(JSON.parse(a.pin.pointer)).toStrictEqual({ store: 'fr', sha256: a.pin.sha256 });
    expect(a.pin.pointer).toBe(buildPlanPinPointer(a.pin.sha256));
  });

  it('a pin with no readable per-list sequence is a 422 plan_pin_invalid', () => {
    for (const bad of [{}, { plan: {} }, { plan: { doing: { activity_sequence: 'x' } } }, { plan: { doing: {} } }]) {
      const r = preparePlanPin(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('plan_pin_invalid');
    }
  });

  it('plan keys are the CLOSED lowercase list set: a pin keyed DOING (or any unknown list) is a 422 plan_pin_invalid', () => {
    for (const key of ['DOING', 'Doing', 'in_progress', 'review']) {
      const r = preparePlanPin({ plan: { [key]: { activity_sequence: ['p.doing.prefetch'] } } });
      expect([key, r.ok, r.ok ? null : r.body.error]).toEqual([key, false, 'plan_pin_invalid']);
    }
    // One bad key among good ones is still refused.
    const mixed = preparePlanPin({ plan: { doing: { activity_sequence: ['a'] }, QA: { activity_sequence: ['b'] } } });
    expect(mixed.ok).toBe(false);
    // Control: every one of the six lowercase lists is accepted.
    const all = Object.fromEntries(['todo', 'ready', 'doing', 'qa', 'blocked', 'done'].map((l) => [l, { activity_sequence: [`p.${l}`] }]));
    expect(preparePlanPin({ plan: all }).ok).toBe(true);
  });

  it('over 64 KiB is a 422 plan_pin_too_large; an over-long pointer is a 422 plan_pin_pointer_too_long', () => {
    const big = { plan: { doing: { activity_sequence: ['x'.repeat(PLAN_PIN_MAX_BYTES)] } } };
    const r1 = preparePlanPin(big);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.body.error).toBe('plan_pin_too_large');
    const r2 = preparePlanPin(PLAN, () => 'p'.repeat(513));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.body.error).toBe('plan_pin_pointer_too_long');
  });
});
