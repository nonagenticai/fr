// kagAsk.test.ts
// ==============
// Pure unit cases for `citationLabel` — the shared citation-row label used by
// KagAskAnswerBody and the Ask & search tab.
//
// This exists because both consumers carried a byte-identical LOCAL copy that
// read TOP-LEVEL `title`/`doc_id`/`pages`. kag's real `Citation` (models/ask.py)
// nests every one of those under `.source` and its page field is a SCALAR
// `page`, so the top-level probes were always `undefined` and every rendered
// citation read literally `(unnamed)`. Both component test suites asserted
// against a hand-invented flat fixture the backend has never emitted, so
// nothing caught it. These cases pin the REAL wire shape.

import { describe, it, expect } from 'vitest';
import { askBestMatchLabel, askScoreScale, askStatsFrom, citationLabel } from './kagAsk';

/** The label shown wherever `top_score` is on the RRF fusion scale. */
const FUSION = 'unavailable (fusion order, not scored)';
const SIMILARITY = 'unavailable (vector similarity, not a match score)';

const DOC_UUID = '0195f48b-d000-7000-8000-000000000042';

describe('citationLabel — the real kag Citation shape (provenance nested under .source)', () => {
  it('names a citation by its nested source title and scalar page', () => {
    expect(
      citationLabel({
        marker: 1,
        chunk_id: 'c1',
        kind: 'chunk',
        source: { doc_id: DOC_UUID, title: 'Employee Handbook', page: 4, chunk_id: 'c1' },
      }),
    ).toBe('Employee Handbook • p. 4');
  });

  it('omits the page segment when the source carries no page', () => {
    expect(
      citationLabel({
        marker: 2,
        chunk_id: 'c2',
        kind: 'chunk',
        source: { doc_id: DOC_UUID, title: 'Employee Handbook', chunk_id: 'c2' },
      }),
    ).toBe('Employee Handbook');
  });

  it('never renders a raw doc_id UUID as the document name', () => {
    const label = citationLabel({
      marker: 3,
      chunk_id: 'c3',
      kind: 'chunk',
      source: { doc_id: DOC_UUID, chunk_id: 'c3', page: 2 },
    });
    expect(label).toBe('Untitled document • p. 2');
    expect(label).not.toContain(DOC_UUID);
    expect(label).not.toContain('0195f48b');
  });

  it('derives a readable filename from the url when there is no title', () => {
    expect(
      citationLabel({
        marker: 4,
        chunk_id: 'c4',
        kind: 'chunk',
        source: {
          doc_id: DOC_UUID,
          url: 'https://docs.example.com/policies/refund%20policy.pdf?v=2#page=3',
          page: 3,
          chunk_id: 'c4',
        },
      }),
    ).toBe('refund policy.pdf • p. 3');
  });

  it('falls back to the host when the url has no path segment', () => {
    expect(
      citationLabel({
        marker: 5,
        chunk_id: 'c5',
        source: { doc_id: DOC_UUID, url: 'https://docs.example.com/', chunk_id: 'c5' },
      }),
    ).toBe('docs.example.com');
  });

  it('prefers a title over a url-derived name', () => {
    expect(
      citationLabel({
        marker: 6,
        chunk_id: 'c6',
        source: {
          doc_id: DOC_UUID,
          title: 'Refund Policy',
          url: 'https://docs.example.com/policies/refund.pdf',
          chunk_id: 'c6',
        },
      }),
    ).toBe('Refund Policy');
  });

  it('labels a graph citation by the triple text carried in chunk_id', () => {
    expect(
      citationLabel({
        marker: 1,
        chunk_id: 'Acme ACQUIRED Beta',
        kind: 'graph',
        source: { doc_id: 'graph', chunk_id: 'Acme ACQUIRED Beta' },
      }),
    ).toBe('Knowledge graph: Acme ACQUIRED Beta');
  });

  it('renders the graph placeholder triple as a plain "Knowledge graph fact"', () => {
    expect(
      citationLabel({
        marker: 2,
        chunk_id: 'graph-fact',
        kind: 'graph',
        source: { doc_id: 'graph', chunk_id: 'graph-fact' },
      }),
    ).toBe('Knowledge graph fact');
  });

  it('treats doc_id "graph" as a graph citation even without an explicit kind', () => {
    expect(citationLabel({ chunk_id: 'X RELATES_TO Y', source: { doc_id: 'graph' } })).toBe(
      'Knowledge graph: X RELATES_TO Y',
    );
  });
});

describe('citationLabel — tolerated legacy flat shape', () => {
  it('still reads a flat top-level title + pages array', () => {
    expect(citationLabel({ title: 'Handbook', doc_id: 'd-1', pages: [4, 5] })).toBe(
      'Handbook • p. 4, 5',
    );
  });

  it('prefers the nested source over a stale flat duplicate', () => {
    expect(
      citationLabel({
        title: 'Stale Flat Title',
        page: 99,
        source: { doc_id: DOC_UUID, title: 'Nested Title', page: 4, chunk_id: 'c7' },
      }),
    ).toBe('Nested Title • p. 4');
  });
});

