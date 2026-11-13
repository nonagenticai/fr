// Tabs — the presentational tab bar for SINGLE-ROUTE view toggles (a filter or
// an overlay switch inside one page: LiveExecutionTimeline, WorkflowGraphDiff,
// PromptQueue). It is NOT a router.
//
// The URL-synced AssetTabs hub primitive that lived here was deleted with its
// last consumer (nav standard, owner ruling 2026-10-03): a set of tabs that
// are each a page is a menu inside a page, so every former hub tab is now its
// own route + sidebar row. routes/no-in-page-nav.test.ts keeps it out.

export { default as Tabs } from './Tabs.svelte';
export { type TabDef, type TabGroup } from './types';
