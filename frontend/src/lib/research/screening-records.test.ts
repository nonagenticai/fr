import { describe, it, expect } from 'vitest';
import { toScreeningRecord, toScreeningRecords } from './screening-records';
import type { PaperResult } from '$lib/api/research';

/** What federated search returns: author objects, upper-case identifier keys. */
const fromSearch: PaperResult = {
  paper_id: 'p1',
  title: 'Tocilizumab in hospitalised patients with COVID-19',
  abstract: 'A randomised controlled trial.',
  year: 2021,
  venue: 'The Lancet',
  pdf_url: 'https://example.org/p1.pdf',
  external_ids: { DOI: '10.1016/S0140-6736(21)00676-0', PubMed: '33933206' },
  authors: [{ name: 'Horby P' }, { name: 'Landray M' }],
};

/** What a session export returns: bare author strings, `id` not `paper_id`. */
const fromSessionExport = {
  id: 'p2',
  title: 'Interleukin-6 receptor antagonists in critically ill patients',
  abstract: null,
  year: 2021,
  venue: 'NEJM',
  pdf_url: null,
  external_ids: { doi: '10.1056/NEJMoa2100433' },
  authors: ['Gordon A C', 'Mouncey P R'],
} as unknown as PaperResult;

describe('toScreeningRecord', () => {
  it('maps a federated-search paper', () => {
    expect(toScreeningRecord(fromSearch)).toEqual({
      title: 'Tocilizumab in hospitalised patients with COVID-19',
      abstract: 'A randomised controlled trial.',
      year: 2021,
      journal: 'The Lancet',
      url: 'https://example.org/p1.pdf',
      doi: '10.1016/S0140-6736(21)00676-0',
      pmid: '33933206',
      authors: ['Horby P', 'Landray M'],
    });
  });

  it('maps a session-export record, whose authors are bare strings', () => {
    const r = toScreeningRecord(fromSessionExport);
    expect(r.authors).toEqual(['Gordon A C', 'Mouncey P R']);
    expect(r.doi).toBe('10.1056/NEJMoa2100433');
    expect(r.journal).toBe('NEJM');
  });

  /**
   * The constraint that had no test. Evidence Review refuses a body carrying a
   * guarded regulatory discriminator at ANY depth, and `PaperResult` has an
   * open index signature — so the mapper must emit exactly eight keys and never
   * pass an upstream adapter field through.
   */
  it('emits exactly the eight allowed keys, whatever the paper carries', () => {
    const contaminated = {
      ...fromSearch,
      regulatory_class: 'IIb',
      trust_score: 0.9,
      source: 'pubmed',
      citation_count: 412,
    } as unknown as PaperResult;

    expect(Object.keys(toScreeningRecord(contaminated)).sort()).toEqual([
      'abstract',
      'authors',
      'doi',
      'journal',
      'pmid',
      'title',
      'url',
      'year',
    ]);
  });

  /**
   * discovery-engine passes each adapter's `external_ids` through verbatim, so
   * casing varies by source. A dropped identifier does not fail the import — it
   * silently reduces two of Evidence Review's three dedup rules to no-ops.
   */
  it('reads identifiers in whatever casing the adapter used', () => {
    const lower = { external_ids: { doi: '10.1/x', pubmed: '111' } } as PaperResult;
    expect(toScreeningRecord(lower).doi).toBe('10.1/x');
    expect(toScreeningRecord(lower).pmid).toBe('111');

    const upper = { external_ids: { DOI: '10.2/y', PMID: '222' } } as PaperResult;
    expect(toScreeningRecord(upper).doi).toBe('10.2/y');
    expect(toScreeningRecord(upper).pmid).toBe('222');

    const alt = { external_ids: { pubmed_id: '333' } } as PaperResult;
    expect(toScreeningRecord(alt).pmid).toBe('333');
  });

  it('treats a missing or empty identifier as absent, not as an empty string', () => {
    expect(toScreeningRecord({ external_ids: {} } as PaperResult).doi).toBeNull();
    expect(toScreeningRecord({} as PaperResult).pmid).toBeNull();
    expect(
      toScreeningRecord({ external_ids: { doi: '   ' } } as PaperResult).doi,
    ).toBeNull();
  });

  it('gives a title-less paper an empty title rather than dropping it', () => {
    // The engine exports `title` unguarded. An empty title must still produce a
    // record so Evidence Review can quarantine it and report it in the count —
    // dropping it here would make the corpus silently short.
    expect(toScreeningRecord({} as PaperResult).title).toBe('');
  });
});

describe('toScreeningRecords', () => {
  it('maps both producers in one list, preserving order', () => {
    const out = toScreeningRecords([fromSearch, fromSessionExport]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.title)).toEqual([
      'Tocilizumab in hospitalised patients with COVID-19',
      'Interleukin-6 receptor antagonists in critically ill patients',
    ]);
  });
});
