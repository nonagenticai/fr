// LLM-as-judge score truthfulness.
//
// THE DEFECT THIS EXISTS TO PREVENT
// ---------------------------------
// In the non-agentic system "judge" means an LLM-as-judge inference call that
// scores whether a candidate asset version's output is as good as the
// baseline's, producing `judge_score` / `judge_score_delta` /
// `judge_score_delta_mean`.
//
// The CONSUME side is fully built: fr renders those fields, and
// inference-router stores and serves them (its replay PATCH accepts
// `judge_score`). The PRODUCE side is not. The asset-evaluator service (retired
// 2026-11-01) never computed or sends a score —
// `replay_executors/prompt_executor.py` said the judge pass
// "is optional/null in v1 … and not yet wired through this path",
// `ir_client.backfill()` only ever sets `expected`/`validation_passed`, and
// `replay_runner` leaves its `judge_deltas` list empty so
// `judge_score_delta_mean` is always None.
//
// So every judge value a user sees today is null. Rendering that null as a
// blank or an em-dash is a LIE OF OMISSION: it is the same glyph the UI uses
// for "we asked and there was nothing for this row", so a user cannot tell
// "the judge ran and found nothing" from "the judge was never built".
//
// HOW THIS FIXES ITSELF WHEN THE PRODUCER SHIPS
// ---------------------------------------------
// Nothing here hard-codes "not implemented". The state is derived from the
// DATA: a whole result set of nulls is the unimplemented-producer signature,
// whereas a set with at least one real score proves the producer works and
// makes a remaining null a genuine per-row gap. The moment a producer
// starts emitting scores, at least one row in the set becomes non-null,
// `judgeProducerState` flips to 'producing' on its own, and real values render
// with no further change to this file or to any component that calls it.

/** Whether the judge producer appears to exist at all, per the observed set. */
export type JudgeProducerState =
  /** Not one score anywhere in the set — the producer has not shipped. */
  | 'unimplemented'
  /** At least one real score in the set — the producer works. */
  | 'producing';

/** What a single judge cell should say. */
export type JudgeCellState =
  /** (a) No producer: the whole set is null. Says so in words. */
  | 'unimplemented'
  /** (b) A real score for this row. */
  | 'scored'
  /** (c) The judge ran for this set but has nothing for THIS row. */
  | 'no-data';

/** Rendered when the producer does not exist. Deliberately NOT a blank or '—'. */
export const JUDGE_UNIMPLEMENTED_TEXT = 'not scored';

/** Rendered for a genuine per-row gap in an otherwise-scored set. */
export const JUDGE_NO_DATA_TEXT = '—';

const TITLES: Record<JudgeCellState, string> = {
  unimplemented:
    'No LLM-judge score exists anywhere in this result set. Replay records ' +
    'validation only — the scoring pass is not wired up upstream yet. Real ' +
    'scores appear here automatically once it is.',
  'no-data':
    'The judge scored this result set but produced no score for this row.',
  scored: 'LLM-judge score for this row.',
};

/**
 * Derive whether the judge producer exists, from every judge value currently in
 * view. Callers MUST pass the whole population the cell belongs to (all rows of
 * the table, plus the aggregate value when one is rendered) — a single value
 * cannot distinguish "never built" from "nothing for this row".
 *
 * An empty population is reported as 'unimplemented': zero observed scores is
 * literally the never-built signature, and with no rows there is no cell to
 * mislabel anyway.
 */
export function judgeProducerState(
  population: ReadonlyArray<number | null | undefined>,
): JudgeProducerState {
  return population.some((v) => v != null) ? 'producing' : 'unimplemented';
}

/** Classify one cell, given its value and the producer state of its set. */
export function judgeCellState(
  value: number | null | undefined,
  producer: JudgeProducerState,
): JudgeCellState {
  if (value != null) return 'scored';
  return producer === 'unimplemented' ? 'unimplemented' : 'no-data';
}

/** What a judge cell renders: its visible text, its state, and its tooltip. */
export interface JudgeCell {
  /** The visible string. Never blank. */
  text: string;
  /** Machine-readable state, mirrored to `data-judge-state` for tests + CSS. */
  state: JudgeCellState;
  /** `title` tooltip explaining the state in full. */
  title: string;
}

/**
 * Build the full render decision for one judge value.
 *
 * @param value      this cell's judge value (score, delta, or delta mean)
 * @param population every judge value in the same result set, incl. `value`
 * @param format     how to render a real score (percent, fixed-3, …)
 */
export function judgeCell(
  value: number | null | undefined,
  population: ReadonlyArray<number | null | undefined>,
  format: (v: number) => string,
): JudgeCell {
  const state = judgeCellState(value, judgeProducerState(population));
  const text =
    state === 'scored'
      ? format(value as number)
      : state === 'unimplemented'
        ? JUDGE_UNIMPLEMENTED_TEXT
        : JUDGE_NO_DATA_TEXT;
  return { text, state, title: TITLES[state] };
}

/** Format a 0..1 judge score as a percentage. */
export function fmtJudgeScore(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/** Format a judge delta (signed, unit-free) to 3dp. */
export function fmtJudgeDeltaValue(v: number): string {
  return v.toFixed(3);
}
