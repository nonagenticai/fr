// $lib/approvals/callback-state — the persisted de-block callback state of one row.
//
// ⭐ EVERY TEST HERE NAMES THE MUTATION IT EXISTS TO KILL. A test that cannot
// name one is decoration; this lane has already shipped five green unit tests
// covering fields that ZERO components read.
//
// The axis under test is ABSENT ≠ NULL ≠ A VALUE:
//   field missing  → an fr build that predates the column ⇒ nobody can say
//   field NULL     → this backend spoke and has no answer yet
//   field set      → the answer
// Collapsing any pair of those is the defect. `'unknown'` and `'unconfirmed'`
// must therefore never be the same return value.

import { describe, it, expect } from 'vitest';
import { callbackRowState, callbackRowNotice } from './callback-state';
import type { Approval } from '$lib/types/api';

const FAILURE_WORDS = /\bfail(ed|s|ure|ures|ing)?\b|\berror(s|ed)?\b/i;

/**
 * A decided row. Callback keys are added by the caller so that OMITTING one is
 * expressible — `{ callback_acked_at: undefined }` is NOT the same shape and
 * would defeat the whole point of these tests.
 */
function row(over: Partial<Approval> & Record<string, unknown> = {}): Approval {
  return {
    id: 'a-1',
    project_id: 'p-1',
    requester_id: 'u-req',
    status: 'approved',
    description: 'Decided row',
    created_at: '2026-09-20T10:00:00.000Z',
    expires_at: null,
    ...over,
  } as Approval;
}

const NULLS = {
  callback_acked_at: null,
  callback_resolution: null,
  callback_outcome_unknown_at: null,
} as const;

describe('callbackRowState — absent vs null vs a value', () => {
  it('a decided row with ack and resolution both NULL is "unconfirmed"', () => {
    // KILLS: gating the chip on `callback_resolution === 'send_exhausted'`
    // only. That mutation returns 'not-decided'/null here and the single
    // commonest undelivered shape on the queue renders nothing at all.
    expect(callbackRowState(row({ ...NULLS }))).toBe('unconfirmed');
  });

  it('a decided row with the three keys ABSENT is "unknown", never "moved"', () => {
    // KILLS: `a.callback_resolution ?? 'moved'` as a default — the single most
    // tempting line in this file, and a claim of success fr never measured.
    const state = callbackRowState(row());
    expect(state).toBe('unknown');
    expect(state).not.toBe('moved');
  });

  it('"unknown" (absent) and "unconfirmed" (null) are DIFFERENT values', () => {
    // KILLS: any normalisation of the row that turns a missing key into null
    // (a spread through a defaults object, `?? null`, a zod `.default(null)`).
    expect(callbackRowState(row())).not.toBe(callbackRowState(row({ ...NULLS })));
  });

  it('a resolution of "moved" wins even when the ack is NULL', () => {
    // KILLS: driving the state off `callback_acked_at` alone. The redelivery
    // worker resolves rows whose original send never acked, so ack-NULL +
    // moved is a real and common shape — and the loudest possible false alarm.
    expect(callbackRowState(row({ ...NULLS, callback_resolution: 'moved' }))).toBe('moved');
  });

  it('the two benign resolutions are one state, and it is not an alarm', () => {
    expect(callbackRowState(row({ ...NULLS, callback_resolution: 'not_blocked' }))).toBe('benign');
    expect(callbackRowState(row({ ...NULLS, callback_resolution: 'hold_acknowledged' }))).toBe(
      'benign',
    );
  });

  it('send_exhausted and card_unreadable are their own states', () => {
    expect(callbackRowState(row({ ...NULLS, callback_resolution: 'send_exhausted' }))).toBe(
      'exhausted',
    );
    expect(callbackRowState(row({ ...NULLS, callback_resolution: 'card_unreadable' }))).toBe(
      'unreadable',
    );
  });

  it('read_degraded is a NAMED state, never "unknown" — fr CAN say what happened', () => {
    // KILLS: omitting 'read_degraded' from KNOWN_RESOLUTIONS, which is the exact
    // state this build shipped in while migration 134 was live in prod. The
    // degrade-to-unknown arm then answered 'unknown' for it — "this fr build
    // cannot say what happened" — with no type error and no red test. fr could
    // say: #1104 minted a SIXTH value precisely because none of the other five
    // was honest about the row.
    const state = callbackRowState(row({ ...NULLS, callback_resolution: 'read_degraded' }));
    expect(state).toBe('read-degraded');
    expect(state).not.toBe('unknown');
    // KILLS: folding it into `card_unreadable`. That value asserts Planka
    // answered 404 on the CARD's own read path, measured FALSE for all 18 stuck
    // rows in migration 134's header (the card read returned 200; `lists.get`
    // was the failure). Same reason it is not `moved`: no delivery happened.
    expect(state).not.toBe('unreadable');
    expect(state).not.toBe('moved');
    expect(state).not.toBe('benign');
  });

  it('acked with no resolution is "in-flight" — transport is not effect', () => {
    expect(
      callbackRowState(
        row({ ...NULLS, callback_acked_at: '2026-09-20T10:05:00.000Z' }),
      ),
    ).toBe('in-flight');
  });

  it('callback_outcome_unknown_at with a NULL ack is "unconfirmed", not a failure', () => {
    // KILLS: mapping the epistemic column to the error branch. schema.ts ~1119:
    // it is "NOT AN ENDING", the row stays repairable, and the receiver was
    // never observed to refuse anything.
    const state = callbackRowState(
      row({ ...NULLS, callback_outcome_unknown_at: '2026-09-20T10:05:00.000Z' }),
    );
    expect(state).toBe('unconfirmed');
    expect(state).not.toBe('exhausted');
    expect(state).not.toBe('unreadable');
  });

  it('a pending row is "not-decided" — no onward delivery is owed yet', () => {
    expect(callbackRowState(row({ status: 'pending', ...NULLS }))).toBe('not-decided');
    expect(callbackRowState(row({ status: 'pending' }))).toBe('not-decided');
  });

  it('voided and expired are terminal but NOT decided — no spent-decision copy', () => {
    // KILLS: `status !== 'pending'` as the decided test. Nobody decided these,
    // so "your decision is already recorded" would be a lie about a row an
    // operator withdrew or a worker timed out.
    expect(callbackRowState(row({ status: 'voided', ...NULLS }))).toBe('not-decided');
    expect(callbackRowState(row({ status: 'expired', ...NULLS }))).toBe('not-decided');
    expect(callbackRowNotice(row({ status: 'voided', ...NULLS }))).toBeNull();
  });

  it('a resolution value this build has never heard of degrades to "unknown"', () => {
    // KILLS: treating an unrecognised sixth CHECK member as "no answer yet".
    // There IS an answer; this bundle cannot read it. Same epistemic state as
    // an older backend, and the copy is written to cover both.
    expect(
      callbackRowState(row({ ...NULLS, callback_resolution: 'card_deleted' as unknown as 'moved' })),
    ).toBe('unknown');
  });
});

