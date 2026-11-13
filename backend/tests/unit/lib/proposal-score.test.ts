// A conveyor's PROPOSED ANSWER is judged before a person reads it (George 2026-11-01).
//
// These pin the pure half: the request built for laya and the rule over its answers. The
// transport is remote and is verified live against the running bridge, never faked
// (backend/CLAUDE.md: no test doubles).
//
// ⛔ What is NOT asserted here, on purpose: that laya can tell a TRUE claim from a false one.
// Measured 2026-11-01 it called a proposal resting on a false tool claim "grounded" at 0.70.
// The judge covers ACTIONABILITY; truthfulness is a prompt rule on the coach.
import { describe, expect, test } from 'bun:test';

import {
  PROPOSAL_CRITERIA,
  buildProposalScoreRequest,
  decideProposalGate,
  readProposalScore,
} from '../../../src/lib/proposal-score';

describe('buildProposalScoreRequest', () => {
  const req = buildProposalScoreRequest({
    question: 'The UML tool rejected the fragment with 422. What should I do?',
    proposal: 'Send parameters as objects {id,name,parameters:[{id,name}]} and retry once.',
  }) as unknown as {
    model: string;
    state: { question: string; proposal: string };
    questions: { choice: { type: string; criteria: Record<string, string> } };
  };

  test('one choice question with exactly the two sides of the judgement', () => {
    expect(req.questions.choice.type).toBe('choice');
    expect(Object.keys(req.questions.choice.criteria).sort()).toEqual(['actionable', 'vague']);
    // The meaning laya reads, not the constant compared with itself.
    expect(req.questions.choice.criteria.actionable).toContain('concrete next step');
    expect(req.questions.choice.criteria.vague).toContain('restates the problem');
  });

  test('the question and the proposal travel in the state, under their own names', () => {
    expect(req.state.question).toContain('rejected the fragment');
    expect(req.state.proposal).toContain('parameters as objects');
  });

  test('both texts are capped, so one runaway proposal cannot crowd out the question', () => {
    const big = buildProposalScoreRequest({ question: 'q'.repeat(5_000), proposal: 'p'.repeat(5_000) }) as unknown as {
      state: { question: string; proposal: string };
    };
    expect(big.state.question.length).toBe(2_000);
    expect(big.state.proposal.length).toBe(2_000);
  });
});

describe('readProposalScore', () => {
  const ans = (choice: string, confidence: number) => ({ choice: { choice, confidence } });

  test('a confident actionable answer passes', () => {
    const out = readProposalScore(ans('actionable', 0.76));
    expect(out).toMatchObject({ available: true, choice: 'actionable', confidence: 0.76, pass: true });
  });

  test('exactly at the shared 0.5 floor passes — the floor is inclusive', () => {
    expect(readProposalScore(ans('actionable', 0.5))).toMatchObject({ pass: true });
  });

  test('an actionable answer under the floor does NOT pass, and says what to fix', () => {
    const out = readProposalScore(ans('actionable', 0.49));
    expect(out).toMatchObject({ available: true, choice: 'vague', pass: false });
    if (out.available) expect(out.feedback).toContain('concrete');
  });

  test('a confident vague answer does not pass and names the missing next step', () => {
    const out = readProposalScore(ans('vague', 0.66));
    expect(out).toMatchObject({ available: true, choice: 'vague', confidence: 0.66, pass: false });
    if (out.available) expect(out.feedback).toContain('name the file');
  });

  test('an option we did not offer never passes, whatever its confidence', () => {
    const out = readProposalScore(ans('excellent', 0.99));
    expect(out).toMatchObject({ available: true, choice: 'vague', pass: false });
  });

  test('the three measured 2026-11-01 shapes land where the gate expects them', () => {
    // From the live bridge: a specific proposal 0.756, a concrete-but-unverified one 0.160,
    // a vague one 0.072 (laya names `actionable` in every case; the margin is the signal).
    expect(readProposalScore(ans('actionable', 0.756))).toMatchObject({ pass: true });
    expect(readProposalScore(ans('actionable', 0.160))).toMatchObject({ pass: false });
    expect(readProposalScore(ans('actionable', 0.072))).toMatchObject({ pass: false });
  });

  test('unparseable answers are unavailable, never a pass', () => {
    expect(readProposalScore(undefined)).toEqual({ available: false, reason: 'unparseable_answers' });
    expect(readProposalScore({})).toEqual({ available: false, reason: 'unparseable_answers' });
    expect(readProposalScore({ choice: { choice: 'actionable', confidence: 'high' } })).toEqual({
      available: false,
      reason: 'unparseable_answers',
    });
    expect(readProposalScore({ choice: { confidence: 0.8 } })).toEqual({
      available: false,
      reason: 'unparseable_answers',
    });
  });

  test('decideProposalGate: unavailable and pass both PROCEED, only a real non-pass refuses', () => {
    // The whole gate, pinned without a transport: this is what the route branches on.
    expect(decideProposalGate({ available: false, reason: 'http_503' })).toEqual({ action: 'proceed', recorded: null });
    expect(decideProposalGate(readProposalScore(ans('actionable', 0.8)))).toEqual({
      action: 'proceed',
      recorded: { choice: 'actionable', confidence: 0.8 },
    });
    const refused = decideProposalGate(readProposalScore(ans('vague', 0.7)));
    expect(refused.action).toBe('refuse');
    if (refused.action === 'refuse') expect(refused.feedback).toContain('name the file');
    // An unsure score also refuses: the measured 0.16 case is a proposal that could not be
    // shown actionable, and the caller's fallback (n8n re-asks without the check) makes that
    // safe rather than stranded.
    expect(decideProposalGate(readProposalScore(ans('actionable', 0.16))).action).toBe('refuse');
  });

  test('NaN confidence is unavailable, not a numeric comparison', () => {
    expect(readProposalScore({ choice: { choice: 'actionable', confidence: Number.NaN } })).toEqual({
      available: false,
      reason: 'unparseable_answers',
    });
  });
});
