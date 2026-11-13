<!--
  KagPage — the frame every /library/kag/<kind> route shares.

  /library/kag was an AssetTabs hub with twelve tabs in four sections
  (Knowledge · Explore · Ask · Verify). Nav standard (owner ruling 2026-10-03):
  tab hubs are not exempt, so each tab is its own route and sidebar row, folded
  under the rail's collapsible "KAG" sub-group (navConfig NAV_SUB_GROUPS). The
  tab bodies are the same components as before (KagAskSearchTab, …), mounted
  as the page; this frame only gives them the page heading the hub used to.
  /library/kag itself is a 308 that also maps the legacy `?tab=<id>`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    testid,
    actions,
    children,
  }: { title: string; testid: string; actions?: Snippet; children: Snippet } = $props();
</script>

<div class="px-6 py-4 flex flex-col gap-4" data-testid={testid}>
  <header class="flex items-baseline justify-between gap-4">
    <h1 class="text-2xl font-semibold">{title}</h1>
    {@render actions?.()}
  </header>
  {@render children()}
</div>
