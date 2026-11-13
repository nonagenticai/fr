// tests/unit/domain/engagement/adapters/teams-adapter.test.ts
//
// The Teams approval card for a QUESTION row carrying `metadata.proposed_answer`.
// teams-webhook fills that proposal when the card's Approve button posts (the button sends
// no comment — withProposedAnswer), so the card must SHOW the proposal and the line saying
// a plain approve accepts it. The button body is run through the webhook's real schema.
// The card's text is the SAME notification every channel sends (approval-menu.ts).
import { test, expect, describe } from 'bun:test';
import { TeamsAdapter } from '../../../../../src/domain/engagement/adapters/teams';
import { PROPOSED_ANSWER_NOTE, withProposedAnswer } from '../../../../../src/domain/engagement/deblock-actions';
import { TeamsActionSchema } from '../../../../../src/routes/teams-webhook';
import { approvalNotificationText } from '../../../../../src/domain/engagement/approval-menu';

type Approval = Parameters<TeamsAdapter['send']>[0];
type Card = { attachments: { content: { body: { text: string }[]; actions: { title: string; body: string }[] } }[] };

const ID = '123e4567-e89b-12d3-a456-426614174000';

function approval(metadata: Record<string, unknown> | null): Approval {
  return {
    id: ID, project_id: null, description: '[n8n] Which repo?', card_id: null, callback_path: null,
    source: null, metadata, status: 'pending', expires_at: new Date(), requester_id: null,
  } as Approval;
}

const adapter = new TeamsAdapter();
const buildCard = async (a: Approval) => (await adapter['buildAdaptiveCard'](a)) as unknown as Card;
const texts = (c: Card) => c.attachments[0]!.content.body.map((b) => b.text);
const allText = (c: Card) => texts(c).join('\n');
const approveBody = (c: Card) =>
  TeamsActionSchema.parse(JSON.parse(c.attachments[0]!.content.actions.find((a) => a.title === 'Approve')!.body));

describe('TeamsAdapter approval card — proposed answer', () => {
  test('a QUESTION row shows the proposal and the note; its Approve button then records the proposal', async () => {
    const metadata = { deblock_action: 'QUESTION', proposed_answer: 'Use the fixtures repo' };
    const card = await buildCard(approval(metadata));
    expect(allText(card)).toContain('Use the fixtures repo');
    expect(allText(card)).toContain(PROPOSED_ANSWER_NOTE);
    const posted = approveBody(card);
    expect(posted).toEqual({ approvalId: ID, decision: 'approved' });
    expect(withProposedAnswer({ decision: posted.decision, comment: posted.comment, metadata })).toBe('Use the fixtures repo');
  });

  test('CONTROL: a non-QUESTION row (or none) with proposed_answer shows no proposal and Approve fills nothing', async () => {
    for (const deblock_action of ['INFRASTRUCTURE', 'DEPENDENCY', undefined]) {
      const metadata = { deblock_action, proposed_answer: 'Use the fixtures repo' };
      const card = await buildCard(approval(metadata));
      expect(allText(card)).not.toContain('Use the fixtures repo');
      expect(allText(card)).not.toContain(PROPOSED_ANSWER_NOTE);
      const posted = approveBody(card);
      expect(withProposedAnswer({ decision: posted.decision, comment: posted.comment, metadata })).toBeUndefined();
    }
  });

  test('the card text is the shared notification: description, the numbered menu, the tag', async () => {
    const a = approval({ deblock_action: 'QUESTION' });
    const text = await approvalNotificationText(a, 'teams');
    expect(texts(await buildCard(a))).toEqual(['Approval Required', text]);
    expect(text).toContain('Which repo?');
    expect(text).toContain('1 - Approve');
    expect(text).toContain(`[ApprovalId:${ID}]`);
  });
});
