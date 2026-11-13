/**
 * Research domains — the smart-suggest scope model for /library/research.
 *
 * George's "stress echo → arxiv physics" disaster is a source-scoping problem:
 * a bare federated search hits all registered sources, so a cardiology term is
 * drowned by arxiv physics. Each domain here maps to an explicit allow-list of
 * Discovery-Engine source adapters; the page sends that list as the search's
 * nested `sources.sources`, which NARROWS the live registered+enabled set
 * (verified live 2026-06-16 — it cannot enable a default-off source, so every
 * name below is one of the six sources confirmed live: semantic_scholar, arxiv,
 * pubmed, openlibrary, crossref, europe_pmc).
 *
 * `inferDomain` pre-selects a likely domain from the query (shown, never forced
 * — the user can switch with one click). A `null` source list means "broad"
 * (omit the filter → all registered sources), used by the General domain.
 *
 * Pure + unit-tested (domains.test.ts). No Svelte, no I/O.
 */

import type { SearchRequest } from '$lib/api/research';

export type DomainId = 'medicine' | 'physics' | 'cs' | 'general' | 'books';

export interface Domain {
  id: DomainId;
  label: string;
  /** Explicit source allow-list, or null for a broad (all-sources) search. */
  sources: string[] | null;
  /** One-line hint shown under the chip. */
  hint: string;
}

/**
 * The chip list, in display order. Source sets are built from the six live
 * sources; Medicine is the proven cardiology fix (pubmed + europe_pmc lead).
 */
export const DOMAINS: readonly Domain[] = [
  {
    id: 'medicine',
    label: 'Medicine & Life sciences',
    sources: ['pubmed', 'europe_pmc', 'semantic_scholar'],
    hint: 'PubMed, Europe PMC, Semantic Scholar',
  },
  {
    id: 'physics',
    label: 'Physics & Math',
    sources: ['arxiv', 'semantic_scholar', 'crossref'],
    hint: 'arXiv, Semantic Scholar, Crossref',
  },
  {
    id: 'cs',
    label: 'CS & AI',
    sources: ['arxiv', 'semantic_scholar'],
    hint: 'arXiv, Semantic Scholar',
  },
  {
    id: 'general',
    label: 'General / cross-domain',
    sources: null,
    hint: 'All sources (broad)',
  },
  {
    id: 'books',
    label: 'Books',
    sources: ['openlibrary'],
    hint: 'Open Library',
  },
] as const;

/** Look up a domain by id (falls back to General). */
export function domainById(id: DomainId): Domain {
  return DOMAINS.find((d) => d.id === id) ?? DOMAINS[3];
}

// Ordered keyword heuristics. `\b<stem>` prefix-matches at a word boundary, so
// "cardi" hits cardiac/cardiology/cardiovascular and "echocardi" hits
// echocardiography, while avoiding mid-word false positives. Order matters:
// the first domain whose pattern matches wins (medicine first — it is the
// complaint that prompted this work, and clinical intent should dominate).
const MEDICINE =
  /\b(cardi|echocardi|clinical|patient|disease|therap|cancer|carcinom|tumou?r|oncolog|diagnos|treatment|surg|vaccin|pharma|drug|genom|genetic|protein|syndrome|patholog|epidemiolog|covid|infect|antibod|immun|neurolog|psychiatr|medic|health|hospital|stroke|diabet|hypertens|cholesterol|vascular|cell biology|clinic|dose|in vivo|in vitro|nephrolog|hepatolog|gastroenterolog|dermatolog|rheumat|endocrinolog|h(a)?ematolog|ophthalmolog|pulmonolog|urolog|gyn(a)?ecolog|obstetric|p(a)?ediatr|orthop(a)?edic|radiolog|an(a)?esthes|sepsis|asthma|arthrit|osteoporos|alzheimer|parkinson|dementia|epilep|migraine|renal|hepatic|pulmonary|coronary|myocard|arrhythmi|ischemi|ischaemi|sclerosis|fibrosis|lupus|psoriasis|eczema|melanoma|leuk(a)?emi|lymphoma|glioma|sarcoma|metastas|tuberculosis|malaria|hepatitis|aneurysm|thrombo|embol(?=[iu])|lesion|ulcer|seizure|apn(o)?ea|biomarker|antigen|cytokine|inflammat|prognos|morbidit|mortalit|comorbid|pathophysiol|histolog|biopsy|enzyme|receptor|peptide|hormone|insulin|h(a)?emoglob|transplant|angioplasty|endoscop|laparoscop|catheter|stent|dialysis|radiotherap|prosthes|resection|ablation|antibiotic|analgesic|statins?\b|corticosteroid|opioid|anticoagul|antivir|antifungal|antidepress|antipsychotic|placebo|sedativ|epidemic|pandemic|outbreak|pathogen|bacteri|microbi|crispr|genotype|phenotype|chromosom)/i;
