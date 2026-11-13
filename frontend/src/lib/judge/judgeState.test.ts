// Pure-logic tests for the judge three-state derivation.
//
// These cover the derivation itself, including the property that makes the fix self-healing:
// the producer state is read off the DATA, so it flips on its own.

import { describe, it, expect } from 'vitest';
import {
  judgeProducerState,
  judgeCellState,
  judgeCell,
  fmtJudgeScore,
  fmtJudgeDeltaValue,
  JUDGE_UNIMPLEMENTED_TEXT,
  JUDGE_NO_DATA_TEXT,
} from './judgeState';

describe('judgeProducerState', () => {
  it('reports unimplemented when every value in the set is null', () => {
    expect(judgeProducerState([null, null, null])).toBe('unimplemented');
  });

  it('reports unimplemented for undefined as well as null', () => {
    expect(judgeProducerState([undefined, null, undefined])).toBe('unimplemented');
  });

  it('reports producing as soon as ONE value is real', () => {
    expect(judgeProducerState([null, 0.82, null])).toBe('producing');
  });

  it('treats 0 as a real score, not as absence', () => {
    // 0.0 is a legitimate judge score / delta. A truthiness check here would
    // misreport a working producer as unbuilt.
    expect(judgeProducerState([0])).toBe('producing');
  });

  it('reports unimplemented for an empty population', () => {
    expect(judgeProducerState([])).toBe('unimplemented');
  });
});

describe('judgeCellState — the three states', () => {
  it('(a) null in an all-null set is "unimplemented"', () => {
    expect(judgeCellState(null, judgeProducerState([null, null]))).toBe('unimplemented');
  });

  it('(b) a real value is "scored"', () => {
    expect(judgeCellState(0.5, judgeProducerState([0.5, null]))).toBe('scored');
  });

  it('(c) null alongside a scored sibling is "no-data"', () => {
    expect(judgeCellState(null, judgeProducerState([0.5, null]))).toBe('no-data');
  });

  it('(b) a score of exactly 0 is "scored", not absent', () => {
    // A truthiness check here reintroduces the whole defect for the most
    // interesting value there is: a judge delta of 0.000 means "the candidate
    // is exactly as good as the baseline", which is a RESULT, not a gap.
    expect(judgeCellState(0, 'producing')).toBe('scored');
    expect(judgeCellState(0, 'unimplemented')).toBe('scored');
  });
});

describe('judgeCell — rendered text per state', () => {
  const ALL_NULL = [null, null, null];
  const MIXED = [0.9, null, null];

  it('(a) unimplemented renders words, NOT a blank or an em-dash', () => {
    const cell = judgeCell(null, ALL_NULL, fmtJudgeScore);
    expect(cell.state).toBe('unimplemented');
    expect(cell.text).toBe(JUDGE_UNIMPLEMENTED_TEXT);
    expect(cell.text).toBe('not scored');
    // The exact live bug: this used to render '—' / blank.
    expect(cell.text).not.toBe('—');
    expect(cell.text.trim()).not.toBe('');
    expect(cell.title).toContain('not wired up upstream yet');
  });

  it('(b) scored renders the formatted value', () => {
    const cell = judgeCell(0.9, MIXED, fmtJudgeScore);
    expect(cell.state).toBe('scored');
    expect(cell.text).toBe('90.0%');
  });

  it('(c) no-data renders an em-dash and says the judge ran', () => {
    const cell = judgeCell(null, MIXED, fmtJudgeScore);
    expect(cell.state).toBe('no-data');
    expect(cell.text).toBe(JUDGE_NO_DATA_TEXT);
    expect(cell.text).toBe('—');
    expect(cell.title).toContain('scored this result set but produced no score for this row');
  });

  it('renders a judge delta of exactly 0 as "0.000", never as "not scored"', () => {
    const cell = judgeCell(0, [0, null], fmtJudgeDeltaValue);
    expect(cell.state).toBe('scored');
    expect(cell.text).toBe('0.000');
    expect(cell.text).not.toBe(JUDGE_UNIMPLEMENTED_TEXT);
    expect(cell.text).not.toBe(JUDGE_NO_DATA_TEXT);
  });

  it('the three states produce three DISTINCT visible strings', () => {
    const a = judgeCell(null, ALL_NULL, fmtJudgeScore).text;
    const b = judgeCell(0.9, MIXED, fmtJudgeScore).text;
    const c = judgeCell(null, MIXED, fmtJudgeScore).text;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('flips from unimplemented to a real value once the producer ships', () => {
    // Same cell value (null) and the SAME component code; the only thing that
    // changes is that the upstream producer started emitting scores. This is
    // the self-healing property — no code change is needed for real scores to
    // appear.
    const before = judgeCell(null, [null, null], fmtJudgeDeltaValue);
    expect(before.text).toBe('not scored');

    const after = judgeCell(-0.25, [-0.25, 0.1], fmtJudgeDeltaValue);
    expect(after.state).toBe('scored');
    expect(after.text).toBe('-0.250');
  });
});

describe('formatters', () => {
  it('fmtJudgeScore renders a 0..1 score as a percentage', () => {
    expect(fmtJudgeScore(0.825)).toBe('82.5%');
  });

  it('fmtJudgeDeltaValue renders a signed delta to 3dp', () => {
    expect(fmtJudgeDeltaValue(-0.25)).toBe('-0.250');
  });
});
