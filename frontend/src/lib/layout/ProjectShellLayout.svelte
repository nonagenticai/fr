<script lang="ts">
  // The project shell (fr-agui SPEC §7.2, George OQ-3 2026-10-14: "a project
  // should have its own entire page"). Rendered by the root layout for every
  // route in the `(project)` group — i.e. every page under /projects/[id]/**.
  //
  // Top: TopNav, the one app bar (brand, sections, Workspace › Project switchers,
  // andon, liveness, user menu) — the same bar the tenant shell mounts.
  // Left: the project's own nav (SidebarNav in project mode — the main rows
  // (Overview … Plan & scope) + one collapsible Details group, and a "← Workspace" exit; the tenant
  // zones and tenant admin are NOT rendered). Middle: the licence banner as the
  // tenant shell keeps it, then the project header strip, then the page. Right: the agent rail, bound to the project by
  // the (project) layout (P1a keeps the existing rail as-is; P1c retires the
  // tenant rail).
  import type { Snippet } from 'svelte';
  import SidebarNav from './SidebarNav.svelte';
  import TopNav from './TopNav.svelte';
  import AgentRail from './AgentRail.svelte';
  import ProjectShellHeader from './ProjectShellHeader.svelte';
  import ProjectHaltBanner from '$lib/components/ProjectHaltBanner.svelte';
  import ProjectStartAgainBanner from '$lib/components/ProjectStartAgainBanner.svelte';
  import LicenseExpiringBanner from '$lib/components/LicenseExpiringBanner.svelte';
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { sidebar } from '$lib/stores/sidebar.svelte';

  let { children, onOpenActivity }: { children: Snippet; onOpenActivity?: () => void } = $props();
</script>

<div class="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
<TopNav {onOpenActivity} />
<div
  data-testid="project-shell"
  class="grid min-h-0 flex-1 overflow-hidden"
  style:grid-template-columns={`${sidebar.collapsed ? '64px' : '220px'} 1fr ${agentRail.isOpen ? '380px' : '0px'}`}
>
  <SidebarNav />
  <main class="flex min-w-0 flex-col overflow-hidden">
    <LicenseExpiringBanner />
    <ProjectShellHeader />
    <ProjectHaltBanner />
    <ProjectStartAgainBanner />
    <div class="flex-1 overflow-y-auto p-6">
      {@render children()}
    </div>
  </main>
  <AgentRail />
</div>
</div>
