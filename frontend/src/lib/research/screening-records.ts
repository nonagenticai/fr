/**
 * Discovery papers → the canonical-JSON records Evidence Review imports.
 *
 * Mapped explicitly rather than passed through: Evidence Review rejects a body
 * carrying a guarded regulatory discriminator at ANY depth, and `PaperResult`
 * has an open index signature, so forwarding one whole would let an upstream
 * adapter field fail the import with an error nobody could trace back to the
 * research page.
 *
 * That rule used to live in a comment above an inline `.map()` whose return
 * type was inferred — so adding a key type-checked, and nothing failed until an
 * import 422'd in production. The `ScreeningRecord` return annotation below is
 * what actually enforces it: an extra property is a compile error, and
 * `screening-records.test.ts` pins the exact key set.
 *
 * Two producers feed this, with genuinely different shapes:
 *   - federated search        → `authors: [{ name }]`, `external_ids.DOI`
 *   - a session export        → `authors: ['A B']` (discovery-engine's
 *     `ExportService._paper_to_dict` emits bare strings)
 * Both are handled here rather than at either call site.
 *
 * Pure + unit-tested. No Svelte, no I/O. `import type` is erased, so this
 * module does not pull `$lib/api/research` into the runtime graph.
 */

import type { PaperResult } from '$lib/api/research';

/**
 * The record shape Evidence Review accepts as `canonical_json`.
 *
 * CLOSED ON PURPOSE — see the module docstring. Widening this type widens what
 * reaches the ERS wire, so any new member is a deliberate contract change.
 */
export interface ScreeningRecord {
  title: string;
  abstract: string | null;
  year: number | null;
  journal: string | null;
  url: string | null;
  doi: string | null;
  pmid: string | null;
  authors: string[];
}

/**
 * Identifier keys are read case-insensitively.
 *
 * discovery-engine passes each adapter's `external_ids` through verbatim, so
 * the same identifier arrives as `DOI` from one source and `doi` from another;
 * its own RIS branch reads the lowercase spelling. Reading only one casing
 * dropped identifiers silently, and a dropped DOI or PMID does not fail an
 * import — it reduces two of Evidence Review's three dedup rules to no-ops on
 * that record.
 */
function identifier(
  ids: Record<string, unknown> | undefined,
  ...names: string[]
): string | null {
  if (!ids) return null;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(ids)) {
    if (!wanted.has(key.toLowerCase())) continue;
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/** One paper, from either producer, as the record ERS accepts. */
export function toScreeningRecord(p: PaperResult): ScreeningRecord {
  return {
    title: p.title ?? '',
    abstract: p.abstract ?? null,
    year: p.year ?? null,
    journal: p.venue ?? null,
    url: p.pdf_url ?? null,
    doi: identifier(p.external_ids, 'doi'),
    pmid: identifier(p.external_ids, 'pubmed', 'pmid', 'pubmed_id'),
    authors: (p.authors ?? [])
      .map((a) => (typeof a === 'string' ? a : (a.name ?? '')))
      .filter(Boolean),
  };
}

export function toScreeningRecords(papers: PaperResult[]): ScreeningRecord[] {
  return papers.map(toScreeningRecord);
}

/**
 * Where the records about to be sealed came from, so the Screening panel can
 * say it before consent is spent rather than after.
 *
 * `source` is four-valued for the same reason the panel's own `corpusKnowledge`
 * is: "there is no session" and "I could not read the session" are different
 * facts, and conflating them lets a failed read present as a first run.
 */
export interface CandidateProvenance {
  /** `session` — the server's set. `screen` — this browser's last search. */
  source: 'session' | 'screen' | 'unknown';
  /** Records in the session snapshot, or null when it was never read. */
  sessionCount: number | null;
  /** Records currently on the Discover screen (the last search only). */
  screenCount: number;
  /** When the snapshot was taken, ISO-8601. Null when there is none. */
  loadedAt: string | null;
  /** Why the session could not be read. Null unless `source` is `unknown`. */
  error: string | null;
  loading: boolean;
  reload: () => void;
}
