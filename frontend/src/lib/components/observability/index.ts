// Observability component barrel.
//
// Reusable building blocks for execution / liveness surfaces. Centralising
// the imports here means callers write
// `import { StatusBadge, ExecutionRow, LivenessPill } from '$lib/components/observability';`
// regardless of how the components are named on disk.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 2 Task 2.1.

export { default as StatusBadge } from './StatusBadge.svelte';
export { default as ExecutionRow } from './ExecutionRow.svelte';
export { default as LivenessPill } from './LivenessPill.svelte';
export { default as LivenessBadge } from './LivenessBadge.svelte';
export { default as ActivityTray } from './ActivityTray.svelte';
