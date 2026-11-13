// @vitest-environment jsdom
//
// DecisionBar — the line that OUTLIVES the toast must not assert a card move
// that never happened.
//
// ⛔ THE DEFECT, found one layer below the toast fix by an adversarial audit.
// `a61f192c` made every decision surface report the callback outcome, and the
// failure case raises a red toast. But that toast expires after ~12s, and this
// component kept rendering `decided.message` — the INTENT of the decision
// ("Approved — the system advances the phase.") — regardless of what actually
// happened. Once the toast was gone, the only text left on screen asserted the
// card had moved.
//
// ⭐ A correction that expires is worse than no correction: it is a true
// statement replaced, on a timer, by a false one, with no further input.
//
// The distinction under test is `decided.message` (what the decision MEANT) vs
// `decided.notice.message` (what actually HAPPENED).
//
// ⚠️ MY FIRST VERSION OF THIS FILE ASSERTED THE WRONG PROPERTY and went red
// against a correct implementation. I asserted the intent sentence was GONE.
// It is not, by design: `decisionNotice` LEADS with the decision line and then
// corrects it, so the operator reads what they decided AND what became of it.
// Erasing the intent would be over-correction. The property is that the
// correction is PRESENT and the bar is the notice — not that the intent is
// absent.

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DecisionBar from './DecisionBar.svelte';
import { decisionNotice } from '$lib/approvals/decision-callback';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

function render(decided: unknown) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(DecisionBar, { target: host, props: { decided } as never });
  flushSync();
  return host;
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  if (host) host.remove();
  host = null;
});

const INTENT = 'Approved — the system advances the phase.';

describe('DecisionBar — the persistent line reports delivery, not intent', () => {
  it('⛔ a FAILED callback does NOT leave the card-moved claim on screen', () => {
    const notice = decisionNotice(INTENT, { callback: { outcome: 'failed', reason: '504' } });
    const el = render({ kind: 'approve', message: INTENT, notice });

    const bar = el.querySelector('[data-testid="decisionbar-outcome"]');
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute('data-delivered')).toBe('false');
    // The property that matters: what is on screen is the NOTICE, and it states
    // the card did not move. The pre-fix render was `decided.message` alone,
    // which is a strict prefix of this and carries no correction — so asserting
    // strict equality with the notice is what separates the two.
    expect(bar!.textContent).toBe(notice.message);
    expect(bar!.textContent).toContain('has not moved');
    expect(bar!.textContent).not.toBe(INTENT);
  });

  it('a REFUSED receiver is likewise not presented as a completed move', () => {
    const notice = decisionNotice(INTENT, {
      callback: { outcome: 'skipped-unsupported-receiver' },
    });
    const el = render({ kind: 'approve', message: INTENT, notice });
    const bar = el.querySelector('[data-testid="decisionbar-outcome"]')!;

    expect(bar.getAttribute('data-delivered')).toBe('false');
    expect(bar.textContent).toBe(notice.message);
    expect(bar.textContent).not.toBe(INTENT);
  });

  it('a DELIVERED callback still shows the decision line — no over-correction', () => {
    const notice = decisionNotice(INTENT, { callback: { outcome: 'sent' } });
    const el = render({ kind: 'approve', message: INTENT, notice });
    const bar = el.querySelector('[data-testid="decisionbar-outcome"]')!;

    expect(bar.getAttribute('data-delivered')).toBe('true');
    expect(bar.textContent).toContain(INTENT);
  });

  it('NO notice at all reads as unobserved, and keeps the plain line', () => {
    // First render derives `decided` from the row's stored status; nobody
    // observed a callback, so there is nothing truthful to say about one.
    const el = render({ kind: 'approve', message: 'Approved.' });
    const bar = el.querySelector('[data-testid="decisionbar-outcome"]')!;

    expect(bar.getAttribute('data-delivered')).toBe('unobserved');
    expect(bar.textContent).toContain('Approved.');
  });
});
