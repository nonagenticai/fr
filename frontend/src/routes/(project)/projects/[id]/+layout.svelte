<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/stores';
  import { onDestroy } from 'svelte';
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { activeProject } from '$lib/stores/activeProject.svelte';

  let { children }: { children: Snippet } = $props();

  // Pin the project context while the user is on /projects/[id]/* so a fresh
  // thread opened from the rail is automatically project-scoped, AND mark the
  // active project so the project rail (main rows + Details) + Header switcher +
  // proj-ctx phase chip render. The full summary (name + phase) resolves from
  // the switcher list; setActive seeds an id-stub so the shell renders at once.
  // Keyed on the id ALONE (via `$derived`): the effect used to read `$page`
  // wholesale, so every in-project navigation re-ran setActive + load() and
  // re-rendered the sidebar's project block — which is why the cockpit sidebar
  // jumped on every click.
  const projectId = $derived($page.params.id);
  $effect(() => {
    const id = projectId;
    if (id) {
      agentRail.setProjectContext(id);
      activeProject.open(id);
      void activeProject.load();
      // Cleanup captures THIS id: it runs when the id changes (A → B) and on
      // unmount. Reading `projectId` in onDestroy instead could see the NEXT
      // route's params (undefined after leaving), leaving "open" set forever.
      return () => activeProject.leaveRoute(id);
    }
  });

  // Leaving the subtree drops the RAIL's project context, but NOT the selected
  // project: the selection persists across Kanban / Approvals / Home etc. (UI
  // review 2026-10-07 — clearing it here is what made the header selection
  // look random).
  onDestroy(() => {
    agentRail.clearProjectContext();
  });
</script>

{@render children()}
