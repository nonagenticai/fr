// @vitest-environment jsdom
//
// DecisionBar — a QUESTION row carrying `metadata.proposed_answer` (n8n sub.ask_fr).
//
// The owner got a QUESTION approval that showed only free text and could not tell what to
// do. With a proposal the bar shows it above the answer box, "Accept proposed answer" is the
// primary action and sends that text as the answer, a typed answer replaces it, and the
// empty-answer warning (which no longer applies) is not shown.

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import DecisionBar from './DecisionBar.svelte';
import { FIX_ASSERTION_CONTRACT, FIX_ASSERTION_LABEL, proposedAnswerOf } from '$lib/approvals/question';

let app: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;
const decisions: unknown[][] = [];

function render(proposedAnswer: string | null, answerDemand: 'question_action' | 'fix_assertion' = 'question_action') {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(DecisionBar, {
    target: host,
    props: {
      question: 'Answer this question',
      answerRequired: true,
      answerDemand,
      proposedAnswer,
      onDecide: (...args: unknown[]) => decisions.push(args),
    } as never,
  });
  flushSync();
  return host;
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  if (host) host.remove();
  host = null;
  decisions.length = 0;
});

const PROPOSAL = 'Use the fixtures repo';

describe('proposedAnswerOf', () => {
  const Q = { deblock_action: 'QUESTION' };
  it('reads a non-empty string on a QUESTION row, trimmed; anything else is null', () => {
    expect(proposedAnswerOf({ metadata: { ...Q, proposed_answer: `  ${PROPOSAL} ` } })).toBe(PROPOSAL);
    for (const v of [undefined, null, '', '   ', 7]) {
      expect(proposedAnswerOf({ metadata: { ...Q, proposed_answer: v } })).toBeNull();
    }
    expect(proposedAnswerOf({ metadata: null })).toBeNull();
  });

  it('caps the proposal at 2000 characters', () => {
    expect(proposedAnswerOf({ metadata: { ...Q, proposed_answer: 'x'.repeat(2500) } })).toBe('x'.repeat(2000));
  });

  it('a non-QUESTION row ignores proposed_answer (fix assertion, other action, no action)', () => {
    for (const deblock_action of ['INFRASTRUCTURE', 'DEPENDENCY', 'RETRY', undefined]) {
      expect(proposedAnswerOf({ metadata: { deblock_action, proposed_answer: PROPOSAL } })).toBeNull();
    }
  });
});

describe('DecisionBar with a proposed answer', () => {
  it('shows the proposal and no empty-answer warning; Accept sends the proposal', () => {
    const el = render(PROPOSAL);
    const block = el.querySelector('[data-testid="decisionbar-proposed-answer"]');
    expect(block?.textContent).toContain('Proposed answer');
    expect(block?.textContent).toContain(PROPOSAL);
    expect(el.querySelector('[data-testid="decisionbar-answer-refusal"]')).toBeNull();
    expect(el.querySelector('[data-testid="decisionbar-answer-contract"]')).toBeNull();
    expect(el.querySelector('[data-testid="decisionbar-answer-label"]')?.textContent).toBe(
      'Or write a different answer',
    );

    const accept = el.querySelector<HTMLButtonElement>('[data-testid="decisionbar-accept-proposal"]');
    expect(accept?.disabled).toBe(false);
    accept!.click();
    expect(decisions).toEqual([['approve', PROPOSAL, undefined]]);
  });

  it('a typed answer is sent by "Approve with my answer"', () => {
    const el = render(PROPOSAL);
    const box = el.querySelector<HTMLTextAreaElement>('[data-testid="decisionbar-answer-input"]')!;
    box.value = 'Use the main repo';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    const approve = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Approve with my answer'),
    );
    expect(approve?.disabled).toBe(false);
    approve!.click();
    expect(decisions).toEqual([['approve', 'Use the main repo', undefined]]);
  });

  it('a fix-assertion bar ignores a proposal: its contract and label stay, no Accept button', () => {
    const el = render(PROPOSAL, 'fix_assertion');
    expect(el.querySelector('[data-testid="decisionbar-proposed-answer"]')).toBeNull();
    expect(el.querySelector('[data-testid="decisionbar-accept-proposal"]')).toBeNull();
    expect(el.querySelector('[data-testid="decisionbar-answer-contract"]')?.textContent?.trim()).toBe(
      FIX_ASSERTION_CONTRACT,
    );
    expect(el.querySelector('[data-testid="decisionbar-answer-label"]')?.textContent).toBe(FIX_ASSERTION_LABEL);
  });

  it('CONTROL: without a proposal there is no Accept button and the warning shows', () => {
    const el = render(null);
    expect(el.querySelector('[data-testid="decisionbar-proposed-answer"]')).toBeNull();
    expect(el.querySelector('[data-testid="decisionbar-accept-proposal"]')).toBeNull();
    expect(el.querySelector('[data-testid="decisionbar-answer-refusal"]')).not.toBeNull();
  });
});