const CS =
  /\b(neural network|deep learning|machine learning|transformer|algorithm|dataset|gpu|llm|large language model|embedding|classifier|computer vision|natural language|reinforcement learn|convolution|software|kubernetes|blockchain|cryptograph|reasoning model|fine-tun|backpropagat)/i;
const PHYSICS =
  /\b(quantum|particle physics|relativ|cosmolog|photon|electron|gravit|thermodynam|plasma|astrophys|galax|supernova|qubit|boson|fermion|lattice gauge|spintron|condensed matter|string theory|topolog)/i;
const BOOKS = /\b(novel|fiction|biography|textbook|isbn|monograph)/i;

/**
 * Infer a likely domain from a free-text query. Returns 'general' when nothing
 * distinctive matches. Conservative by design — a wrong guess costs one click.
 */
export function inferDomain(query: string): DomainId {
  const q = (query ?? '').toLowerCase();
  if (!q.trim()) return 'general';
  if (MEDICINE.test(q)) return 'medicine';
  if (CS.test(q)) return 'cs';
  if (PHYSICS.test(q)) return 'physics';
  if (BOOKS.test(q)) return 'books';
  return 'general';
}

// The content-domain matchers, in inferDomain's precedence order. `general` is
// intentionally absent — it is the "no scoping" fallback (sources: null), never
// a member of a source union. Reuses the regex constants above (no duplication).
const DOMAIN_MATCHERS: ReadonlyArray<{ id: DomainId; pattern: RegExp }> = [
  { id: 'medicine', pattern: MEDICINE },
  { id: 'cs', pattern: CS },
  { id: 'physics', pattern: PHYSICS },
  { id: 'books', pattern: BOOKS },
];

/**
 * The honest default source scope for a query: the deduped, order-stable UNION
 * of the source allow-lists of EVERY content domain whose pattern matches.
 *
 * - Exactly one domain matches → that domain's `sources`, unchanged.
 * - Several match (e.g. "quantum ML for drug discovery" hits physics + cs +
 *   medicine) → their sources unioned, so the search spans all of them instead
 *   of being pinned to whichever one `inferDomain` happened to rank first.
 * - Nothing matches → `null` (an honest broad, all-sources search).
 *
 * This is the source-scoping counterpart to `inferDomain` (which only picks the
 * single chip to display). Pure; reuses DOMAINS via `domainById`.
 */
export function inferScopeSources(query: string): string[] | null {
  const q = (query ?? '').toLowerCase();
  if (!q.trim()) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { id, pattern } of DOMAIN_MATCHERS) {
    if (!pattern.test(q)) continue;
    for (const s of domainById(id).sources ?? []) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out.length > 0 ? out : null;
}

export interface BuildSearchOpts {
  query: string;
  /** The chosen domain (provides the default source set). */
  domainId: DomainId;
  /** Explicit source override from the advanced picker; wins over the domain. */
  sourcesOverride?: string[] | null;
  yearMin?: number | null;
  yearMax?: number | null;
  sortBy?: 'relevance' | 'citation_count' | 'year';
  maxPerSource?: number;
  openAccessOnly?: boolean;
}

/**
 * Assemble the verbatim Discovery-Engine search body from the scope panel
 * state. Only sets `sources` when a concrete non-empty list resolves (else the
 * search stays broad); only sets `year_range` when at least one bound is given;
 * clamps `max_results_per_source` to the engine's 1–100 range.
 */
export function buildSearchRequest(opts: BuildSearchOpts): SearchRequest {
  const {
    query,
    domainId,
    sourcesOverride,
    yearMin,
    yearMax,
    sortBy = 'relevance',
    maxPerSource = 20,
    openAccessOnly = false,
  } = opts;

  const resolvedSources =
    sourcesOverride !== undefined && sourcesOverride !== null
      ? sourcesOverride
      : domainById(domainId).sources;

  const body: SearchRequest = {
    query: query.trim(),
    max_results_per_source: Math.min(100, Math.max(1, Math.round(maxPerSource))),
    sort_by: sortBy,
  };

  if (resolvedSources && resolvedSources.length > 0) {
    body.sources = { sources: resolvedSources };
  }

  const min = typeof yearMin === 'number' && !Number.isNaN(yearMin) ? yearMin : null;
  const max = typeof yearMax === 'number' && !Number.isNaN(yearMax) ? yearMax : null;
  if (min !== null || max !== null) {
    body.year_range = [min, max];
  }

  if (openAccessOnly) body.open_access_only = true;

  return body;
}
