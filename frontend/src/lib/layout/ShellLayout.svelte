<script lang="ts">
  import type { Snippet } from 'svelte';
  import TopNav from './TopNav.svelte';
  import SidebarNav from './SidebarNav.svelte';
  import { sectionForPath } from './navConfig';
  import { sidebar } from '$lib/stores/sidebar.svelte';
  import AgentRail from './AgentRail.svelte';
  import TenantSidePane from './TenantSidePane.svelte';
  import { page } from '$app/state';
  import { tenantRailKind } from '$lib/agent/doorway';
  import { agentRail } from '$lib/stores/agentRail.svelte';

  let { children, onOpenActivity }: { children: Snippet; onOpenActivity?: () => void } = $props();

  // fr-agui SPEC §5.1 / §13 P1c (OQ-17 = c): the tenant rail is retired. The
  // agent mounts on a tenant page ONLY in doorway mode (projects/new, /intake,
  // /requests[/id]); every other tenant page gets the side pane with "Open a
  // project to use the agent" + a project picker (and the [Detail] pane).
  const railKind = $derived(tenantRailKind(page.url.pathname));
  const section = $derived(sectionForPath(page.url.pathname));
</script>

<!-- TopNav (the one app bar) spans the page; below it the active section's sidebar, the page and the right pane. -->
<div class="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
<TopNav {onOpenActivity} />
<div
  class="grid min-h-0 flex-1 overflow-hidden"
  style:grid-template-columns={`${sidebar.collapsed ? '64px' : '220px'} 1fr ${agentRail.isOpen ? '380px' : '0px'}`}
>
  <SidebarNav {section} />
  <main class="flex min-w-0 flex-col overflow-hidden">
    {@render children()}
  </main>
  {#if railKind === 'doorway'}
    <AgentRail />
  {:else}
    <TenantSidePane />
  {/if}
</div>
</div>