describe('citationLabel — degenerate input', () => {
  it('never throws and never emits an empty label', () => {
    expect(citationLabel({})).toBe('Untitled document');
    expect(citationLabel({ source: null as unknown as Record<string, unknown> })).toBe(
      'Untitled document',
    );
    expect(citationLabel({ source: [] as unknown as Record<string, unknown> })).toBe(
      'Untitled document',
    );
    expect(citationLabel({ title: '', doc_id: '', pages: [] })).toBe('Untitled document');
  });
});

describe('citationLabel — the doc_id rung', () => {
  // The rung exists because ingestion writes human-meaningful slugs
  // (`expansion-Feature_Intake_Reference`, `execution-trace-…`) into
  // kag_graph.chunks.doc_id, and 47% of prod rows carry no title at all.
  // Falling straight to "Untitled document" threw away a usable name; showing
  // a UUID would have been worse than the placeholder. So the rung is
  // conditional on the id being readable, and BOTH halves need pinning.
  it('shows a slug doc_id when there is no title and no url', () => {
    expect(
      citationLabel({
        marker: 1,
        chunk_id: 'c1',
        kind: 'chunk',
        source: { doc_id: 'expansion-Feature_Intake_Reference', chunk_id: 'c1' },
      }),
    ).toBe('expansion-Feature_Intake_Reference');
  });

  it('SUPPRESSES a UUID doc_id — dashed and undashed — in favour of the placeholder', () => {
    for (const id of [
      '0195f48b-d000-7000-8000-000000000099',
      '0195f48bd00070008000000000000099',
      '0195F48B-D000-7000-8000-000000000099',
    ]) {
      expect(citationLabel({ source: { doc_id: id, chunk_id: 'c1' } })).toBe('Untitled document');
    }
  });

  it('prefers a real title over the doc_id rung', () => {
    expect(
      citationLabel({ source: { doc_id: 'some-slug', title: 'Employee Handbook', chunk_id: 'c' } }),
    ).toBe('Employee Handbook');
  });
});

describe('askStatsFrom — a degraded reranker must not sell a fusion score as confidence', () => {
  // When the cross-encoder hop fails, kag serves the RRF FUSION order and
  // top_score becomes a fusion score on a different, non-comparable scale — and
  // the old failure path fabricated an identity ramp starting at exactly 1.0, so
  // a degraded ask rendered "Best match 100%". Relabelling it "(unranked)" while
  // still printing a percentage was only half a fix: an RRF score rendered as a
  // percentage reads "2%", i.e. "nothing matched". The VALUE must be withheld and
  // the degradation surfaced instead, never presented as a comparable confidence.
  it('surfaces the degradation reason as a Reranker stat', () => {
    const stats = askStatsFrom('hybrid_rerank', {
      dense_count: 50,
      lexical_count: 50,
      fused_count: 50,
      survivor_count: 8,
      top_score: 1,
      rerank_degraded: true,
      rerank_degraded_reason: 'timeout',
    });
    expect(stats).toContainEqual({ label: 'Reranker', value: 'timeout' });
  });

  it('withholds the best-match value when the reranker degraded', () => {
    const stats = askStatsFrom('hybrid_rerank', {
      dense_count: 50,
      lexical_count: 50,
      fused_count: 50,
      survivor_count: 8,
      top_score: 1,
      rerank_degraded: true,
      rerank_degraded_reason: 'timeout',
    });
    expect(stats).toContainEqual({ label: 'Best match', value: FUSION });
    // No stat may carry a percentage: a withheld score that leaks back in through
    // some other row is the same fabrication under a different label.
    expect(stats.some((s) => s.value.includes('%'))).toBe(false);
  });

  it('falls back to "degraded" when the server reports no reason', () => {
    const stats = askStatsFrom('hybrid_rerank', {
      fused_count: 50,
      top_score: 1,
      rerank_degraded: true,
    });
    expect(stats).toContainEqual({ label: 'Reranker', value: 'degraded' });
    expect(stats).toContainEqual({ label: 'Best match', value: FUSION });
  });

  // The healthy case pins the other half: a blanket "always mark unranked" (or an
  // always-present Reranker row) would satisfy the cases above and still be wrong.
  it('leaves a healthy ask completely unmarked', () => {
    const stats = askStatsFrom('hybrid_rerank', { fused_count: 50, top_score: 0.5 });
    expect(stats).toContainEqual({ label: 'Best match', value: '50%' });
    expect(stats.some((s) => s.label === 'Reranker')).toBe(false);
    expect(stats.some((s) => s.label.includes('unranked'))).toBe(false);
  });
});

