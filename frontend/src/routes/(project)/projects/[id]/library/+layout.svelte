<!--
  /projects/[id]/library/+layout.svelte

  Plain content wrapper for the project-scoped library pages (one per bound
  asset kind). Spec: `bound_assets` mental model — every asset is bound to
  zero or more projects via asset_bindings; each page lists only what is bound
  to the current project.

  This layout used to render a tab strip across the nine kinds plus a
  "← Back to project" link — a menu inside the page. Nav standard (2026-10-03):
  each kind is a row in the project sidebar's Details group (PROJECT_NAV in
  $lib/layout/navConfig.ts), which also carries the way back to the project.
  Artifacts is not one of them: it was a duplicate of the `artifacts` (Outputs)
  row and /projects/[id]/library/artifacts is now a 308 to it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<section class="max-w-5xl mx-auto px-6 py-4">
  {@render children()}
</section>
