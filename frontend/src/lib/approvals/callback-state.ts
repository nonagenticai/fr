// src/lib/approvals/callback-state.ts
//
// ── WHAT THE PERSISTED ROW SAYS HAPPENED DOWNSTREAM, TURNED INTO UI COPY ──
//
// Sibling of `decision-callback.ts`, and deliberately NOT a replacement for it.
// The two answer the same question at two different moments, and only one of
// them survives a page reload:
//
//   decision-callback.ts  reads the decide RESPONSE's `callback.outcome`.
//                         It exists for exactly as long as the toast does.
//   THIS module           reads the three PERSISTED columns on the approval row
//                         (`callback_acked_at`, `callback_resolution`,
//                         `callback_outcome_unknown_at` — backend migrations
//                         113 / 119 / 121, whole-row select at
//                         backend/src/routes/approvals.ts:1593, spread by
//                         `toApprovalResponse` at :754).
//
// ⛔ THE DEFECT. Those three columns have been on the wire for weeks and are
// read by NOTHING in this frontend. So after a refresh — which is how an
// operator actually meets a decided row, hours later, on the queue — an approval
// whose onward n8n callback never acked is BYTE-IDENTICAL to one that moved
// cleanly. Both say `approved`. Both offer no controls, because the decision is
// spent. And one of them still has a card sitting in BLOCKED that nobody is
// coming to move. The transient toast that would have said so was shown once, to
// whoever pressed the button, and is gone.
//
// ⭐ ABSENT ≠ NULL ≠ A VALUE, AND THAT IS THE WHOLE POINT. The `Approval` type
// declares all three fields OPTIONAL **and** NULLABLE for this reason (see its
// comment in `$lib/types/api.ts`): the field MISSING means an fr build that
// predates the column, i.e. nobody can say; the field NULL means this backend
// spoke and there is no answer yet. Collapsing the first into the second invents
// a measurement. Collapsing either into `'moved'` — e.g. via a tempting
// `a.callback_resolution ?? 'moved'` default — reinstates, on the persisted row,
// the exact "reported a success it had not verified" defect the callback
// reporting work exists to end. Hence `'unknown'` and `'unconfirmed'` are two
// different return values and always must be.
//
// ⛔ TONE IS A CORRECTNESS RULE HERE, NOT STYLING. `backend/src/db/schema.ts`
// around line 1119 states it about `callback_outcome_unknown_at` in as many
// words: "AN UNKNOWN IS NOT A FAILURE, AND THE TWO MAKE OPPOSITE CLAIMS ABOUT
// THE RECEIVER." `failed` says the receiver did not take the work; an unknown
// says only that fr stopped listening. 66 rows in 3 days were stamped
// "abandoned" against a receiver that recorded ZERO errored executions in the
// same window. So `'unconfirmed'`, `'in-flight'` and `'unknown'` carry WARNING
// tone and no failure word anywhere in their copy; only `'exhausted'`,
// `'unreadable'` and `'read-degraded'` — the three resolutions the server
// itself calls terminal and bad — may be red.
//
// ⚠️ `'read-degraded'` IS THE ONE THAT LOOKS LIKE A COUNTEREXAMPLE AND IS NOT.
// It reads as "fr could not see the card", which sounds like not-knowing and so
// sounds like it belongs with `'unknown'`. It does not, and conflating the two
// is the exact mistake this module exists to prevent — in the other direction.
// `'unknown'` is THIS BUILD being unable to say; `read_degraded` is the SERVER
// saying, in a value added for the purpose (migration 134, #1104), that it
// retired the row after DEGRADED_STRIKES consecutive answerless reads spanning
// DEGRADED_MIN_SPAN_MS, each charged only on a tick where OTHER cards read
// fine. Nothing further is coming and the decision was never sent on at all,
// because the worker fails CLOSED on a card whose list it cannot establish. That
// is terminal and it needs a human — so red is earned, on a measurement.

import type { Approval } from '$lib/types/api';

/**
 * What the persisted callback columns say about ONE approval row.
 *
 * `'moved'` and `'benign'` are the quiet ones: they are rendered as NOTHING,
 * following the `metadata.deblock_action` precedent on this same row (absent
 * renders no chip rather than a placeholder). A chip that appears on every
 * decided row is a chip nobody reads.
 */
