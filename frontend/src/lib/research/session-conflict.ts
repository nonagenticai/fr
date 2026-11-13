// Reading discovery-engine's "that session already holds a corpus" refusal.
//
// The studio names a discovery session after the search query, so searching the
// same terms twice from a fresh browser always collides with the session the
// first search created. discovery-engine answers 409 and — correctly — refuses
// to discover into it, because doing so would seal a review export over two
// runs. Its message ends "GET it if you meant to continue that corpus", and
// since DE #66 it carries the facts needed to do that as `error.context`.
//
// This module is the ONLY place that knows the shape of that body. It lives
// apart from `+page.svelte` so it can be tested without a browser: a parser
// inlined in a component is a parser nothing can exercise.
//
// ## Why it reads a field and never the sentence
//
// The id is also present in the prose. Regexing a UUID out of an English
// sentence would "work" until somebody rewords the sentence, and would fail
// silently — the studio would go back to degrading, with no test to notice.
// Reading the declared field means a DE change that drops it breaks a test here
// instead of a user's search. If `context` is absent (an older engine), we
// return null and the caller keeps its previous degraded-but-honest behaviour.

import { AssetError } from '$lib/api/assets';

/** The subset of DE's 409 body this module depends on. */
type CorpusConflict = {
  session_id: string;
  paper_count: number | null;
  query_count: number | null;
};

function readContext(e: unknown): CorpusConflict | null {
  // Only a 409. A 500 whose body happens to carry a `session_id` is not an
  // invitation to adopt a session — the status is part of the claim.
  if (!(e instanceof AssetError) || e.status !== 409) return null;

  const context = (
    e.upstreamBody as { error?: { context?: Record<string, unknown> } } | undefined
  )?.error?.context;
  if (!context || typeof context !== 'object') return null;

  const sessionId = context.session_id;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null;

  // Counts are for the notice only, so a missing or malformed one must not cost
  // the user the recovery. `typeof x === 'number'` also rejects a stringified
  // number, which would render as "3 papers" while being a different type than
  // the contract promises — better to say nothing than to say it uncheckably.
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  return {
    session_id: sessionId,
    paper_count: count(context.paper_count),
    query_count: count(context.query_count),
  };
}

/**
 * The id of the session DE refused to create over, or `null` when this error is
 * anything else. `null` means "keep your existing failure handling", never
 * "there is no session".
 */
export function sessionIdFromCorpusConflict(e: unknown): string | null {
  return readContext(e)?.session_id ?? null;
}

/**
 * What to tell the user, in their terms. They searched; they did not ask about
 * sessions. So this says what happened to their corpus, not what happened to an
 * HTTP call — and it states the counts, because "continuing" a corpus the user
 * has forgotten the size of is exactly when they would want to check.
 */
export function corpusConflictNotice(e: unknown): string {
  const c = readContext(e);
  if (c === null) return '';

  // Both spellings are given explicitly. Appending 's' turns "search" into
  // "searchs", which is how a reader learns the sentence was generated rather
  // than written — the first draft of this function did exactly that.
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  if (c.paper_count !== null) parts.push(plural(c.paper_count, 'paper', 'papers'));
  if (c.query_count !== null)
    parts.push(plural(c.query_count, 'search', 'searches'));

  const size = parts.length > 0 ? ` It already holds ${parts.join(' from ')}.` : '';
  return (
    `Continuing the discovery session this query already has.${size}` +
    ' New results are added to it rather than starting a second corpus.'
  );
}