describe('callbackRowNotice — tone is a correctness rule', () => {
  it('renders NOTHING for not-decided, moved and benign', () => {
    // KILLS: a chip on every decided row. A badge that is always there is a
    // badge nobody reads, and it would bury the three that matter.
    expect(callbackRowNotice(row({ status: 'pending', ...NULLS }))).toBeNull();
    expect(callbackRowNotice(row({ ...NULLS, callback_resolution: 'moved' }))).toBeNull();
    expect(callbackRowNotice(row({ ...NULLS, callback_resolution: 'not_blocked' }))).toBeNull();
    expect(
      callbackRowNotice(row({ ...NULLS, callback_resolution: 'hold_acknowledged' })),
    ).toBeNull();
  });

  it('unconfirmed / in-flight / unknown are WARNINGS with no failure word', () => {
    // KILLS: routing any not-knowing state through the error branch. An unknown
    // is not a failure — they make opposite claims about the receiver.
    const cases = [
      row({ ...NULLS }),
      row({ ...NULLS, callback_acked_at: '2026-09-20T10:05:00.000Z' }),
      row({ ...NULLS, callback_outcome_unknown_at: '2026-09-20T10:05:00.000Z' }),
      row(),
    ];
    for (const a of cases) {
      const notice = callbackRowNotice(a)!;
      expect(notice.tone).toBe('warning');
      expect(notice.label).not.toMatch(FAILURE_WORDS);
      expect(notice.message).not.toMatch(FAILURE_WORDS);
    }
  });

  it('only exhausted, unreadable and read-degraded may be red — and no other state is', () => {
    // ⚠️ WIDENED FROM A GATE THAT COULD NOT FAIL. This used to assert only that
    // the two red states ARE red, which is true of a mutant that makes EVERY
    // state red. The negative half is the half that pins the tone rule.
    const RED = new Set(['exhausted', 'unreadable', 'read-degraded']);
    const cases: Array<[string, Approval]> = [
      ['exhausted', row({ ...NULLS, callback_resolution: 'send_exhausted' })],
      ['unreadable', row({ ...NULLS, callback_resolution: 'card_unreadable' })],
      ['read-degraded', row({ ...NULLS, callback_resolution: 'read_degraded' })],
      ['unconfirmed', row({ ...NULLS })],
      ['in-flight', row({ ...NULLS, callback_acked_at: '2026-09-20T10:05:00.000Z' })],
      ['unknown', row()],
    ];
    for (const [name, a] of cases) {
      const notice = callbackRowNotice(a)!;
      expect(notice.state).toBe(name);
      expect(notice.tone).toBe(RED.has(name) ? 'error' : 'warning');
    }
  });

  it('read-degraded reads as neither a completion nor a "cannot say"', () => {
    // KILLS: reusing the `'unknown'` copy for it (the shape the missing
    // KNOWN_RESOLUTIONS entry produced), and KILLS returning `null` for it the
    // way `'moved'` and `'benign'` do — a retired, never-sent row that renders
    // NOTHING is byte-identical on the queue to a card that moved cleanly, which
    // is the whole defect #1104's sixth value exists to make visible.
    const notice = callbackRowNotice(row({ ...NULLS, callback_resolution: 'read_degraded' }))!;
    const unknown = callbackRowNotice(row())!;
    const moved = callbackRowNotice(row({ ...NULLS, callback_resolution: 'moved' }));

    expect(moved).toBeNull();
    expect(notice).not.toBeNull();
    expect(notice.testId).toBe('approval-callback-read-degraded');
    expect(notice.testId).not.toBe(unknown.testId);
    expect(notice.label).not.toBe(unknown.label);
    expect(notice.message).not.toBe(unknown.message);
    // It must never borrow the "fr cannot say" register — that sentence belongs
    // to `'unknown'` alone, and here the backend said exactly what happened.
    expect(notice.message).not.toMatch(/cannot say|can(no|')t say|unknown/i);
    // ...and it must not assert the card's position, which this value measures
    // nothing about (migration 134: it "claims nothing about the card at all").
    expect(notice.message).toMatch(/may still be BLOCKED/);
    expect(notice.message).not.toMatch(/did NOT move/);
    // The one honest action, same as every other state here.
    expect(notice.message).toContain(
      'Your decision is already recorded — do not decide this row again.',
    );
    expect(notice.message).not.toMatch(/re-?decide|decide again|try again|resubmit/i);
  });

  it('every notice carries the spent-decision clause verbatim and offers no re-decide', () => {
    // KILLS: dropping the SPENT sentence, or wording the action as "try again".
    // The decision is committed and a second one from the same approver is a
    // 422; the only honest action is to open the card.
    const cases = [
      row({ ...NULLS }),
      row({ ...NULLS, callback_acked_at: '2026-09-20T10:05:00.000Z' }),
      row(),
      row({ ...NULLS, callback_resolution: 'send_exhausted' }),
      row({ ...NULLS, callback_resolution: 'card_unreadable' }),
    ];
    for (const a of cases) {
      const { message } = callbackRowNotice(a)!;
      expect(message).toContain(
        'Your decision is already recorded — do not decide this row again.',
      );
      expect(message).not.toMatch(/re-?decide|decide again|try again|resubmit/i);
    }
  });

  it('the unconfirmed copy is the agreed sentence, exactly', () => {
    expect(callbackRowNotice(row({ ...NULLS }))!.message).toBe(
      'Decided — onward delivery not confirmed; the card may still be BLOCKED. ' +
        'Your decision is already recorded — do not decide this row again. ' +
        'fr retries on its next redelivery tick.',
    );
  });

  it('each rendered state has its own stable test id', () => {
    expect(callbackRowNotice(row({ ...NULLS }))!.testId).toBe('approval-callback-unconfirmed');
    expect(callbackRowNotice(row())!.testId).toBe('approval-callback-unknown');
    expect(
      callbackRowNotice(row({ ...NULLS, callback_acked_at: '2026-09-20T10:05:00.000Z' }))!.testId,
    ).toBe('approval-callback-in-flight');
    expect(
      callbackRowNotice(row({ ...NULLS, callback_resolution: 'send_exhausted' }))!.testId,
    ).toBe('approval-callback-exhausted');
    expect(
      callbackRowNotice(row({ ...NULLS, callback_resolution: 'card_unreadable' }))!.testId,
    ).toBe('approval-callback-unreadable');
    expect(
      callbackRowNotice(row({ ...NULLS, callback_resolution: 'read_degraded' }))!.testId,
    ).toBe('approval-callback-read-degraded');

    // Every rendered state's id is DISTINCT. A copy-paste that gives two states
    // the same testid makes both of the tests above pass and makes DOM
    // assertions select the wrong chip.
    const ids = [
      row({ ...NULLS }),
      row(),
      row({ ...NULLS, callback_acked_at: '2026-09-20T10:05:00.000Z' }),
      row({ ...NULLS, callback_resolution: 'send_exhausted' }),
      row({ ...NULLS, callback_resolution: 'card_unreadable' }),
      row({ ...NULLS, callback_resolution: 'read_degraded' }),
    ].map((a) => callbackRowNotice(a)!.testId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