export type CallbackRowState =
  /** The row is not a spent de-block decision, so no onward delivery is owed yet. */
  | 'not-decided'
  /** `callback_resolution === 'moved'` — the card moved. Nothing to say. */
  | 'moved'
  /** `'not_blocked'` or `'hold_acknowledged'` — terminal and fine. Nothing to say. */
  | 'benign'
  /** `'send_exhausted'` — fr gave up retrying. The card is stuck. */
  | 'exhausted'
  /** `'card_unreadable'` — fr could not read the card back. */
  | 'unreadable'
  /**
   * `'read_degraded'` (migration 134, #1104) — fr never established which list
   * the card is in, gave that up after a bounded run of answerless reads, and
   * therefore never sent the decision on at all. ⛔ NOT `'unknown'`: the server
   * said this, in a value minted to say it. NOT `'unreadable'` either, which
   * asserts Planka answered 404 on the card's own read path and is evidence
   * ABOUT THE CARD; this value claims nothing about the card.
   */
  | 'read-degraded'
  /** Acked by n8n, no terminal resolution yet. Transport happened; effect unproven. */
  | 'in-flight'
  /** Decided, and BOTH `callback_acked_at` and `callback_resolution` are NULL. */
  | 'unconfirmed'
  /** The fields are ABSENT (or carry a value this build has never heard of). */
  | 'unknown';

/** Only three states may be red (`exhausted`, `unreadable`, `read-degraded`). See the tone note at the head of this file. */
export type CallbackNoticeTone = 'warning' | 'error';

export interface CallbackRowNotice {
  state: CallbackRowState;
  /** Stable per-state test id, also the chip's `data-testid`. */
  testId: string;
  tone: CallbackNoticeTone;
  /** Short chip text. Never contains a failure word in a `warning` state. */
  label: string;
  /** The full sentence, used as the chip's `title` and as the note body. */
  message: string;
}

/**
 * The SIX members of the `callback_resolution` CHECK constraint, verbatim from
 * `backend/src/db/schema.ts :: approvals_callback_resolution_check` (line ~1345).
 *
 * Listed so a value this build does not recognise — a SEVENTH member added by a
 * later migration — degrades to `'unknown'` rather than being silently treated
 * as "no answer yet". A newer backend we cannot read and an older backend that
 * never wrote the column are the same epistemic state from here: fr cannot say.
 *
 * ⛔ AND THAT DEGRADATION IS A FALLBACK, NEVER A SUBSTITUTE FOR LISTING A VALUE
 * THE BACKEND ACTUALLY WRITES. `read_degraded` (migration 134, #1104) was live
 * in prod and absent from this array, so every retired row rendered
 * `'Delivery unknown'` — "this fr build cannot say what happened". fr could say.
 * The degrade-to-unknown arm made the omission SILENT: no type error, no
 * console warning, no red test, just honest-looking copy that had stopped being
 * true. A graceful fallback hides exactly the drift it was added to survive, so
 * this array is a synchronisation obligation with the CHECK constraint, not a
 * best-effort list. Grep `approvals_callback_resolution_check` before editing.
 */
const KNOWN_RESOLUTIONS = [
  'moved',
  'not_blocked',
  'card_unreadable',
  'send_exhausted',
  'hold_acknowledged',
  'read_degraded',
] as const;

/**
 * ⛔ THE SPENT-DECISION CLAUSE, COPIED VERBATIM FROM
 * `decision-callback.ts :: SPENT` (line 128) — NOT re-worded, and NOT a second
 * opinion about what an operator should do.
 *
 * ⚠️ It is a literal copy because that `const` is module-private and this module
 * must not edit its neighbour. If the sentence there ever changes, change it
 * here in the same commit; the two are one contract. The reason it exists is
 * unchanged: the one thing an operator reading "that did not work" reaches for
 * is the button they just pressed, and on this row the decision IS committed and
 * a second one from the same approver is refused with a 422.
 */
const SPENT = 'Your decision is already recorded — do not decide this row again.';

/**
 * ⛔ WHAT "DECIDED" MEANS HERE, AND WHY IT IS NOT "TERMINAL".
 *
 * The same two statuses `/approvals/[id]/+page.svelte` maps to a decision, and
 * for the reason stated there at length: `'voided'` and `'expired'` are TERMINAL
 * but NON-DECIDING. Nobody chose anything on either — an expiry is machine-
 * written by `backend/src/workers/approval-expiry.ts`, a void is an operator
 * withdrawing an ask that could never have been answered (migration 110). Saying
 * "your decision is already recorded" on a row nobody decided would be a lie of
 * exactly the shape this module exists to stop.
 *
 * `'executing' | 'done' | 'failed'` belong to the E-5 action-approval bus
 * (`backend/src/domain/engagement/action-approvals.ts`), not to the de-block
 * callback, so they owe no onward delivery either. If one of them ever DOES
 * carry a resolution, the resolution branch below reports it before this
 * predicate is consulted — a written value is a measurement, whatever the status
 * column says about it.
 */
