<!--
  ScopePill.svelte
  =================
  Tiny W/D/P chip that marks a Library entry's owning scope.

  Spec: docs/archive/2026-04-27-foundation-design.md §6.4 (4)
        ".. with source labels (W / D / P chips) .."
  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 13.

  Visual decision: Pill (Plan 1 primitive) is a 24px-tall pill with text-xs
  padding (`h-6 px-2`); the scope chip wants a square 20x20 micro-marker that
  fits inline next to a row title. We keep the design-token colour mapping
  (workspace = warning/amber, department = accent/sky, project = success /
  emerald) but render a standalone small square so it doesn't visually
  conflict with the larger Pill tones used elsewhere on the same row.
-->
<script lang="ts">
  type Scope = 'workspace' | 'department' | 'project';

  let { scope }: { scope: Scope } = $props();

  const letter = $derived(
    scope === 'workspace' ? 'W' : scope === 'department' ? 'D' : 'P'
  );

  // Colour maps onto the design tokens from Plan 1 so light/dark theming
  // tracks the rest of the UI. These are the same semantic buckets Pill.svelte
  // uses for `warning` / `accent` / `success`, just at micro-chip size.
  const cls = $derived(
    {
      workspace:
        'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]',
      department:
        'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent-border)]',
      project:
        'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success-border)]',
    }[scope]
  );
</script>

<span
  data-testid="scope-pill"
  data-scope={scope}
  class={`inline-flex items-center justify-center w-5 h-5 text-[10px] font-medium border rounded ${cls}`}
  aria-label={`${scope} scope`}
>
  {letter}
</span>
