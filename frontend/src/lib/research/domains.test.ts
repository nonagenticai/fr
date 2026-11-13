import { describe, it, expect } from 'vitest';
import {
  DOMAINS,
  domainById,
  inferDomain,
  inferScopeSources,
  buildSearchRequest,
} from './domains';

describe('inferDomain', () => {
  it('routes the cardiology disaster query to Medicine', () => {
    expect(inferDomain('stress echocardiography')).toBe('medicine');
    expect(inferDomain('dobutamine stress echo for cardiac risk')).toBe(
      'medicine',
    );
    expect(inferDomain('CAR-T therapy for lymphoma')).toBe('medicine');
  });

  it('routes ML/AI queries to CS & AI (not Medicine via "neuro")', () => {
    expect(inferDomain('graph neural network for node classification')).toBe(
      'cs',
    );
    expect(inferDomain('transformer large language model fine-tuning')).toBe(
      'cs',
    );
  });

  it('routes physics queries to Physics', () => {
    expect(inferDomain('quantum entanglement of photon pairs')).toBe('physics');
    expect(inferDomain('distances to galactic supernovae')).toBe('physics');
  });

  it('routes book-ish queries to Books', () => {
    expect(inferDomain('biography of Richard Feynman')).toBe('books');
  });

  it('falls back to General for non-distinctive or empty queries', () => {
    expect(inferDomain('history of the silk road')).toBe('general');
    expect(inferDomain('')).toBe('general');
    expect(inferDomain('   ')).toBe('general');
  });

  it('checks Medicine before CS so clinical intent dominates', () => {
    // "neural" alone is CS, but a clinical stem present → Medicine wins.
    expect(inferDomain('deep learning for cancer diagnosis')).toBe('medicine');
  });

  it('routes out-of-vocab but real biomedical queries to Medicine', () => {
    // None of these hit the original narrow keyword set — they fell through to
    // General and drowned in arXiv noise before the vocabulary was broadened.
    expect(inferDomain('renal transplant rejection')).toBe('medicine');
    expect(inferDomain('myocardial infarction biomarkers')).toBe('medicine');
    expect(inferDomain('sepsis management in the ICU')).toBe('medicine');
    expect(inferDomain('pembrolizumab for melanoma')).toBe('medicine');
    expect(inferDomain('osteoporosis and bone density')).toBe('medicine');
    expect(inferDomain('statin therapy adherence')).toBe('medicine');
    expect(inferDomain('endoscopic resection of polyps')).toBe('medicine');
    expect(inferDomain('phenotype of cystic fibrosis')).toBe('medicine');
  });

  it('does not let the broadened Medicine vocabulary steal non-medical queries', () => {
    // False-positive guards — these must stay General.
    expect(inferDomain('history of the silk road')).toBe('general');
    expect(inferDomain('viral marketing growth strategy')).toBe('general');
    expect(inferDomain('mutation testing for java code')).toBe('general');
    expect(inferDomain('supply chain optimization')).toBe('general');
    // "vector" is a CS/physics term, never Medicine.
    expect(inferDomain('feature vector normalization')).not.toBe('medicine');
    // Prefix-collision guards: "statin" must not steal "stating", "embol" must
    // not steal "embolden" (medicine runs first, so these need tight anchors).
    expect(inferDomain('stating the theorem clearly')).toBe('general');
    expect(inferDomain('embolden the sales team')).toBe('general');
  });

  it('keeps CS/Physics queries out of Medicine', () => {
    // "neuron"/"neural" alone must not read as clinical.
    expect(inferDomain('spiking neuron networks on gpu')).not.toBe('medicine');
    expect(inferDomain('plasma confinement in tokamaks')).toBe('physics');
    // Precedence still holds: a clinical stem alongside ML → Medicine.
    expect(inferDomain('deep learning for cancer diagnosis')).toBe('medicine');
  });
});

