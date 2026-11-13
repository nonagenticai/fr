// tests/unit/domain/deblock-exit-classifier.test.ts
//
// ⛔ THE DEFECT UNDER TEST: an approval a human APPROVES that moves no card.
//
// `buildCallbackPayload` narrows `metadata.deblock_action` through a closed allowlist —
// "a key absent here is DROPPED". So a BLOCKED-exit approval minted with no action, or
// with a key the allowlist does not recognise, is answered, marked approved,
// callback-delivered, and leaves the card in BLOCKED. Every one of those states looks
// healthy on its own.
//
// RE-DERIVED 2026-09-07 -- the table that used to sit here was measured on a DIFFERENT
// ROUTE than the one this classifier gates, so it is replaced rather than reworded.
// Bucketed by `callback_path` on prod `fr` (worker4), every bucket summed against
// `count(*)` = 2,855 (a bucketed census that does not sum to its denominator is not a
// census -- an absent jsonb key makes `jsonb_typeof` NULL and a FILTER silently drops
// the row, which reads as a reassuring zero):
//
//   callback_path                      rows   carries deblock_action   approved w/o one
//   kanban/approval-callback          2,005   1,730                    3
//   execution-ready-signoff-callback    844       0                  456
//
// The "137" that justified this change is the DELIVERED-callback count among those 456
// keyless `execution.ready_signoff` rows -- a rail minted by `routes/execution-approvals.ts`
// and never seen by the guard in `routes/webhooks.ts`. On the gated route the equivalent
// figure is THREE. The guard is forward-looking, not remedial.
//
// ⚠️ TWO KEYS, NOT ONE, IN EVERY POSITIVE CASE BELOW. A fixture that only ever passes
// 'RETRY' is satisfied by an implementation that returns 'RETRY' unconditionally — the
// agreeing mutant survives, and a hardcode is indistinguishable from the real narrowing.
// So each positive assertion is made twice with DIFFERENT keys, and the negative arm
// uses a string that is deliberately plausible ('UNBLOCK') rather than obvious garbage:
// the whole failure mode is a value that LOOKS like an action and is not in the set.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEBLOCK_ACTIONS,
  DEBLOCK_EXEMPTIONS,
  classifyDeblockExit,
  classifyDeciderOverride,
  deblockActionRequiredMessage,
  deblockDualExitMessage,
  irreconcilableDualExit,
} from '../../../src/domain/engagement/deblock-actions';

const BACKEND = join(import.meta.dir, '..', '..', '..');

/**
 * The metrics exposition as a FRESH process renders it. The counters are
 * process-global and other test files increment them, so "exposed at zero
 * before anything fires" is only observable in a clean module state.
 */
let freshExposition: string | null = null;
function freshRender(): string {
  if (freshExposition !== null) return freshExposition;
  const p = Bun.spawnSync(
    [
      'bun',
      '-e',
      "const m = await import('./src/lib/deblock-action-metrics.ts'); console.log(m.renderDeblockActionMetrics().join('\\n'));",
    ],
    { cwd: BACKEND, env: process.env },
  );
  if (p.exitCode !== 0) throw new Error(`fresh render failed: ${p.stderr.toString()}`);
  freshExposition = p.stdout.toString();
  return freshExposition;
}

/** A BLOCKED-exit card approval: it names Planka lists and has no other exit. */
const blockedExit = (action: unknown) => ({
  action,
  doingListId: 'list-doing-1',
  todoListId: 'list-todo-1',
});

