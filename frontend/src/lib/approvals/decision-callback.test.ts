// src/lib/approvals/decision-callback.test.ts
//
// ⛔ THE DEFECT UNDER TEST. Every decision surface printed an unconditional
// `toast.success('Decision recorded.')` and never read `callback.outcome` from
// the decide response — `grep -rn "callback\.outcome" frontend/src` returned
// ZERO hits while the server had been reporting that field for exactly this
// purpose. An operator whose decision was recorded and whose callback FAILED
// (card never leaves BLOCKED, decision spent and not retakeable) saw green.
//
// ⭐ SO THE ASSERTION THAT MATTERS IS THE TONE, NOT THE TEXT. A test that only
// checked "the message mentions the outcome" would pass on an implementation
// that appended the code to a still-green success toast — which is the same lie
// with a footnote. Every case below pins `tone` and `delivered`, and the
// non-delivered cases additionally pin that the operator is told the decision is
// already spent (the one thing that stops them resubmitting into a 422).

import { describe, it, expect } from 'vitest';
import {
  decisionNotice,
  readDecisionCallback,
  type DecisionCallbackOutcome,
} from './decision-callback';

const LINE = 'Approved — the system advances the phase.';
const body = (outcome: string, reason?: string) => ({
  id: 'a-1',
  status: 'approved',
  approval_complete: true,
  callback: { outcome, ...(reason ? { reason } : {}) },
});

describe('decisionNotice — a delivered callback is the ONLY success', () => {
  it('sent → success, delivered, and says the card moves on', () => {
    const n = decisionNotice(LINE, body('sent'));
    expect(n.delivered).toBe(true);
    expect(n.tone).toBe('success');
    expect(n.state).toBe('sent');
    expect(n.message).toContain(LINE);
    expect(n.message).toMatch(/delivered/i);
  });

  // The negative control for the case above: if `delivered` were hardcoded true,
  // or the tone were computed from the HTTP status rather than the outcome,
  // every row below would still read `success`.
  const NEVER_A_SUCCESS: DecisionCallbackOutcome[] = [
    'failed',
    'skipped-unsupported-receiver',
    'skipped-not-found',
    'pending',
    'not-attempted',
    'skipped-no-callback-path',
    'timeout-unknown',
  ];
  it.each(NEVER_A_SUCCESS)('%s → NOT a success toast', (outcome) => {
    const n = decisionNotice(LINE, body(outcome));
    expect(n.delivered).toBe(false);
    expect(n.tone).not.toBe('success');
    expect(n.state).toBe(outcome);
  });
});