describe('inferScopeSources', () => {
  it('unions the source lists of every matched domain', () => {
    // quantum (physics) + machine learning (cs) + drug (medicine) all match.
    const sources = inferScopeSources('quantum machine learning for drug discovery');
    expect(sources).toContain('pubmed');
    expect(sources).toContain('arxiv');
    expect(sources).not.toContain('openlibrary');
  });

  it('returns exactly the domain sources when a single domain matches', () => {
    expect(inferScopeSources('stress echocardiography')).toEqual([
      'pubmed',
      'europe_pmc',
      'semantic_scholar',
    ]);
  });

  it('returns null (honest broad) when no content domain matches', () => {
    expect(inferScopeSources('history of the silk road')).toBeNull();
    expect(inferScopeSources('')).toBeNull();
    expect(inferScopeSources('   ')).toBeNull();
  });
});

describe('domainById', () => {
  it('returns the matching domain and falls back to General', () => {
    expect(domainById('medicine').sources).toEqual([
      'pubmed',
      'europe_pmc',
      'semantic_scholar',
    ]);
    expect(domainById('general').sources).toBeNull();
    // @ts-expect-error — exercising the fallback path with a bad id
    expect(domainById('nope').id).toBe('general');
  });

  it('only references the six live source names', () => {
    const live = new Set([
      'semantic_scholar',
      'arxiv',
      'pubmed',
      'openlibrary',
      'crossref',
      'europe_pmc',
    ]);
    for (const d of DOMAINS) {
      for (const s of d.sources ?? []) expect(live.has(s)).toBe(true);
    }
  });
});

describe('buildSearchRequest', () => {
  it('sets sources.sources from the domain and omits year_range when unset', () => {
    const body = buildSearchRequest({
      query: '  stress echocardiography  ',
      domainId: 'medicine',
      sortBy: 'citation_count',
      maxPerSource: 20,
    });
    expect(body.query).toBe('stress echocardiography');
    expect(body.sources).toEqual({
      sources: ['pubmed', 'europe_pmc', 'semantic_scholar'],
    });
    expect(body.sort_by).toBe('citation_count');
    expect(body.year_range).toBeUndefined();
    expect(body.max_results_per_source).toBe(20);
  });

  it('omits sources for the broad General domain', () => {
    const body = buildSearchRequest({ query: 'silk road', domainId: 'general' });
    expect(body.sources).toBeUndefined();
  });

  it('honors an explicit source override over the domain default', () => {
    const body = buildSearchRequest({
      query: 'x',
      domainId: 'medicine',
      sourcesOverride: ['arxiv'],
    });
    expect(body.sources).toEqual({ sources: ['arxiv'] });
  });

  it('treats an empty override as broad (no sources field)', () => {
    const body = buildSearchRequest({
      query: 'x',
      domainId: 'medicine',
      sourcesOverride: [],
    });
    expect(body.sources).toBeUndefined();
  });

  it('sets year_range when at least one bound is provided', () => {
    expect(
      buildSearchRequest({ query: 'x', domainId: 'cs', yearMin: 2015 })
        .year_range,
    ).toEqual([2015, null]);
    expect(
      buildSearchRequest({ query: 'x', domainId: 'cs', yearMax: 2026 })
        .year_range,
    ).toEqual([null, 2026]);
    expect(
      buildSearchRequest({
        query: 'x',
        domainId: 'cs',
        yearMin: 2015,
        yearMax: 2026,
      }).year_range,
    ).toEqual([2015, 2026]);
  });

  it('clamps max_results_per_source to 1–100', () => {
    expect(
      buildSearchRequest({ query: 'x', domainId: 'cs', maxPerSource: 999 })
        .max_results_per_source,
    ).toBe(100);
    expect(
      buildSearchRequest({ query: 'x', domainId: 'cs', maxPerSource: 0 })
        .max_results_per_source,
    ).toBe(1);
  });
});