describe('a BLOCKED-exit approval must carry an action the allowlist recognises', () => {
  test('a recognised key is usable — asserted with TWO different keys', () => {
    const retry = classifyDeblockExit(blockedExit('RETRY'));
    expect(retry).toEqual({
      required: true,
      usable: true,
      action: 'RETRY',
      rawWasPresent: true,
    });

    // The second key is what kills a hardcode. An implementation that ignores its input
    // and answers 'RETRY' passes the assertion above and fails this one.
    const merge = classifyDeblockExit(blockedExit('MERGE'));
    expect(merge).toEqual({
      required: true,
      usable: true,
      action: 'MERGE',
      rawWasPresent: true,
    });
  });

  test('a key the allowlist DROPS is refused, and is distinguishable from absence', () => {
    // 'UNBLOCK' is the shape that actually hurts: a real-looking action that
    // `asDeblockAction` narrows to undefined, so the callback's switch matches nothing.
    const dropped = classifyDeblockExit(blockedExit('UNBLOCK'));
    expect(dropped.required).toBe(true);
    // Narrowing, not ceremony: `usable` exists only on the required arm of the union, so
    // reaching for it without this is a compile error — which is the type system saying
    // the same thing the runtime assertion says.
    if (!dropped.required) throw new Error('a listed BLOCKED-exit approval must be required');
    expect(dropped.usable).toBe(false);
    expect(dropped.action).toBeUndefined();
    // PRESENT-but-dropped, not absent. The two have different producers and different
    // fixes: one sent a value this system throws away, the other sent nothing at all.
    expect(dropped.rawWasPresent).toBe(true);

    const absent = classifyDeblockExit(blockedExit(undefined));
    expect(absent.required).toBe(true);
    if (!absent.required) throw new Error('a listed BLOCKED-exit approval must be required');
    expect(absent.usable).toBe(false);
    expect(absent.rawWasPresent).toBe(false);

    // Lower-case is not a near-miss the set forgives. It is dropped like any other.
    const lower = classifyDeblockExit(blockedExit('retry'));
    if (!lower.required) throw new Error('a listed BLOCKED-exit approval must be required');
    expect(lower.usable).toBe(false);
  });

  test('the refusal names every legal value, so its reader need not go find them', () => {
    const msg = deblockActionRequiredMessage('card-42');
    expect(msg).toContain('card-42');
    for (const a of DEBLOCK_ACTIONS) expect(msg).toContain(a);
  });
});

describe('the lanes that legitimately have another exit are NOT refused', () => {
  test('a contract gate advances a phase, so it needs no card move', () => {
    const exit = classifyDeblockExit({
      ...blockedExit(undefined),
      advancePhase: 'deep_analysis',
    });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'phase_advance' });
  });

  test('an improvement gate is routed by the improvement cockpit, not the deblock switch', () => {
    const exit = classifyDeblockExit({
      ...blockedExit(undefined),
      improvementKind: 'improvement.design',
    });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'improvement_gate' });
  });

  test('no Planka list target means there is no card move for an action to drive', () => {
    const exit = classifyDeblockExit({ action: undefined });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'no_list_target' });
  });

  test('ONE list target is still a card move — todoListId alone does not exempt', () => {
    // The reject arm moves the card to `todoListId`. An approval that names only that
    // list is still a BLOCKED-exit proposition.
    const exit = classifyDeblockExit({ action: undefined, todoListId: 'list-todo-1' });
    expect(exit.required).toBe(true);
  });
});

describe('the counter makes the drop a number instead of nothing', () => {

  test('every series is exposed at zero, so a silent seam is visible before it fires', () => {
    // A counter that only appears once it is non-zero cannot be alerted on with
    // `increase(...) > 0` from a dashboard nobody has built yet.
    const text = freshRender();
    expect(text).toContain('# TYPE fr_deblock_actions_total counter');
    for (const stage of ['mint', 'decide']) {
      for (const label of [...DEBLOCK_ACTIONS, 'absent', 'unrecognised']) {
        expect(text).toContain(`fr_deblock_actions_total{stage="${stage}",action="${label}"} 0`);
      }
    }
  });
});

