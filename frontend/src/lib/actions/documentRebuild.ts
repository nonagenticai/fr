// src/lib/actions/documentRebuild.ts
//
// A full document rebuild — the one mechanism that re-runs EVERY surface's
// data fetch regardless of how that surface fetches.
//
// It is its own module for exactly one reason: it must be mockable. `switchTenant`
// is the caller, and `window.location.reload` cannot be spied on in jsdom
// (`location` is non-configurable and jsdom answers a real call with
// "Not implemented: navigation"), so a test of the switch would either explode
// or, worse, quietly assert nothing. A separate module can be `vi.mock`ed, which
// is how every other seam in this codebase is tested.
//
// ⚠️ The return value is load-bearing, not decoration. `false` means there was no
// document to rebuild (SSR, a non-browser test env) and the caller MUST fall
// through to whatever soft path it has — a rebuild that silently did nothing,
// reported as done, is the shape that produced the defect this exists to fix.

/**
 * Reload the current document, preserving the URL (path + query, so a filtered
 * list comes back filtered).
 *
 * @returns `true` if the reload was issued, `false` if there is no document.
 */
export function rebuildDocument(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  window.location.reload();
  return true;
}