function isSpentDecision(a: Approval): boolean {
  return a.status === 'approved' || a.status === 'rejected';
}

function isPresent(a: Approval, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(a as object, key);
}

function nonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Classify one approval row's persisted de-block callback state.
 *
 * Total, defensive and never throws: it runs on every row of a 800-row queue and
 * a malformed payload must degrade to "fr cannot say", never to a blank page.
 */
export function callbackRowState(a: Approval): CallbackRowState {
  // ── 1. A WRITTEN RESOLUTION IS A MEASUREMENT, AND OUTRANKS EVERYTHING ──────
  // Checked BEFORE the status gate on purpose: the value was written by the
  // worker that observed the outcome, so it is true regardless of what this
  // page believes about the row's status. It is also checked before
  // `callback_acked_at`, because an ack is TRANSPORT and a resolution is
  // EFFECT — `'moved'` with a NULL ack is a real and common shape (the
  // redelivery worker resolves rows whose original send never acked), and a
  // chip driven off the ack alone would shout at exactly those rows.
  const resolution = (KNOWN_RESOLUTIONS as readonly string[]).includes(
    a.callback_resolution as string,
  )
    ? (a.callback_resolution as (typeof KNOWN_RESOLUTIONS)[number])
    : null;

  if (resolution === 'moved') return 'moved';
  if (resolution === 'not_blocked' || resolution === 'hold_acknowledged') return 'benign';
  if (resolution === 'send_exhausted') return 'exhausted';
  if (resolution === 'card_unreadable') return 'unreadable';
  // ⛔ ITS OWN STATE, and specifically NOT folded into `'unreadable'` however
  // similar the two chips look. `card_unreadable` says Planka answered 404 on
  // the card's own read path — evidence ABOUT THE CARD — and migration 134's
  // header records that claim being MEASURED FALSE for the dominant population
  // (the card read returned 200 for all 18 stuck rows; the failure was
  // `lists.get`). Mapping `read_degraded` onto it would resurrect the exact
  // conflation `classifyReadFailure`'s `definitivePath` test exists to end, and
  // would make `WHERE callback_resolution='card_unreadable'` stop meaning what
  // its own column comment says.
  if (resolution === 'read_degraded') return 'read-degraded';

  // A non-null value we do not recognise: a later migration's SEVENTH member.
  // Not "no answer yet" — there IS an answer and this build cannot read it.
  if (a.callback_resolution != null && resolution === null) return 'unknown';

  // ── 2. NO TERMINAL ANSWER. DOES THE QUESTION EVEN ARISE? ──────────────────
  // Onward delivery is owed only once a decision is spent. A pending row has
  // nothing in flight, so it gets no chip — on an old backend as much as a new
  // one, which is why this precedes the absent/NULL split below.
  if (!isSpentDecision(a)) return 'not-decided';

  // ── 3. ABSENT vs NULL. THE DISTINCTION THIS MODULE EXISTS FOR ─────────────
  const reported =
    isPresent(a, 'callback_acked_at') ||
    isPresent(a, 'callback_resolution') ||
    isPresent(a, 'callback_outcome_unknown_at');
  if (!reported) return 'unknown';

  // Acked, not yet resolved. Transport succeeded; whether the card moved is
  // still open, so this is a warning, not a success.
  if (nonEmptyString(a.callback_acked_at)) return 'in-flight';

  // Decided, the backend spoke, and it has nothing: no ack and no resolution.
  // `callback_outcome_unknown_at` being stamped lands HERE by design — it is an
  // epistemic marker, explicitly "NOT AN ENDING" (schema.ts ~1119), and mapping
  // it to the error branch would assert a receiver refusal nobody measured.
  return 'unconfirmed';
}

/**
 * The renderable notice for a row, or `null` when there is nothing honest to say.
 *
 * `null` for `'not-decided'`, `'moved'` and `'benign'` — the absent-renders-
 * nothing precedent, so a chip's PRESENCE is itself the signal.
 *
 * ⛔ NO STATE OFFERS "DECIDE AGAIN". The only action any of these copy lines
 * points at is OPENING THE CARD. The decision is spent; a retry affordance here
 * would invite the 422 and, worse, teach the operator that the row is retakeable.
 */
