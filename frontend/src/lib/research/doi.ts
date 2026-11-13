/**
 * A DOI, turned into something a reviewer can click — or explicitly refused.
 *
 * The screening queue rendered `item.doi` inside a `<code>`, which is a
 * transcription target, not a route to the paper. A reviewer asked to judge a
 * record had to select the string, copy it, and paste it somewhere else, on
 * every row of a queue that can hold 200. That is the whole reason this exists.
 *
 * ## Why a normalizer and not `` `https://doi.org/${doi}` ``
 *
 * That template is what `PaperCard.svelte:168` does, and it is wrong in both
 * directions on real data:
 *
 *  - a record whose `doi` was imported as `https://doi.org/10.1000/xyz` (RIS and
 *    CSL-JSON both carry them that way, and Crossref's `URL` field always does)
 *    yields `https://doi.org/https://doi.org/10.1000/xyz`, a 404;
 *  - a `doi` that is not a DOI at all — an empty-ish string, an accession
 *    number, a PMID somebody put in the wrong column — yields a link that looks
 *    exactly as authoritative as a real one and resolves to nothing.
 *
 * The second failure is the one worth guarding: a dead link in a screening
 * queue does not announce itself, and a reviewer who clicks it learns only that
 * the paper "isn't there". `doiHref` returns `null` for anything it cannot
 * prove is a DOI, and the caller is expected to fall back to rendering the raw
 * string — the reviewer still SEES the value, they just aren't promised it
 * resolves. Refusing to link is a smaller lie than linking to nowhere.
 */

/**
 * The DOI syntax that is actually agreed on: a `10.` prefix, a registrant code
 * of 4+ digits, a slash, and a non-empty suffix.
 *
 * Deliberately not stricter. The suffix is opaque by specification — it can
 * hold parentheses, semicolons, angle brackets, mixed case, unicode — so
 * anything beyond "there is one, and it has no whitespace in it" would reject
 * valid identifiers. Deliberately not looser either: without the `10.` prefix
 * test this would happily link a PMID.
 */
const DOI_RE = /^10\.\d{4,9}\/\S+$/;

/** Resolver prefixes seen on imported records, stripped before validation. */
const RESOLVER_PREFIX_RE = /^(?:https?:\/\/)?(?:www\.)?(?:dx\.)?doi\.org\//i;
// Two different shapes, not one optional prefix: the `doi:` scheme separates
// with a colon, the legacy `info:` URI with a SLASH (`info:doi/10.1000/xyz`).
const SCHEME_PREFIX_RE = /^(?:doi:\s*|info:doi\/)/i;

/**
 * The bare DOI, or `null` if the value is not one.
 *
 * Idempotent: a bare DOI passes through unchanged, so callers can normalize
 * without knowing which shape they were handed.
 */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let doi = raw.trim();
  if (!doi) return null;
  doi = doi.replace(RESOLVER_PREFIX_RE, '').replace(SCHEME_PREFIX_RE, '').trim();
  // Trailing sentence punctuation, which a copy-paste out of prose carries in.
  // Not `)` unconditionally — a suffix can legitimately end in one — but a
  // trailing `)` with no `(` to match it was never part of the identifier.
  doi = doi.replace(/[.,;]+$/, '');
  if (doi.endsWith(')') && !doi.includes('(')) doi = doi.slice(0, -1);
  return DOI_RE.test(doi) ? doi : null;
}

/**
 * A resolvable `https://doi.org/…` URL, or `null` when the value is not a DOI.
 *
 * The suffix is percent-encoded per segment. DOI suffixes may contain
 * characters that are reserved in a URL path (`#` truncates at the fragment,
 * `?` at the query, a space breaks the href outright), and the DOI Handbook's
 * own guidance for embedding a DOI in a URL is to encode them. `encodeURIComponent`
 * leaves the unreserved set — including the `-._~()!*'` that suffixes are full
 * of — alone, so the ordinary case is a byte-for-byte passthrough.
 */
export function doiHref(raw: string | null | undefined): string | null {
  const doi = normalizeDoi(raw);
  if (!doi) return null;
  return `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;
}
