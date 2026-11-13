// Pure tests for the chunk-ratio formatter shared by the document row and the
// ingestion stepper.
//
// Every case here is named for the MUTATION it kills, because the whole module
// is a no-fabrication rule and each clause of it is independently mutable into
// something that still looks plausible on screen:
//
//   `chunksTotal == null`  → dropping it invents a denominator;
//   `chunksFailed > 0`     → relaxing it to `>= 0` prints "18 of 18 chunks
//                            indexed" under a warning banner;
//   `chunksIndexed ?? …`   → dropping the backend's own number silently
//                            substitutes a derived one that can disagree.

import { describe, it, expect } from 'vitest';
import { formatChunkRatio, degradationLine, DEGRADED_GENERIC } from './degradation';

// The real prod shape this feature exists for: karma completed the job having
// indexed 18 of 137 chunks and failed 119 of them.
const PROD = { chunksIndexed: 18, chunksFailed: 119, chunksTotal: 137 };

describe('formatChunkRatio', () => {
  it('renders the backend numbers verbatim (18/119/137 → "18 of 137 chunks indexed")', () => {
    expect(formatChunkRatio(PROD)).toBe('18 of 137 chunks indexed');
  });

  it('chunksTotal null → NO ratio (kills a fabricated denominator)', () => {
    // Dropping the `chunksTotal == null` guard would render "18 of undefined"
    // or, worse, silently swap in `chunksIndexed` as the denominator.
    expect(formatChunkRatio({ chunksIndexed: 18, chunksFailed: 119, chunksTotal: null })).toBeNull();
    expect(formatChunkRatio({ chunksIndexed: 18, chunksFailed: 119 })).toBeNull();
  });

  it('chunksFailed 0 → NO ratio (kills `>= 0`; "18 of 18 chunks indexed" is worse than silence)', () => {
    // karma's OTHER partial-credit shape: every chunk landed, extraction inside
    // them did not. A ratio here reads as a contradiction of the warning.
    expect(formatChunkRatio({ chunksIndexed: 18, chunksFailed: 0, chunksTotal: 18 })).toBeNull();
  });

  it('chunksFailed null → NO ratio (an unknown failure count is not zero failures)', () => {
    expect(formatChunkRatio({ chunksIndexed: 18, chunksFailed: null, chunksTotal: 137 })).toBeNull();
  });

  it('derives indexed from total-failed ONLY when the backend sent no chunksIndexed', () => {
    expect(formatChunkRatio({ chunksFailed: 119, chunksTotal: 137 })).toBe(
      '18 of 137 chunks indexed',
    );
  });

  it('prefers the backend chunksIndexed over the derived one (kills dropping the `??` left arm)', () => {
    // The two legs are made to DISAGREE on purpose: with `chunksIndexed ?? …`
    // removed this returns "18 of 137", so a mutant would survive a fixture
    // where 20 happened to equal total-failed.
    expect(formatChunkRatio({ chunksIndexed: 20, chunksFailed: 119, chunksTotal: 137 })).toBe(
      '20 of 137 chunks indexed',
    );
  });
});

describe('degradationLine', () => {
  it('falls back to the generic label rather than a half-built ratio', () => {
    expect(degradationLine({ chunksTotal: null })).toBe(DEGRADED_GENERIC);
    expect(degradationLine({})).toBe(DEGRADED_GENERIC);
  });

  it('returns the ratio when one is honestly available', () => {
    expect(degradationLine(PROD)).toBe('18 of 137 chunks indexed');
  });

  it('the generic fallback contains no digits (kills a fallback that names a count)', () => {
    expect(DEGRADED_GENERIC).not.toMatch(/\d/);
  });
});