export function callbackRowNotice(a: Approval): CallbackRowNotice | null {
  const state = callbackRowState(a);

  switch (state) {
    case 'not-decided':
    case 'moved':
    case 'benign':
      return null;

    case 'unconfirmed':
      return {
        state,
        testId: 'approval-callback-unconfirmed',
        tone: 'warning',
        label: 'Delivery unconfirmed',
        message:
          'Decided — onward delivery not confirmed; the card may still be BLOCKED. ' +
          `${SPENT} fr retries on its next redelivery tick.`,
      };

    case 'in-flight':
      // ⛔ WARNING, NOT SUCCESS. An ack is n8n saying "received", which is
      // transport; the card move is the effect and is still unproven. A green
      // "delivered" here is the original defect with a nicer column behind it.
      return {
        state,
        testId: 'approval-callback-in-flight',
        tone: 'warning',
        label: 'Delivery in flight',
        message:
          'Decided — fr delivered the decision and n8n acknowledged it, but the card move is ' +
          `not confirmed yet, so the card may still be BLOCKED. ${SPENT} Open the card to see ` +
          'where it is.',
      };

    case 'unknown':
      // ⛔ WARNING, NOT ERROR, AND NO FAILURE WORD. "This build cannot say" is
      // not "this failed". The phrasing covers BOTH directions of unreadable:
      // an older fr that never wrote the columns, and a newer one whose
      // resolution value this bundle has never heard of.
      return {
        state,
        testId: 'approval-callback-unknown',
        tone: 'warning',
        label: 'Delivery unknown',
        message:
          'Decided — this fr build cannot say what happened to the onward delivery, so ' +
          `whether the card moved is unknown and it may still be BLOCKED. ${SPENT} Open the ` +
          'card to see where it is.',
      };

    case 'exhausted':
      // Red is EARNED here: `send_exhausted` is the server's own terminal
      // statement that it stopped retrying. Nothing further is coming.
      return {
        state,
        testId: 'approval-callback-exhausted',
        tone: 'error',
        label: 'Delivery exhausted',
        message:
          'Decided — fr stopped retrying the onward delivery, so the card did NOT move and ' +
          `stays BLOCKED. ${SPENT} Open the card; it needs moving by hand.`,
      };

    case 'read-degraded':
      // ⭐ RED, AND THE COPY'S JOB IS TO BE THREE THINGS AT ONCE: not a
      // completion, not a genuine unknown, and not a claim about the card.
      //   * NOT A COMPLETION — `read_degraded` stamps no `callback_delivered_at`
      //     (that is `moved`'s alone, migration 113) and the decision was never
      //     sent for even once, because the worker fails closed on a card whose
      //     list it cannot establish. So the chip is present and red where a
      //     clean `moved` renders nothing at all: the visible difference IS the
      //     point of #1104.
      //   * NOT AN UNKNOWN — the sentence says what fr measured and who
      //     measured it, and deliberately never says "fr cannot say". That
      //     phrasing belongs to `'unknown'` and only there.
      //   * NOT A CLAIM ABOUT THE CARD — "fr can no longer see this card" and
      //     "it may still be BLOCKED", the hedged form. Migration 134 is
      //     explicit that this value claims nothing about the card at all, so
      //     "the card did NOT move and stays BLOCKED" (the honest sentence for
      //     `exhausted`, where the sends were real) would be a lie here.
      return {
        state,
        testId: 'approval-callback-read-degraded',
        tone: 'error',
        label: 'Card no longer visible to fr',
        message:
          'Decided — fr could not establish which list this card is in, on repeated reads over ' +
          'hours, while it was reading other cards on the same board fine. It has stopped ' +
          'looking and retired the row, and it never sent the decision onward at all, so the ' +
          'card may still be BLOCKED. This is what fr measured, not a gap in what this build ' +
          `can read. ${SPENT} Open the card and move it by hand.`,
      };

    case 'unreadable':
      return {
        state,
        testId: 'approval-callback-unreadable',
        tone: 'error',
        label: 'Card unreadable',
        message:
          'Decided — fr could not read the card back, so it did NOT move it and the card may ' +
          `still be BLOCKED. ${SPENT} Open the card and move it by hand.`,
      };
  }
}

/**
 * Tailwind classes for the chip/note border+fill.
 *
 * ⚠️ NOT A NEW VISUAL LANGUAGE, and deliberately byte-identical to the two
 * branches of `routes/approvals/+page.svelte :: noticeToneClass` (line ~427) —
 * the same palettes the `deblock_action` hold chip and the bulk-error banner
 * already use. The queue page calls ITS OWN helper rather than this one, because
 * reusing the existing function is a stronger guarantee of one palette than
 * copying its strings; this export exists for `/approvals/[id]`, which has no
 * such local helper and must not grow a third copy.
 */
export function callbackToneClasses(tone: CallbackNoticeTone): string {
  return tone === 'error'
    ? 'border-[var(--color-danger)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
    : 'border-[var(--color-warning)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
}
