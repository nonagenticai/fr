import { describe, it, expect } from 'vitest';
import { changeSummaryGist, changeSummaryTitle, headlineGist, isSignoffAsk, summaryRepeatsQuestion } from './plan-text';

describe('plan-text', () => {
  it('a single-line summary is returned byte for byte', () => {
    const s = '  we use [object storage] for blobs ';
    expect(changeSummaryGist(s)).toBe(s);
  });

  it('a multi-line plan gives its first non-blank line', () => {
    expect(changeSummaryGist('\n  Please sign off the plan.\n\nPHASE: preliminary')).toBe(
      'Please sign off the plan.',
    );
  });

  it('only ask_kind=signoff is a sign-off ask', () => {
    expect(isSignoffAsk({ metadata: { ask_kind: 'signoff' } })).toBe(true);
    expect(isSignoffAsk({ metadata: { ask_kind: 'question' } })).toBe(false);
    expect(isSignoffAsk({ metadata: null })).toBe(false);
    expect(isSignoffAsk(null)).toBe(false);
    expect(changeSummaryTitle({ metadata: { ask_kind: 'signoff' } })).toBe('Plan for your sign-off');
    expect(changeSummaryTitle({ metadata: {} })).toBe('What changed');
  });

  it('headlineGist: first line, then first sentence, capped', () => {
    expect(headlineGist('Card X stopped because a step failed.\nIt is BLOCKED. What should happen?')).toBe('Card X stopped because a step failed.');
    expect(headlineGist('Card X stopped because a step failed. It is BLOCKED.')).toBe('Card X stopped because a step failed.');
    expect(headlineGist('Which valuation method?')).toBe('Which valuation method?');
    expect(headlineGist('No sentence end here')).toBe('No sentence end here');
    // A too-short "sentence" (e.g. "Q4." or "e.g.") is not a headline on its own.
    expect(headlineGist('Q4. Plan the release of the notes service.')).toBe('Q4. Plan the release of the notes service.');
    const long = 'x'.repeat(400);
    expect(headlineGist(long).length).toBe(160);
    expect(headlineGist(long).endsWith('…')).toBe(true);
  });

  it('summaryRepeatsQuestion: only a pure repeat of a stated question, never a sign-off plan', () => {
    const q = 'Card X stopped.\nWhat should happen?';
    expect(summaryRepeatsQuestion({ change_summary: q, metadata: { open_questions: [q] } })).toBe(true);
    expect(summaryRepeatsQuestion({ change_summary: ' card x stopped. what  should happen? ', metadata: { open_questions: [q] } })).toBe(true);
    expect(summaryRepeatsQuestion({ change_summary: 'What should happen?', metadata: { open_questions: [q] } })).toBe(true);
    expect(summaryRepeatsQuestion({ change_summary: `${q} Logs attached.`, metadata: { open_questions: [q] } })).toBe(false);
    expect(summaryRepeatsQuestion({ change_summary: q, metadata: { ask_kind: 'signoff', open_questions: [q] } })).toBe(false);
    expect(summaryRepeatsQuestion({ change_summary: q, metadata: null })).toBe(false);
    expect(summaryRepeatsQuestion({ change_summary: '', metadata: { open_questions: [q] } })).toBe(false);
  });
});
