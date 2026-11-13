// Guard a URL that will be bound to an `href`/`src` attribute when the value
// comes from untrusted data (ingested/scraped document metadata, LLM output).
// Svelte does NOT sanitize attribute URLs, so a raw `href={url}` with a value
// like `javascript:…` or `data:text/html,…` executes in the app origin on click
// — a stored-XSS sink on customer-facing provenance links.
//
// Allow-lists the schemes that are safe to navigate to: http, https, mailto, and
// scheme-relative / same-origin relative URLs (which inherit the page's https).
// Anything else (javascript:, data:, vbscript:, file:, blob:, unknown schemes)
// returns undefined so the caller can drop the link or fall back.

const SAFE_ABSOLUTE_SCHEME = /^(https?:|mailto:)/i;
// A leading scheme like `javascript:` / `data:` — `word(+.-)*:` before any slash.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Whitespace + control chars (incl. U+0000–U+001F): browsers strip these when
// resolving a URL, so `java\tscript:` must be normalised before the scheme check.
// eslint-disable-next-line no-control-regex
const STRIP_WS = /[\s\x00-\x1f]/g;

/**
 * Return `url` if it is safe to use as an href, else `undefined`.
 * Only the scheme CHECK runs against the whitespace-stripped form; the original
 * (trimmed) url is returned so legitimate values are unchanged.
 */
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const cleaned = url.replace(STRIP_WS, '');
  if (cleaned.length === 0) return undefined;

  // No scheme → relative / scheme-relative (`//host`, `/path`, `path`, `#frag`),
  // which resolve against the current https origin — safe to link.
  if (!HAS_SCHEME.test(cleaned)) return url.trim();

  // Has a scheme → only http(s)/mailto are allowed.
  return SAFE_ABSOLUTE_SCHEME.test(cleaned) ? url.trim() : undefined;
}