describe('the ROUTES actually use it — a classifier nobody calls fixes nothing', () => {
  // Deliberately a source assertion. The mint refusal and the decide-time counter both
  // sit behind a database and a shared-secret webhook, so a unit test cannot drive them;
  // and the failure this whole file exists for is precisely "the code is correct and
  // never runs". This is the same idiom
  // `scripts/check-approval-mint-guard.ts` already uses for exactly that reason.
  const src = (rel: string) =>
    readFileSync(join(import.meta.dir, '..', '..', '..', 'src', rel), 'utf8');

  test('the n8n card-approval mint classifies, counts, and REFUSES before inserting', () => {
    const webhooks = src('routes/webhooks.ts');
    // ⚠️ ANCHOR UPDATED ON REBASE ONTO #1005, NOT A WEAKENING. This used to scan for
    // `await db.insert(approvals).values({`. fr#1000's one-open-gate work replaced the
    // raw insert on BOTH doors with `mintOneOpenGate({ ..., values: gateValues })`, so
    // the old needle now matches NOTHING and `lastIndexOf` returns -1 — which is how
    // this test caught the rebase instead of silently passing a slice of the whole file.
    //
    // `mintOneOpenGate` is the stronger anchor anyway: it IS the write now, so "before
    // the mint" is still literally what is being asserted. `lastIndexOf` is kept for the
    // same reason it was chosen originally — webhooks.ts has TWO minting doors and the
    // card-approval one is the LAST; anchoring on the first would slice off the very
    // region under test and pass vacuously.
    //
    // ⚠️ ANCHOR UPDATED AGAIN (fr#1345), NOT A WEAKENING. The card-approval door now mints
    // through `mintGateOnePerBugCard(...)` (services/approvals/bug-fix-uniqueness.ts), which
    // wraps `mintOneOpenGate` and adds the marked bug-fix dedupe; it IS the write on this
    // door. `await mintOneOpenGate({` now matches only the FIRST door (approval-request), so
    // keeping it would slice off the region under test and pass vacuously. The new needle
    // occurs exactly once in webhooks.ts (the import line has no `await`), and it must sit
    // AFTER the first door's mint, i.e. inside handleN8nCardApproval.
    const mintIdx = webhooks.lastIndexOf('await mintGateOnePerBugCard(');
    expect(mintIdx).toBeGreaterThan(webhooks.indexOf('export async function handleN8nCardApproval('));
    expect(mintIdx).toBeGreaterThan(0);
    const beforeMint = webhooks.slice(0, mintIdx);
    expect(beforeMint).toContain('classifyDeblockExit({');
    expect(beforeMint).toContain("recordDeblockAction('mint'");
    // The refusal, not merely the classification. Counting an absent action and writing
    // the row anyway is the bug with telemetry bolted on.
    expect(beforeMint).toContain('deblockActionRequiredMessage(validated.card_id)');
  });

  test('the decision path counts what the callback is about to drop', () => {
    const approvals = src('routes/approvals.ts');
    expect(approvals).toContain('classifyDeblockExit({');
    expect(approvals).toContain("recordDeblockAction('decide'");
  });

  test('the exporter renders it — a counter off /api/metrics/prom is unreachable', () => {
    expect(src('routes/metrics.ts')).toContain('renderDeblockActionMetrics()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// THE ORDER OF THE EXEMPTIONS -- added 2026-09-07.
//
// These are the tests the previous revision did not have, and their absence is why a
// guard that could never fire read as a guard with zero blast radius.
// ─────────────────────────────────────────────────────────────────────────────────────

/** The live shape on `kanban/approval-callback`: list ids PRESENT and EMPTY, 2,004 of 2,005. */
const emptyListIds = { doingListId: '', todoListId: '' };

describe('a usable action outranks the no_list_target exemption', () => {
  test('empty list ids do NOT exempt a row that carries an action -- TWO different keys', () => {
    // ⛔ THE REGRESSION THIS PINS. `isString` requires `length > 0`, so `doingListId: ''`
    // satisfied `no_list_target`. With that test placed FIRST, all 2,005 rows on this
    // route were exempt, `required` was true for ZERO of them, and the mint counter
    // recorded nothing -- while 1,730 of those rows carried a perfectly good action.
    // Moving the action test back below the list test makes both assertions here fail.
    const retry = classifyDeblockExit({ ...emptyListIds, action: 'RETRY' });
    expect(retry).toEqual({ required: true, usable: true, action: 'RETRY', rawWasPresent: true });

    // Second key: a hardcoded `'RETRY'` passes the line above and fails this one.
    const merge = classifyDeblockExit({ ...emptyListIds, action: 'MERGE' });
    expect(merge).toEqual({ required: true, usable: true, action: 'MERGE', rawWasPresent: true });
  });

  test('with NO action, empty list ids still exempt -- the reorder adds no refusals', () => {
    // The control for the test above. Reordering must not turn the 243 action-less rows
    // on this route into 422s; they stay exempt until the producer names a real list.
    const exit = classifyDeblockExit({ ...emptyListIds, action: undefined });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'no_list_target' });
  });
});

describe('the ready-signoff rail is exempt, so the counter is not 844/844 false', () => {
  /** Measured: all 844 rows carry NON-EMPTY list ids and none carries an action. */
  const signoffRow = { action: undefined, doingListId: 'list-doing-1', todoListId: 'list-todo-1' };

  test('an execution.ready_signoff row is exempt despite naming both lists', () => {
    const exit = classifyDeblockExit({ ...signoffRow, approvalKind: 'execution.ready_signoff' });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'signoff_rail' });
  });

  test('the SAME shape on a card approval is still required -- it is the kind, not the shape', () => {
    // Without this control the test above would pass for an implementation that exempts
    // every row with populated list ids, which would disable the guard entirely.
    const exit = classifyDeblockExit({ ...signoffRow, approvalKind: 'generic' });
    expect(exit.required).toBe(true);
    if (!exit.required) throw new Error('a card approval naming both lists must be required');
    expect(exit.usable).toBe(false);
  });

  test('the rail exemption is narrow -- a neighbouring execution kind is NOT exempt', () => {
    // `startsWith('execution')` instead of an equality test would swallow real gates.
    const exit = classifyDeblockExit({ ...signoffRow, approvalKind: 'execution.other' });
    expect(exit.required).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// PINNING THE *OTHER* ORDERING -- added 2026-09-07 after a verifier mutant survived.
//
// This PR fixes one ordering bug (`no_list_target` above the usable-action test) and the
// tests above pin that one. A verifier then mutated the SIBLING ordering -- hoisting the
// usable-action test ABOVE the three lane exemptions -- and every test still passed,
// 71/0. That is the same defect class this PR exists to repair: an ordering that nothing
// pins, whose correctness is currently an accident of which fixtures happen to exist.
//
// ⛔ These pin the ordering that IS in the code; they do not argue for it. A lane
// exemption means "this approval's exit is driven by another mechanism entirely", so a
// stray `deblock_action` riding along on such a row must not convert it into a
// BLOCKED-exit proposition. Every fixture below therefore carries a USABLE action -- the
// case the pre-existing exemption tests never covered, because all of them pass
// `action: undefined`.
// ─────────────────────────────────────────────────────────────────────────────────────
describe('a lane exemption outranks a usable action', () => {
  test('phase_advance wins even when a usable action is present', () => {
    const exit = classifyDeblockExit({ ...blockedExit('RETRY'), advancePhase: 'deep_analysis' });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'phase_advance', action: undefined });
  });

  test('improvement_gate wins even when a usable action is present', () => {
    // A second, different key: an implementation that special-cased only 'RETRY' would
    // pass the test above and fail this one.
    const exit = classifyDeblockExit({
      ...blockedExit('MERGE'),
      improvementKind: 'improvement.design',
    });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'improvement_gate', action: undefined });
  });

  test('signoff_rail wins even when a usable action is present', () => {
    const exit = classifyDeblockExit({
      ...blockedExit('QUESTION'),
      approvalKind: 'execution.ready_signoff',
    });
    expect(exit.required).toBe(false);
    expect(exit).toMatchObject({ exemption: 'signoff_rail', action: undefined });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// DUAL EXIT -- one row asserting TWO exits. Added 2026-09-07.
//
// ⛔ The describe block ABOVE pins that a lane exemption outranks a usable action, and it
// says of itself: "These pin the ordering that IS in the code; they do not argue for it."
// That ordering is UNCHANGED here -- `required` and `exemption` still read exactly as they
// did, which is why every assertion above still passes.
//
// What changed is that the exemption no longer reports `action: undefined` as though the
// row had never carried one. The action was real, and `buildCallbackPayload` was SENDING
// it while the classifier reported it did not exist. The conflict is now on the result,
// and one shared predicate (`irreconcilableDualExit`) decides what all three seams do.
// ─────────────────────────────────────────────────────────────────────────────────────
describe('a lane exemption that discards a usable action now SAYS SO', () => {
  test('phase_advance + a usable action reports the conflict -- TWO different keys', () => {
    const retry = classifyDeblockExit({ ...blockedExit('RETRY'), advancePhase: 'deep_analysis' });
    // The pinned ordering is untouched: still exempt, still not required.
    expect(retry.required).toBe(false);
    expect(retry).toMatchObject({ exemption: 'phase_advance', action: undefined });
    if (retry.required) throw new Error('a phase_advance row must stay exempt');
    expect(retry.conflict).toEqual({ exemption: 'phase_advance', discarded: 'RETRY' });

    // Second key -- an implementation that hardcoded 'RETRY' passes the line above.
    const merge = classifyDeblockExit({ ...blockedExit('MERGE'), advancePhase: 'deep_analysis' });
    if (merge.required) throw new Error('a phase_advance row must stay exempt');
    expect(merge.conflict).toEqual({ exemption: 'phase_advance', discarded: 'MERGE' });
  });

  test('⭐ THE CONTROL: the same lane with NO action reports NO conflict', () => {
    // Without this, an implementation that stamped a conflict on every exempt row would
    // pass the test above -- and would then refuse the 243 action-less rows this lane is
    // supposed to carry.
    const exit = classifyDeblockExit({ ...blockedExit(undefined), advancePhase: 'deep_analysis' });
    if (exit.required) throw new Error('a phase_advance row must stay exempt');
    expect(exit.conflict).toBeUndefined();
  });

  test('an UNRECOGNISED action is not a conflict -- there is nothing usable to discard', () => {
    // 'UNBLOCK' looks like an action and is not in the closed set. The row is already
    // broken for a different reason, and calling it a dual exit would misname the defect.
    const exit = classifyDeblockExit({ ...blockedExit('UNBLOCK'), advancePhase: 'deep_analysis' });
    if (exit.required) throw new Error('a phase_advance row must stay exempt');
    expect(exit.conflict).toBeUndefined();
  });

  test('no_list_target can NEVER conflict -- it is reached only after the action test', () => {
    // Structural, not a judgement call: step (3) runs only once step (2) has ruled out a
    // usable action. A conflict here would mean the ordering had been broken.
    const exit = classifyDeblockExit({ action: 'RETRY' });
    // A usable action outranks no_list_target (that is #1008's fix), so this is required.
    expect(exit.required).toBe(true);
    const noAction = classifyDeblockExit({ action: undefined });
    if (noAction.required) throw new Error('no list target must exempt');
    expect(noAction.exemption).toBe('no_list_target');
    expect(noAction.conflict).toBeUndefined();
  });
});

describe('irreconcilableDualExit -- ONE answer, so three seams cannot drift apart', () => {
  const withAction = (extra: Record<string, unknown>) =>
    irreconcilableDualExit(classifyDeblockExit({ ...blockedExit('RETRY'), ...extra }));

  test('phase_advance (the retained marker lane) is refused', () => {
    expect(withAction({ advancePhase: 'deep_analysis' })).toEqual({
      exemption: 'phase_advance',
      discarded: 'RETRY',
    });
  });

  test('⭐ a signoff row is NEVER a dual exit (narrowed 2026-09-14; card-type signal deleted fr#1481)', () => {
    // Used to be refused wholesale ("measured 0 conflicts" — headroom, not a premise), then
    // only when a `decision_development` card_type ALSO advanced the macro phase. That phase
    // advance was deleted in fr#1481, so a signoff row's action is its ONLY exit and travels.
    expect(withAction({ approvalKind: 'execution.ready_signoff' })).toBeUndefined();
  });

  test('⛔ improvement_gate is NOT refused -- 32 of its 34 prod rows carry an action', () => {
    // The load-bearing exclusion in this change. If this ever returns a conflict, the mint
    // starts 422-ing the normal shape of a live lane, invisibly (continueOnFail:true).
    expect(withAction({ improvementKind: 'improvement.design' })).toBeUndefined();
  });

  test('a plain BLOCKED-exit row and an exempt-but-action-less row both reconcile', () => {
    // Both controls for the two positives above: the overwhelmingly common shapes must
    // return undefined, or the guard fires on healthy traffic and gets muted.
    expect(irreconcilableDualExit(classifyDeblockExit(blockedExit('RETRY')))).toBeUndefined();
    expect(
      irreconcilableDualExit(
        classifyDeblockExit({ ...blockedExit(undefined), advancePhase: 'deep_analysis' }),
      ),
    ).toBeUndefined();
  });

  test('the refusal names BOTH exits it found, not just "invalid"', () => {
    const conflict = withAction({ advancePhase: 'deep_analysis' })!;
    const msg = deblockDualExitMessage('card-42', conflict);
    expect(msg).toContain('card-42');
    expect(msg).toContain('phase_advance');
    expect(msg).toContain('RETRY');
  });
});

describe('the dual-exit counter is per-lane, so the two populations stay apart', () => {

  test('every dual-exit series is exposed at zero, including the unreachable one', () => {
    const text = freshRender();
    for (const stage of ['mint', 'decide']) {
      for (const lane of DEBLOCK_EXEMPTIONS) {
        expect(text).toContain(
          `fr_deblock_actions_total{stage="${stage}",action="dual_exit_${lane}"} 0`,
        );
      }
    }
  });
});

describe('THE ROUTES actually reconcile -- a shared predicate nobody calls fixes nothing', () => {
  const src = (rel: string) =>
    readFileSync(join(import.meta.dir, '..', '..', '..', 'src', rel), 'utf8');

  test('the mint REFUSES a dual exit before it writes the row', () => {
    const webhooks = src('routes/webhooks.ts');
    // Anchor = the card-approval door's write, `mintGateOnePerBugCard` (fr#1345); see the
    // note on the classifier test above for why `mintOneOpenGate` would now pass vacuously.
    const mintIdx = webhooks.lastIndexOf('await mintGateOnePerBugCard(');
    expect(mintIdx).toBeGreaterThan(webhooks.indexOf('export async function handleN8nCardApproval('));
    expect(mintIdx).toBeGreaterThan(0);
    const beforeMint = webhooks.slice(0, mintIdx);
    expect(beforeMint).toContain('irreconcilableDualExit(deblockExit)');
    expect(beforeMint).toContain('deblockDualExitMessage(validated.card_id, dualExit)');
    expect(beforeMint).toContain("recordDeblockDualExit('mint'");
  });

  test('⭐ buildCallbackPayload CONSULTS the classifier -- the seam that did not', () => {
    // The defect in one assertion: this builder used to call `asDeblockAction` and nothing
    // else, so it could not agree with the classifier because it never asked it.
    const callback = src('services/n8n-callback.ts');
    expect(callback).toContain('classifyDeblockExit({');
    expect(callback).toContain('irreconcilableDualExit(deblockExit)');
    expect(callback).toContain("recordDeblockDualExit('decide'");
  });

  test('the decider-override handler DELEGATES to the pure verdict, not to inline ifs', () => {
    // ⚠️ THIS TEST REPLACED A SOURCE-ORDERING ASSERTION THAT A MUTANT SURVIVED. The old
    // version compared indexOf() of two strings. Disabling the refusal with
    // `if (false && dualExit)` left both strings exactly where it looked for them and all
    // 67 tests passed. The behaviour is now pinned by the `classifyDeciderOverride` block
    // below; this only asserts the route still routes through it.
    const approvals = src('routes/approvals.ts');
    expect(approvals).toContain('classifyDeciderOverride(deblockExit, proposedAction)');
    // ⚠️ THE WHOLE GUARD EXPRESSION, NOT A SUBSTRING OF IT. Asserting only
    // `overrideVerdict.reason === 'dual_exit'` is satisfied by
    // `if (false && !overrideVerdict.allowed && overrideVerdict.reason === 'dual_exit')` —
    // measured: that mutant survived 71/71 against the looser assertion. Pinning the exact
    // condition is what makes a disabled refusal fail this test.
    expect(approvals).toContain(
      "if (!overrideVerdict.allowed && overrideVerdict.reason === 'dual_exit') {",
    );
    // And the refusal must still be REACHED — a second `if (!overrideVerdict.allowed)`
    // below it is what turns a non-dual refusal into the pre-existing message.
    expect(approvals).toContain('if (!overrideVerdict.allowed) {');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// THE DECIDER OVERRIDE -- behavioural, because the source assertion was not.
//
// ⛔ A mutant disabling this refusal outright survived 67/67 while it was only covered by
// a grep over `routes/approvals.ts`. `classifyDeciderOverride` was extracted so the rule
// can be driven directly, and these are the tests that mutant now fails.
// ─────────────────────────────────────────────────────────────────────────────────────
describe('classifyDeciderOverride -- a stored action is not proof of a proposition', () => {
  const verdictFor = (extra: Record<string, unknown>, stored: unknown) =>
    classifyDeciderOverride(classifyDeblockExit({ ...blockedExit(stored), ...extra }), stored);

  test('⭐ a dual-exit row is REFUSED even though it carries a stored action', () => {
    // The defect in one assertion. `typeof storedAction !== 'string'` is FALSE here, so the
    // recovery-door test alone would have returned `allowed: true`.
    const v = verdictFor({ advancePhase: 'deep_analysis' }, 'RETRY');
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('a dual-exit row must refuse an override');
    expect(v.reason).toBe('dual_exit');
    expect(v).toMatchObject({ conflict: { exemption: 'phase_advance', discarded: 'RETRY' } });

    // Second key, so a hardcode on 'RETRY' cannot pass.
    const merge = verdictFor({ advancePhase: 'deep_analysis' }, 'MERGE');
    // Narrow on `reason`, not just on `allowed`: the refusal union has two arms and only
    // one carries a conflict, so this is the type system insisting the test says WHICH
    // refusal it expects rather than accepting either one.
    if (merge.allowed || merge.reason !== 'dual_exit') {
      throw new Error('a dual-exit row must refuse an override as dual_exit');
    }
    expect(merge.conflict.discarded).toBe('MERGE');
  });

  test('⭐ THE CONTROL: the recovery door still opens on a plain BLOCKED-exit row', () => {
    // #982 reopened this deliberately. If the new refusal closed it, the keyless
    // approvals it exists to repair by hand become unrepairable again.
    expect(verdictFor({}, 'RETRY').allowed).toBe(true);
    expect(verdictFor({}, undefined).allowed).toBe(true);
  });

  test('a row that is neither required nor carries an action is refused, as before', () => {
    // The signoff rail with no action: the pre-existing refusal, unchanged.
    const v = classifyDeciderOverride(
      classifyDeblockExit({ ...blockedExit(undefined), approvalKind: 'execution.ready_signoff' }),
      undefined,
    );
    expect(v.allowed).toBe(false);
    if (v.allowed) throw new Error('expected a refusal');
    expect(v.reason).toBe('not_a_blocked_exit');
  });

  test('⛔ an improvement row with an action is ALLOWED -- the excluded lane, again', () => {
    expect(verdictFor({ improvementKind: 'improvement.design' }, 'QUESTION').allowed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// PR #1123 AUDIT, FINDING 1 -- the signoff narrowing must not reopen the decider override.
//
// ⛔ Narrowing `laneAssertsCompetingExit` removed the conflict from a single-exit signoff row,
// which is right for the PAYLOAD (its stored action is its only exit and now travels). It also
// removed the only thing refusing a decider's override there: no conflict -> no `dual_exit` ->
// a string stored action -> `allowed: true`. The signoff receiver branches on QUESTION alone,
// so an override made fr predict a move (INFRASTRUCTURE -> TODO) the receiver does not make
// (plain approved path -> DOING). Four controls, each able to fail on its own.
// ─────────────────────────────────────────────────────────────────────────────────────
describe('the signoff narrowing sends the stored action but does NOT reopen the override', () => {
  const SIGNOFF = 'execution.ready_signoff';
  const verdictFor = (extra: Record<string, unknown>, stored: unknown) =>
    classifyDeciderOverride(classifyDeblockExit({ ...blockedExit(stored), ...extra }), stored);

  test('⭐ a decider override on a single-exit signoff row is REFUSED -- TWO different keys', () => {
    const q = verdictFor({ approvalKind: SIGNOFF }, 'QUESTION');
    expect(q).toEqual({ allowed: false, reason: 'signoff_rail' });
    const r = verdictFor({ approvalKind: SIGNOFF }, 'RETRY');
    expect(r).toEqual({ allowed: false, reason: 'signoff_rail' });
  });

  test('CONTROL: the same single-exit signoff row is still NOT a dual exit, so its action travels', () => {
    // The refusal above must come from the lane, not from re-introducing the conflict --
    // re-introducing it would withhold the stored action from the payload again.
    const exit = classifyDeblockExit({ ...blockedExit('QUESTION'), approvalKind: SIGNOFF });
    expect(irreconcilableDualExit(exit)).toBeUndefined();
  });

  test('CONTROL: a GENUINE dual-exit row (the retained phase marker) still refuses as dual_exit', () => {
    // fr#1481: the signoff `decision_development` dual exit no longer exists (its phase
    // advance was deleted); the one remaining dual-exit shape is the marker lane.
    const v = verdictFor({ advancePhase: 'deep_analysis' }, 'QUESTION');
    if (v.allowed || v.reason !== 'dual_exit') {
      throw new Error(`expected dual_exit, got ${JSON.stringify(v)}`);
    }
    expect(v.conflict).toEqual({ exemption: 'phase_advance', discarded: 'QUESTION' });
  });

  test('CONTROL: an ordinary kanban/approval-callback row still ALLOWS the override', () => {
    // Over-refusal guard: the same stored action on the ordinary rail is the recovery door.
    expect(verdictFor({ approvalKind: 'generic' }, 'QUESTION')).toEqual({ allowed: true });
    expect(verdictFor({}, 'RETRY')).toEqual({ allowed: true });
  });
});

// ── RECLASSIFY (REALIGN R5) ─────────────────────────────────────────────────────────
describe('RECLASSIFY is a usable BLOCKED exit', () => {

  test('a BLOCKED-exit approval carrying RECLASSIFY is usable', () => {
    expect(classifyDeblockExit(blockedExit('RECLASSIFY'))).toEqual({
      required: true,
      usable: true,
      action: 'RECLASSIFY',
      rawWasPresent: true,
    });
  });

});
