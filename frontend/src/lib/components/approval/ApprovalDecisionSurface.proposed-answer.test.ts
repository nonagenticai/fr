// @vitest-environment jsdom
//
// ApprovalDecisionSurface + `metadata.proposed_answer` (fr#1687 review finding 2).
//
// The surface is the ONE place all three web decision surfaces learn that a QUESTION row
// carries a proposed answer: it derives it from the WHOLE row (`proposedAnswerOf(approval)`)
// and forwards it to `DecisionBar`. `DecisionBar.proposed-answer.test.ts` mounts the BAR
// directly and hands it a `proposedAnswer` prop, so deleting the surface's derivation left
// every test green — the wiring this component exists to own was untested.
//
// This file mounts the real surface with a real `Approval` row and asserts what the bar
// renders and what a click sends. The CONTROL proves the assertion is about the row: the
// same surface with no `proposed_answer` shows no proposal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ApprovalDecisionSurface from './ApprovalDecisionSurface.svelte';
import type { Approval } from '$lib/types/api';

const T = '0195f48b-d000-7000-8000-0000000001a1';
const PROPOSAL = 'Use the fixtures repo';

let host: HTMLDivElement;
let app: ReturnType<typeof mount> | null = null;
const decisions: unknown[][] = [];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host.remove();
  decisions.length = 0;
});

function row(metadata: Record<string, unknown>): Approval {
  return {
    id: 'a-1687',
    project_id: 'p1',
    tenant_id: T,
    requester_id: 'owner',
    source: 'n8n',
    status: 'pending',
    description: 'Which repo?',
    created_at: new Date().toISOString(),
    expires_at: null,
    required_approvers: [{ user_id: 'ghost', role: 'execution_signoff' }],
    decisions: [],
    metadata,
  } as unknown as Approval;
}

function render(metadata: Record<string, unknown>): void {
  app = mount(ApprovalDecisionSurface, {
    target: host,
    props: {
      approval: row(metadata),
      // A member of the row's own workspace: `canAct` is true, so the bar mounts.
      user: { id: 'member', roles: [], tenant_id: T },
      onDecide: (...args: unknown[]) => decisions.push(args),
    } as never,
  });
  flushSync();
}

const QUESTION = { deblock_action: 'QUESTION', open_questions: ['Which repo?'] };

describe('ApprovalDecisionSurface derives the proposal from the row', () => {
  it('shows it on the bar and Accept sends THAT text', () => {
    render({ ...QUESTION, proposed_answer: PROPOSAL });
    const block = host.querySelector('[data-testid="decisionbar-proposed-answer"]');
    expect(block?.textContent).toContain('Proposed answer');
    expect(block?.textContent).toContain(PROPOSAL);
    // The proposal satisfies the answer demand, so the cannot-be-empty warning is gone.
    expect(host.querySelector('[data-testid="decisionbar-answer-refusal"]')).toBeNull();

    const accept = host.querySelector<HTMLButtonElement>('[data-testid="decisionbar-accept-proposal"]');
    expect(accept?.disabled).toBe(false);
    accept!.click();
    expect(decisions).toEqual([['approve', PROPOSAL, undefined]]);
  });

  it('CONTROL: the same row without proposed_answer shows no proposal and keeps the warning', () => {
    render({ ...QUESTION });
    expect(host.querySelector('[data-testid="decisionbar-proposed-answer"]')).toBeNull();
    expect(host.querySelector('[data-testid="decisionbar-accept-proposal"]')).toBeNull();
    expect(host.querySelector('[data-testid="decisionbar-answer-refusal"]')).not.toBeNull();
  });
});
