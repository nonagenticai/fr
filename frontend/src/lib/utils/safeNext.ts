// Guard the post-login redirect target. `next` arrives from the query string
// (`/login?next=<path>`), i.e. from whoever composed the link — so it is
// attacker-controllable and feeding it straight to `goto()` is an OPEN
// REDIRECT: a phishing link of the form
// `https://app.example/login?next=https://evil.example.com` would bounce an
// authenticated user off-origin, with the app's own domain in the visible URL
// they clicked.
//
// Only same-origin RELATIVE paths are honoured:
//   - nothing / empty            → `/`
//   - not `/`-prefixed           → `/`  (absolute `https://evil…`, or a bare word)
//   - `//`-prefixed              → `/`  (protocol-relative → resolves off-origin)
//   - anything the URL parser resolves off-origin → `/`
// Anything else is returned unchanged.
//
// ⚠️ The prefix checks alone are NOT sufficient, and that is why the parser
// check below exists rather than a third startsWith(). MEASURED 2026-09-25:
// `/\evil.example.com` begins with exactly ONE `/`, so it passes both prefix
// guards — and `new URL()` resolves it to `https://evil.example.com/`, because
// the URL spec treats a backslash in a special-scheme URL as a `/`. A prefix
// rule enumerates the tricks it knows; asking the parser where the value
// actually POINTS is the whole class. Any future encoding trick the parser
// honours is caught for free.
//
// The fallback is `/` and must stay `/`. It was `/dashboard` until that route
// was deleted as a thinner duplicate of `/`; restoring it here reintroduces a
// redirect to a 404 that no other check would catch. See safeNext.test.ts.
//
// Extracted verbatim from `routes/login/+page.svelte`, where it was a
// non-exported inline function and therefore untestable — the two off-origin
// branches are a security control and nothing proved they worked.

/** A `next` we are willing to navigate to: same-origin, relative, not protocol-relative. */
export function safeNext(next: string | null): string {
  if (!next) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/'; // protocol-relative → off-origin

  // Ask the URL parser where this actually points. The sentinel base is a
  // reserved-TLD origin that can never be a real one, so a resolved origin that
  // is NOT the sentinel means `next` escaped the path it claimed to be.
  // Deliberately independent of `window.location`, so this stays pure and
  // testable and behaves identically under SSR.
  try {
    if (new URL(next, SENTINEL_ORIGIN).origin !== SENTINEL_ORIGIN) return '/';
  } catch {
    return '/'; // unparseable is not navigable
  }

  return next;
}

const SENTINEL_ORIGIN = 'https://safe-next.invalid';
