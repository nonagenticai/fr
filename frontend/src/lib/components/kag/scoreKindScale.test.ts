import { describe, it, expect } from 'vitest';
import { scoreKindScale, askScaleLabel } from './kagAsk';

describe('scoreKindScale — a surface that knows its scale from the response', () => {
  it("maps 'rrf' to the fusion scale, so the badge can name why it is withheld", () => {
    expect(scoreKindScale('rrf')).toBe('fusion');
    expect(askScaleLabel(scoreKindScale('rrf'))).toBe('unavailable (fusion order, not scored)');
  });

  it("maps 'cosine' to the similarity scale", () => {
    expect(scoreKindScale('cosine')).toBe('similarity');
    expect(askScaleLabel(scoreKindScale('cosine'))).toBe(
      'unavailable (vector similarity, not a match score)',
    );
  });

  // THE LOAD-BEARING NEGATIVE. Without this, a mutant returning 'fusion' for
  // everything passes both cases above, and an unknown scale silently acquires a
  // name it did not earn.
  it('refuses to guess: an unknown or absent kind stays "none" and stays unnamed', () => {
    for (const k of ['crossencoder', 'bm25', '', 'RRF', 'Cosine', undefined]) {
      expect(scoreKindScale(k as string | undefined)).toBe('none');
      expect(askScaleLabel(scoreKindScale(k as string | undefined))).toBe('unavailable');
    }
  });

  // ⛔ The whole point of the change is that it cannot unlock a percentage.
  it('can NEVER return crossencoder — no score_kind is a cross-encoder scale', () => {
    for (const k of ['rrf', 'cosine', 'crossencoder', 'rerank', undefined]) {
      expect(scoreKindScale(k as string | undefined)).not.toBe('crossencoder');
    }
  });
});