describe('decisionNotice — a refused or failed callback names the consequence', () => {
  it('failed → error tone, says the card has not moved, and carries the reason', () => {
    const n = decisionNotice(LINE, body('failed', 'connect ETIMEDOUT 10.0.0.4:5678'));
    expect(n.tone).toBe('error');
    expect(n.message).toMatch(/not moved|stays blocked/i);
    expect(n.message).toContain('connect ETIMEDOUT 10.0.0.4:5678');
    // The clause that stops the operator spending a second decision the server
    // will 422. Its absence is the difference between a warning and a trap.
    expect(n.message).toMatch(/do not decide this row again/i);
  });

  it('skipped-unsupported-receiver → error tone, names the receiver as the cause', () => {
    const n = decisionNotice(LINE, body('skipped-unsupported-receiver'));
    expect(n.tone).toBe('error');
    expect(n.message).toMatch(/receiver/i);
    expect(n.message).toMatch(/not moved|stays blocked/i);
    expect(n.message).toMatch(/do not decide this row again/i);
  });

  it('pending → warning, and says the outcome is UNKNOWN rather than bad', () => {
    const n = decisionNotice(LINE, body('pending'));
    expect(n.tone).toBe('warning');
    expect(n.message).toMatch(/does not yet know|unknown/i);
    expect(n.message).toMatch(/do not decide this row again/i);
  });

  it('not-attempted → info, and explains that the approval is not complete yet', () => {
    // ⚠️ NOT an error. Nothing failed: this decision simply did not complete the
    // approval, so no callback was owed. Rendering it red would train operators
    // to ignore the red.
    const n = decisionNotice(LINE, body('not-attempted'));
    expect(n.tone).toBe('info');
    expect(n.message).toMatch(/not complete yet|another required approver/i);
  });

  it('skipped-no-callback-path → info, and says no card will move', () => {
    const n = decisionNotice(LINE, body('skipped-no-callback-path'));
    expect(n.tone).toBe('info');
    expect(n.message).toMatch(/no callback path/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `timeout-unknown` — A TIMEOUT IS NOT A REFUSAL.
//
// ⛔ THE DEFECT. fr stopping its wait before n8n answers used to land on the
// `failed` branch: a red "The callback to n8n FAILED, so the card has not moved"
// — stated as fact about something NOBODY MEASURED. The request may well have
// been received and the work completed; `callback_acked_at` stays NULL and the
// redelivery worker still reconciles the row. That is the same "reported a
// result it had not verified" shape this whole module exists to end, with the
// sign flipped, and it sends the operator to move a card by hand that may have
// already moved.
//
// ⭐ THE ASSERTION THAT DISCRIMINATES IS THE **PAIR**, NOT THE TONE ALONE. Before
// this change `timeout-unknown` was not in KNOWN_OUTCOMES at all, so it fell to
// `unrecognised` — which ALSO returns `warning` + `delivered:false`. A test that
// pinned only tone and delivered would pass against BOTH the old and the new
// code. `state` is what separates them, and the inequality with `failed` is what
// the change is actually for, so it is asserted from both ends.
// ─────────────────────────────────────────────────────────────────────────────
describe('decisionNotice — a timeout is UNKNOWN, never a failure', () => {
  it('timeout-unknown → delivered false, tone warning, and explicitly NOT error', () => {
    const n = decisionNotice(LINE, body('timeout-unknown'));

    // The narrowing half: the old build had no such outcome and reported
    // `unrecognised` here, naming the raw string as something it did not know.
    expect(n.state).toBe('timeout-unknown');
    expect(n.message).not.toMatch(/does not recognise/i);

    expect(n.delivered).toBe(false);
    expect(n.tone).toBe('warning');
    // ⛔ Stated as an inequality too: a build that routed the timeout through the
    // `failed` case satisfies neither, and this is the line that says why.
    expect(n.tone).not.toBe('error');

    expect(n.message).toContain(LINE);
    expect(n.message).toMatch(/UNKNOWN/);
    expect(n.message).toMatch(/stopped waiting/i);
    // Not a failure claim, in the copy as well as in the tone.
    expect(n.message).not.toMatch(/FAILED/);
    // And still the spent-decision clause — the outcome is unknown, the decision
    // is not: a second attempt 422s.
    expect(n.message).toMatch(/do not decide this row again/i);
    // It must point the operator at the card rather than at the button.
    expect(n.message).toMatch(/redelivery tick/i);
  });

  it('CONTROL — `failed` is STILL an error, so the two outcomes are not merged', () => {
    // ⭐ The discriminating half. Without it, "make every non-sent outcome a
    // warning" passes the case above while silently downgrading a REAL,
    // observed callback refusal to a soft note.
    const f = decisionNotice(LINE, body('failed', 'connect ECONNREFUSED'));
    expect(f.state).toBe('failed');
    expect(f.tone).toBe('error');
    expect(f.message).toMatch(/FAILED/);
    expect(f.message).toMatch(/stays blocked/i);

    const t = decisionNotice(LINE, body('timeout-unknown'));
    expect(t.tone).not.toBe(f.tone);
    expect(t.state).not.toBe(f.state);
    expect(t.message).not.toBe(f.message);
  });

  it('both are equally NOT deliveries — the difference is certainty, not success', () => {
    for (const outcome of ['timeout-unknown', 'failed'] as const) {
      const n = decisionNotice(LINE, body(outcome));
      expect(n.delivered).toBe(false);
      expect(n.tone).not.toBe('success');
    }
    // CONTROL for that loop: `sent` is the one value that IS a delivery, so the
    // assertions above are not vacuously true of every outcome.
    expect(decisionNotice(LINE, body('sent')).delivered).toBe(true);
  });

  it('readDecisionCallback treats it as KNOWN, not as an unrecognised string', () => {
    // The narrowing is where the old build differed; pinned directly rather than
    // only through the notice.
    expect(readDecisionCallback(body('timeout-unknown'))).toEqual({ outcome: 'timeout-unknown' });
    // CONTROL — a genuinely unknown string still falls through to `unrecognised`,
    // so the case above is not "KNOWN_OUTCOMES now admits everything".
    expect(readDecisionCallback(body('timeout-unknowable'))).toEqual({
      outcome: 'unrecognised',
      raw: 'timeout-unknowable',
    });
  });
});

describe('decisionNotice — an absent or unknown callback is NOT swallowed', () => {
  // The chosen default, pinned. An older fr, or a response shape this build does
  // not understand, must not produce a success claim: "reported a success it had
  // not verified" is the whole defect. `warning`, not `error`, because nothing
  // observed has actually failed.
  it.each([
    ['a body with no callback field', { id: 'a-1', status: 'approved' }],
    ['a null body', null],
    ['a non-object body', 'approved'],
    ['a callback that is not an object', { callback: 'sent' }],
    ['a callback with no outcome', { callback: {} }],
    ['a callback whose outcome is not a string', { callback: { outcome: 7 } }],
  ])('%s → warning, never success', (_label, response) => {
    const n = decisionNotice(LINE, response);
    expect(n.delivered).toBe(false);
    expect(n.tone).toBe('warning');
    expect(n.state).toBe('absent');
    expect(n.message).toMatch(/did not report|unknown/i);
    expect(n.message).toMatch(/do not decide this row again/i);
  });

  it('an outcome string this build has never seen is named, not assumed benign', () => {
    const n = decisionNotice(LINE, body('skipped-quantum-receiver'));
    expect(n.delivered).toBe(false);
    expect(n.tone).toBe('warning');
    expect(n.state).toBe('unrecognised');
    // Naming the raw value is what makes a server-side union change debuggable
    // instead of silently mapping to "fine".
    expect(n.message).toContain('skipped-quantum-receiver');
  });

  it('never throws — it runs after a committed decision', () => {
    // A parse error here must not become a thrown "failure" the operator would
    // try to resubmit; the decision is already durable at this point.
    expect(() => decisionNotice(LINE, undefined)).not.toThrow();
    expect(() => decisionNotice(LINE, [])).not.toThrow();
  });
});

describe('readDecisionCallback', () => {
  it('passes a trimmed reason through only when it carries text', () => {
    expect(readDecisionCallback(body('failed', '  504 from n8n  '))).toEqual({
      outcome: 'failed',
      reason: '504 from n8n',
    });
    expect(readDecisionCallback(body('failed', '   '))).toEqual({ outcome: 'failed' });
  });
});