// The SECOND door onto the fusion scale, and the live one. `rerank_degraded`
// only ever covers a cross-encoder hop that ran and failed. `dense` and `hybrid`
// have no cross-encoder hop at all, so `rerank_degraded` stays false and the old
// code happily rendered an RRF score — max ≈0.021 — as "2%", directly beside
// full's cross-encoder "96%" in the Compare grid. Same label, different units,
// no disclosure.
describe('askScoreScale — which scale top_score is actually on', () => {
  it('reports the cross-encoder scale for the reranking modes', () => {
    expect(askScoreScale('hybrid_rerank', { top_score: 0.87 })).toBe('crossencoder');
    expect(askScoreScale('full', { top_score: 0.87 })).toBe('crossencoder');
  });

  it('separates the three scales the pipeline actually produces', () => {
    // Measured over eval/_runs/n150/hotpotqa/results.jsonl (588 rows):
    //   hybrid  top_score 0.0049..0.0213  -> RRF fusion
    //   dense   top_score 0.3922..0.8763  -> raw vector similarity (never fused)
    //   full    top_score 0.1139..1.0000  -> cross-encoder
    expect(askScoreScale('hybrid', { top_score: 0.0213 })).toBe('fusion');
    expect(askScoreScale('dense', { top_score: 0.8763 })).toBe('similarity');
    expect(askScoreScale('full', { top_score: 0.96 })).toBe('crossencoder');
  });

  it('reports the fusion scale when a reranking mode degraded', () => {
    expect(askScoreScale('full', { top_score: 1, rerank_degraded: true })).toBe('fusion');
  });

  it('reports no scale when there is no numeric score', () => {
    expect(askScoreScale('full', { fused_count: 50 })).toBe('none');
    expect(askScoreScale('full', { top_score: null })).toBe('none');
    expect(askScoreScale('full', undefined)).toBe('none');
  });
});

describe('askBestMatchLabel — a percentage only where a percentage means something', () => {
  // Math.round turned a cross-encoder 0.99964 into a flat "100%": a certainty no
  // retrieval hop ever reports. Floor + a hard 99 cap makes that unreachable.
  it('never manufactures 100% from a near-1.0 cross-encoder score', () => {
    expect(askBestMatchLabel('full', { top_score: 0.99964 })).toBe('99%');
  });

  it('caps an exact 1.0 at 99% rather than printing certainty', () => {
    expect(askBestMatchLabel('full', { top_score: 1.0 })).toBe('99%');
  });

  it('renders an ordinary cross-encoder score as its floored percentage', () => {
    expect(askBestMatchLabel('hybrid_rerank', { top_score: 0.87 })).toBe('87%');
  });

  it('withholds the figure for a hybrid ask, which never reranks', () => {
    expect(askBestMatchLabel('hybrid', { top_score: 0.0213 })).toBe(FUSION);
  });

  it('withholds the figure for a dense ask, and does not miscall it fusion', () => {
    // dense IS scored -- 0.3922..0.8763 in the recorded run -- it is simply not
    // on the reranker's scale. Saying "fusion order, not scored" here would be a
    // second wrong explanation layered over the first wrong number.
    expect(askBestMatchLabel('dense', { top_score: 0.8763 })).toBe(SIMILARITY);
    expect(askBestMatchLabel('dense', { top_score: 0.8763 })).not.toBe(FUSION);
  });

  it('withholds the figure when a reranking mode degraded', () => {
    expect(askBestMatchLabel('full', { top_score: 1, rerank_degraded: true })).toBe(FUSION);
  });

  it('says plainly there is nothing to show when no score arrived', () => {
    expect(askBestMatchLabel('full', { fused_count: 50 })).toBe('unavailable');
    expect(askBestMatchLabel('full', undefined)).toBe('unavailable');
  });
});

describe('askStatsFrom — the mode-never-reranked door', () => {
  it('withholds the percentage for dense and hybrid without inventing a failure', () => {
    for (const mode of ['dense', 'hybrid'] as const) {
      const stats = askStatsFrom(mode, { fused_count: 50, survivor_count: 8, top_score: 0.0213 });
      expect(stats).toContainEqual({
        label: 'Best match',
        value: mode === 'dense' ? SIMILARITY : FUSION,
      });
      // No percentage anywhere — "2%" reads as "nothing matched".
      expect(stats.some((s) => s.value.includes('%'))).toBe(false);
      // …and no Reranker row: nothing degraded, there was simply never a hop.
      expect(stats.some((s) => s.label === 'Reranker')).toBe(false);
    }
  });

  // The whole reason this matters: Compare renders all four side by side.
  it('does not put two different scales under one label across the compare grid', () => {
    const hybrid = askStatsFrom('hybrid', { fused_count: 50, top_score: 0.0213 });
    const full = askStatsFrom('full', { fused_count: 50, top_score: 0.96 });
    expect(full).toContainEqual({ label: 'Best match', value: '96%' });
    expect(hybrid.some((s) => s.value.includes('%'))).toBe(false);
  });

  it('keeps the Reranker row when a reranking mode degraded', () => {
    const stats = askStatsFrom('full', {
      fused_count: 50,
      top_score: 0.5,
      rerank_degraded: true,
      rerank_degraded_reason: 'unreachable',
    });
    expect(stats).toContainEqual({ label: 'Best match', value: FUSION });
    expect(stats).toContainEqual({ label: 'Reranker', value: 'unreachable' });
  });

  it('does not floor a cross-encoder score into a 100%', () => {
    expect(askStatsFrom('full', { top_score: 0.99964 })).toContainEqual({
      label: 'Best match',
      value: '99%',
    });
  });
});
