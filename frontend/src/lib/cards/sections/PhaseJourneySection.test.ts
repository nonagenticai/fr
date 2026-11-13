// @vitest-environment jsdom
//
// PhaseJourneySection — three states, and the whole point is that they are
// THREE and not two.
//
// The backend now answers `phase_journey: null` when it could not read a card's
// Planka action log, distinct from `[]` (read it, no transitions). Before that
// this component did `journey.length` and would have thrown on null. An
// adversarial review of the PR caught that the new branch had no test at all —
// the component the PR body itself described as "would have crashed on null".

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import PhaseJourneySection from './PhaseJourneySection.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

interface JourneyProps {
  journey: unknown;
  currentListName: string | null;
  blockReasonText?: string | null;
}

function render(props: JourneyProps): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(PhaseJourneySection, {
    target: host,
    props: props as never,
  });
  flushSync();
  return host;
}

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});

describe('PhaseJourneySection', () => {
  it('renders "unavailable" for a null journey — and does not throw', () => {
    // `journey.length` on null is a TypeError; that this mounts at all is half
    // the assertion.
    const el = render({ journey: null, currentListName: 'DOING' });
    expect(el.textContent).toContain('unavailable');
    // It must NOT claim the card has no transitions — that is the other state.
    expect(el.textContent).not.toContain('No list-transition history is available');
  });

  it('renders "no history" for an EMPTY journey — the opposite claim', () => {
    // The control. Without it the assertion above is satisfied by a component
    // that says "unavailable" for both, which would re-merge the two states the
    // backend change exists to separate.
    const el = render({ journey: [], currentListName: 'DOING' });
    expect(el.textContent).toContain('No list-transition history is available');
    expect(el.textContent).not.toContain('unavailable');
  });

  it('renders the transitions when there are some', () => {
    const el = render({
      journey: [
        {
          action_id: 'a1',
          type: 'createCard',
          to_list: 'TODO',
          to_phase: 'READYING',
          from_phase: null,
          at: '2026-09-01T10:00:00Z',
        },
      ],
      currentListName: 'TODO',
    });
    expect(el.textContent).not.toContain('unavailable');
    expect(el.textContent).not.toContain('No list-transition history is available');
  });
});

// UI review 2026-10-07: a BLOCKED step with no recorded reason said nothing.
describe('PhaseJourneySection — BLOCKED step notes', () => {
  const step = (id: string, from: string, to: string) => ({
    action_id: id,
    type: 'moveCard',
    from_list: from,
    to_list: to,
    from_phase: null,
    to_phase: null,
    at: '2026-10-06T00:00:00Z',
  });

  it('says "no reason recorded" next to a BLOCKED step without a reason', () => {
    const el = render({
      journey: [step('a1', 'QA', 'DONE'), step('a2', 'DONE', 'BLOCKED')],
      currentListName: 'BLOCKED',
    });
    const notes = el.querySelectorAll('[data-testid="journey-block-note"]');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain('no reason recorded');
  });

  it('shows the current block reason on the LAST BLOCKED step only', () => {
    const el = render({
      journey: [step('a1', 'DOING', 'BLOCKED'), step('a2', 'BLOCKED', 'DOING'), step('a3', 'DOING', 'BLOCKED')],
      currentListName: 'BLOCKED',
      blockReasonText: 'ci_red:lint',
    });
    const notes = [...el.querySelectorAll('[data-testid="journey-block-note"]')].map((n) => n.textContent?.trim());
    expect(notes).toEqual(['no reason recorded', 'ci_red:lint']);
  });

  it('a PAST BLOCKED step renders its OWN recorded reason; the current step still falls back', () => {
    const el = render({
      journey: [
        { ...step('a1', 'DOING', 'BLOCKED'), block_reason: 'merge_conflict' },
        step('a2', 'BLOCKED', 'DOING'),
        step('a3', 'DOING', 'BLOCKED'),
      ],
      currentListName: 'BLOCKED',
      blockReasonText: 'ci_red:lint',
    });
    const notes = [...el.querySelectorAll('[data-testid="journey-block-note"]')].map((n) => n.textContent?.trim());
    expect(notes).toEqual(['merge_conflict', 'ci_red:lint']);
  });

  it("the current BLOCKED step prefers its own recorded reason over the card's current one", () => {
    const el = render({
      journey: [{ ...step('a1', 'DOING', 'BLOCKED'), block_reason: 'own' }],
      currentListName: 'BLOCKED',
      blockReasonText: 'current',
    });
    const notes = [...el.querySelectorAll('[data-testid="journey-block-note"]')].map((n) => n.textContent?.trim());
    expect(notes).toEqual(['own']);
  });
});
