// urlState.ts
// ===========
// Generic URL-as-truth helpers for list views. The /workflows index is the
// reference implementation (filter state lives in the querystring, so the
// view is shareable, reload-safe, and restored on browser-back); these are
// its domain-agnostic primitives, extracted so any list→detail surface can
// adopt the same pattern. See $lib/workflows/facets.ts +
// routes/workflows/+page.svelte for the original facet-specific version,
// which stays as-is.

import { goto } from '$app/navigation';

export interface SetSearchParamsOptions {
  replaceState?: boolean;
  noScroll?: boolean;
  keepFocus?: boolean;
}

/**
 * Apply a patch of query-string params in ONE navigation. Keys whose value is
 * `null` or `''` are deleted; the rest are set. Bundling every change into a
 * single goto() avoids the race two separate goto()s hit — the second reads a
 * pre-navigation `$page.url` and clobbers the first patch (see the comment on
 * routes/workflows/+page.svelte:setParams).
 *
 * Defaults mirror the workflows list — `replaceState` (filters don't pollute
 * browser history) + `noScroll` (toggling a filter shouldn't jump the
 * viewport) — plus `keepFocus`, which a text-input writer needs so typing
 * doesn't lose focus on the same-route navigation. All three are harmless for
 * checkbox/sort writers. The input `url` is never mutated.
 */
export function setSearchParams(
  url: URL,
  patch: Record<string, string | null>,
  opts: SetSearchParamsOptions = {},
): Promise<void> {
  const next = new URL(url);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null || value === '') next.searchParams.delete(name);
    else next.searchParams.set(name, value);
  }
  return goto(next.pathname + next.search, {
    replaceState: opts.replaceState ?? true,
    noScroll: opts.noScroll ?? true,
    keepFocus: opts.keepFocus ?? true,
  });
}

/** Read a CSV param into a de-duped Set (values trimmed, empties dropped). */
export function parseCsvSet(params: URLSearchParams, key: string): Set<string> {
  const raw = params.get(key);
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v) out.add(v);
  }
  return out;
}

/** Serialize a Set to a CSV string, or `null` when empty (→ param deleted). */
export function csvSetToParam(set: Set<string>): string | null {
  const values = [...set];
  return values.length > 0 ? values.join(',') : null;
}

/** Read a plain string param, falling back when absent. */
export function parseStringParam(
  params: URLSearchParams,
  key: string,
  fallback = '',
): string {
  return params.get(key) ?? fallback;
}

/**
 * Read a param constrained to an allowed set; fall back when absent or not a
 * member. Used for `dir` ('asc' | 'desc') and other small closed vocabularies.
 */
export function parseEnumParam<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = params.get(key);
  return raw != null && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}
