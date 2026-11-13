// Shared types for the Tabs bar (single-route view toggles). The URL-synced
// AssetTabs hub primitive and its `?tab=` resolver were deleted with their last
// consumer (nav standard, 2026-10-03) — see ./index.ts.

export interface TabDef {
  id: string;
  label: string;
  /** Optional count/label rendered as a pill on the tab. Falsy (0 / '') hides it. */
  badge?: number | string;
  /**
   * Optional section id grouping this tab into a labelled cluster in the bar.
   * Purely a bar-layout hint (see `TabGroup`); it does not affect active-tab
   * resolution, deep-linking, or panel mounting. When no tab sets it — and no
   * `groups` are passed to Tabs — the bar renders as a single flat row,
   * the default that every non-grouped consumer keeps.
   */
  group?: string;
}

/**
 * A labelled tab section, in render order. Passed to Tabs as `groups` to
 * switch the bar from a flat row to labelled clusters: each section collects
 * the tabs whose `TabDef.group` equals its `id`. Empty sections are dropped and
 * tabs matching no section fall into a trailing unlabelled cluster.
 */
export interface TabGroup {
  id: string;
  label: string;
}
