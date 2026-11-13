// The gate as the ROUTE calls it — not the pure rule (that is proposal-score.test.ts).
//
// What this proves, and why it is an INTEGRATION test rather than a unit one: the three
// properties that make the gate safe are all wiring, and none of them is visible from the
// pure module:
//
//   1. WITHOUT the flag nothing is touched — every other ask in the estate is unaffected.
//   2. WITH the flag and a judge that cannot answer, the ask is NOT withheld: fail-open is
//      the direction that cannot strand a card, and a silent skip must leave its mark so an
//      outage is distinguishable from a run of passes.
//   3. A caller-supplied `proposal_score` never survives — the row may not assert a verdict
//      that was never reached.
//
// laya is remote and this suite runs without it, which is exactly the requested state: the
// refusal arm needs a real verdict and is verified live, never faked (backend/CLAUDE.md).
import { describe, expect, test } from 'bun:test';

import { assertProposalActionable } from '../../../src/routes/execution-approvals';

const ARGS = { tenantId: '00000000-0000-0000-0000-00000000f002', cardId: 'gate-test-card' };

describe('assertProposalActionable', () => {
  test('no proposal_check: the metadata is left exactly as sent', async () => {
    const metadata: Record<string, unknown> = { proposed_answer: 'Add a regression test for the even-length case.' };
    await assertProposalActionable({ ...ARGS, question: 'What should the agent do?', metadata });
    expect(metadata).toEqual({ proposed_answer: 'Add a regression test for the even-length case.' });
  });

  test('proposal_check without a proposed answer: nothing to judge, nothing written', async () => {
    const metadata: Record<string, unknown> = { proposal_check: 'required' };
    await assertProposalActionable({ ...ARGS, question: 'What should the agent do?', metadata });
    expect(metadata).toEqual({ proposal_check: 'required' });
  });

  test('proposal_check with no judge reachable: FAIL OPEN, and the row records why', async () => {
    // This environment has no laya licence/minter, so scoreProposal answers `available:false`.
    // The route must proceed — a question a human must answer is never withheld on it — and
    // the row must say the ask was minted unscored.
    const metadata: Record<string, unknown> = {
      proposal_check: 'required',
      proposed_answer: 'Add a regression test for the even-length case.',
    };
    await assertProposalActionable({ ...ARGS, question: 'What should the agent do?', metadata });
    const score = metadata.proposal_score as { available?: boolean; reason?: string };
    expect(score.available).toBe(false);
    expect(typeof score.reason).toBe('string');
  });

  test('a caller-supplied verdict never survives the gate', async () => {
    const metadata: Record<string, unknown> = {
      proposal_score: { choice: 'actionable', confidence: 0.99 },
      proposed_answer: 'Something.',
    };
    await assertProposalActionable({ ...ARGS, question: 'Why?', metadata });
    expect('proposal_score' in metadata).toBe(false);
  });
});
