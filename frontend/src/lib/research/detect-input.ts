// Smart-input detector for the research studio's Stage 1.
//
// Pure, ordered heuristics that classify a free-text input into one of six
// shapes so the stepper can route it (a DOI/arXiv id resolves a specific paper;
// a URL is scraped; a question drives ask; a topic/title drives search). The
// detector NEVER forces a route — the UI shows a type pill the user can override
// — so a conservative wrong guess costs one click. Reuse `inferDomain` separately
// for the domain pre-select; this only decides the input *type*.

export type DetectedInputType =
  | 'doi'
  | 'arxiv'
  | 'url'
  | 'title'
  | 'question'
  | 'topic';

export interface DetectedInput {
  type: DetectedInputType;
  /** The cleaned, route-ready value (bare DOI / arXiv id / URL / trimmed text). */
  normalized: string;
}

// A DOI always carries the `10.<registrant>/<suffix>` shape — distinct from an
// arXiv id (`YYYY.NNNNN`), which has no `10.` prefix and no slash.
const DOI_RE = /(10\.\d{4,9}\/[^\s"<>]+)/i;
const DOI_LEADING_RE = /^(?:https?:\/\/)?(?:dx\.)?(?:doi\.org\/)?10\./i;
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i;
const ARXIV_ID_ONLY_RE = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const URL_RE = /^https?:\/\/\S+$/i;
const WH_RE =
  /^\s*(who|what|when|where|why|how|which|is|are|does|do|can|should|could|would|will)\b/i;

/**
 * Classify a research input. Ordered most-specific first:
 *   arXiv URL → DOI → bare arXiv id → other URL → question → title+authors → topic.
 */
export function detectInput(raw: string): DetectedInput {
  const text = (raw ?? '').trim();
  if (!text) return { type: 'topic', normalized: '' };

  // arXiv URL (abs/pdf) — strip to the bare id (without a trailing .pdf).
  const arxivUrl = text.match(ARXIV_URL_RE);
  if (arxivUrl?.[1]) {
    return { type: 'arxiv', normalized: arxivUrl[1].replace(/\.pdf$/i, '') };
  }

  // DOI — only when the input *leads* with a DOI (bare or doi.org-prefixed), so a
  // DOI mentioned mid-sentence does not hijack a topic query.
  if (DOI_LEADING_RE.test(text)) {
    const doi = text.match(DOI_RE);
    if (doi?.[1]) {
      return { type: 'doi', normalized: doi[1].replace(/[).,;]+$/, '') };
    }
  }

  // Bare arXiv id (e.g. `2305.12345v2`) — only when it IS the whole input, so it
  // is never confused with a DOI (no `10.` prefix) or a numeric topic.
  if (ARXIV_ID_ONLY_RE.test(text)) {
    return { type: 'arxiv', normalized: text };
  }

  // Any other URL → scrape target.
  if (URL_RE.test(text)) return { type: 'url', normalized: text };

  // Question → ends with `?` or opens with a wh-/aux-word.
  if (text.endsWith('?') || WH_RE.test(text)) {
    return { type: 'question', normalized: text };
  }

  // Title + authors → an `et al.`, or a `;`-separated author list with a year.
  if (
    /\bet al\.?/i.test(text) ||
    (text.includes(';') && /\b(?:19|20)\d{2}\b/.test(text))
  ) {
    return { type: 'title', normalized: text };
  }

  // Fallback: a topic to search. (A stray arXiv-looking number inside prose stays
  // a topic — only a whole-input id is treated as an identifier.)
  return { type: 'topic', normalized: text };
}

export const INPUT_TYPE_LABELS: Record<DetectedInputType, string> = {
  doi: 'DOI',
  arxiv: 'arXiv',
  url: 'URL',
  title: 'Paper title',
  question: 'Question',
  topic: 'Topic',
};
