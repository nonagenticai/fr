// src/lib/layout/pageTitle.svelte.ts
// ===========================================================================
// The runtime half of the page title: a page pushing the name of the entity it
// just loaded (a card's title, a report's title, a department's name).
//
// Split from `pageTitle.ts` on purpose. Everything that DECIDES a title is pure
// and unit-tested over there; this file holds only the reactive cell, so the
// rule with the consequence never needs a browser to test.
//
// Shape mirrors the other $state-class singletons in `lib/stores/*.svelte.ts`
// (commandPalette, sidebar).
//
// The override is PATH-KEYED, and that is the whole design. `resolveTitle`
// honours it only when its `path` equals the live pathname, so a value left
// behind by a page that has navigated away cannot be rendered — no unmount
// ordering, no missed `clear()`, and no race can produce a stale tab. Callers
// therefore do not have to clear on unmount for correctness; they pass their
// own `$page.url.pathname` and the resolver does the rest.
// ===========================================================================

import type { PageTitleOverride } from './pageTitle';

class PageTitleStore {
  /** The pending override, or null when no page has pushed one. */
  value = $state<PageTitleOverride | null>(null);
}

const store = new PageTitleStore();

/**
 * Push the loaded entity's name for `path` (pass the page's own pathname).
 *
 * A null / undefined / blank title CLEARS the override — but only when the
 * stored override belongs to `path`. Clearing is scoped that way so a late
 * teardown from the previous page cannot wipe the title the NEW page has
 * already set; the resolver's path check makes that harmless either way, but
 * there is no reason to let a page mutate another page's state.
 */
export function setPageTitle(path: string, title: string | null | undefined): void {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) {
    if (store.value?.path === path) store.value = null;
    return;
  }
  store.value = { path, title: trimmed };
}

/** The pending override. Reactive: reads inside a `$derived` re-run on change. */
export function getPageTitleOverride(): PageTitleOverride | null {
  return store.value;
}
