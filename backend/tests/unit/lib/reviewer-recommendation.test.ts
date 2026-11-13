// Tests for extractReviewerRecommendation — structured field first, prose fallback,
// fail closed on a contradiction.
import { test, expect, describe } from 'bun:test';
import { extractReviewerRecommendation } from '../../../src/lib/reviewer-recommendation';

const sentence = (rec: string) =>
  `The reviewer recommends "${rec}". Approve with "yes" to accept that, or state what to do instead.`;

describe('extractReviewerRecommendation', () => {
  test('structured field alone is read and case-normalised', () => {
    expect(extractReviewerRecommendation({ reviewer_recommendation: 'blocked' })).toBe('BLOCKED');
    expect(extractReviewerRecommendation({ reviewer_recommendation: '  Done ' })).toBe('DONE');
  });

  test('prose alone still works (fallback for rows without the field), verbatim', () => {
    expect(extractReviewerRecommendation({ open_questions: [sentence('BLOCKED')] })).toBe('BLOCKED');
    expect(extractReviewerRecommendation({ open_questions: [sentence('approve')] })).toBe('approve');
  });

  test('structured and prose agreeing (case-insensitively) → the structured value', () => {
    expect(extractReviewerRecommendation({
      reviewer_recommendation: 'BLOCKED',
      open_questions: [sentence('blocked')],
    })).toBe('BLOCKED');
  });

  test('structured and prose DISAGREEING → null (the row contradicts itself)', () => {
    expect(extractReviewerRecommendation({
      reviewer_recommendation: 'DONE',
      open_questions: [sentence('BLOCKED')],
    })).toBeNull();
  });

  test('a structured value present but not a non-empty string fails closed, never promotes the prose', () => {
    expect(extractReviewerRecommendation({ reviewer_recommendation: '', open_questions: [sentence('BLOCKED')] })).toBeNull();
    expect(extractReviewerRecommendation({ reviewer_recommendation: 42, open_questions: [sentence('BLOCKED')] })).toBeNull();
    expect(extractReviewerRecommendation({ reviewer_recommendation: { v: 'BLOCKED' } })).toBeNull();
  });

  test('null / undefined structured value is treated as absent', () => {
    expect(extractReviewerRecommendation({ reviewer_recommendation: null, open_questions: [sentence('BLOCKED')] })).toBe('BLOCKED');
  });

  test('neither present, or non-object metadata → null', () => {
    expect(extractReviewerRecommendation({})).toBeNull();
    expect(extractReviewerRecommendation(null)).toBeNull();
    expect(extractReviewerRecommendation('BLOCKED')).toBeNull();
    expect(extractReviewerRecommendation({ open_questions: ['Which repo?'] })).toBeNull();
  });
});
