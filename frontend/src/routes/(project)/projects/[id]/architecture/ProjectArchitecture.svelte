<!--
  ProjectArchitecture — the body of the three /projects/[id]/architecture/<view>
  routes (graph · dependencies · quality-gate). Reuses ArchitectureView scoped
  to the project's code-graph container, ONE view per route. Empty-state when
  un-provisioned.

  NAV STANDARD (validator A2, 2026-10-03): ArchitectureView used to carry its
  own 3-tab strip (Architecture Graph / Dependency Report / Quality Gate) under
  one route. Each view is a route + a row in the project rail's "Architecture"
  group now; /projects/[id]/architecture is a 308 to the graph.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { apiClient } from '$lib/api/unified-client';
  import { loadProject } from '$lib/projects/load-project';
  import ArchitectureView, {
    type ArchitectureViewKind,
  } from '$lib/components/architecture/ArchitectureView.svelte';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import type { Project } from '$lib/types/api';

  let { view }: { view: ArchitectureViewKind } = $props();

  // Same words as the project rail rows (navConfig PROJECT_NAV architecture-*)
  // and pageTitle.ts TITLES.
  const TITLES: Record<ArchitectureViewKind, { title: string; subtitle: string }> = {
    architecture: {
      title: 'Project architecture graph',
      subtitle: "The as-built code graph of this project's container.",
    },
    dependencies: {
      title: 'Project dependency report',
      subtitle: "Dependency analysis of this project's container.",
    },
    quality: {
      title: 'Project quality gate',
      subtitle: "The code-graph quality gate for this project's container.",
    },
  };

  const projectId = $derived($page.params.id ?? '');
  let project = $state<Project | null>(null);
  // true ⇒ the project read FAILED; every 'not provisioned' / 'not found'
  // message below is unearned while this is set.
  let projectUnreadable = $state(false);
  let loaded = $state(false);

  onMount(async () => {
    if (projectId) {
      const res = await loadProject(projectId);
      project = res.project;
      projectUnreadable = res.unreadable;
    }
    loaded = true;
  });

  const container = $derived(project?.container_name ?? '');
  // Migration 061. THREE-VALUED on purpose — `undefined` is an older backend
  // that does not send the field, and must never collapse into `false`:
  //   true      ⇒ coding-gateway's graph-initialize succeeded; the map is real.
  //   false     ⇒ it did not. Rendering the map here draws an EMPTY graph and
  //               labels it "this project's architecture".
  //   undefined ⇒ UNKNOWN. Also not the map — an unknown graph rendered empty
  //               is the same lie, just without a backend willing to admit it.
  // `container_name` alone cannot tell these apart: a container can exist with
  // no code graph behind it (schema.ts:113-117).
  const graphInitialized = $derived(project?.graph_initialized);

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle($page.url.pathname, project?.name ?? null);
  });
</script>

<ProjectInspectHeader
  {projectId}
  title={TITLES[view].title}
  subtitle={TITLES[view].subtitle}
/>

<div class="p-6">
  {#if !loaded}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if projectUnreadable}
    <p class="text-sm text-[var(--color-warning-text)]" data-testid="project-unreadable">
      The project could not be read, so whether a container is provisioned is unknown. This is a
      failed request, not an unprovisioned project — retry, and report it if it persists.
    </p>
  {:else if !container}
    <div
      class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
    >
      No container is provisioned for this project yet. Provision a repository to populate the
      architecture model.
    </div>
  {:else if graphInitialized === false}
    <div
      class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
      data-testid="project-graph-uninitialized"
    >
      A container exists but the code graph was never initialised — this page would otherwise
      render an empty map as your architecture. Re-provision the repository to build the graph.
    </div>
  {:else if graphInitialized === undefined}
    <div
      class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
      data-testid="project-graph-unknown"
    >
      Whether this project's code graph was initialised is UNKNOWN — this backend does not report
      it. That is not the same as knowing it was never initialised, so the map is withheld rather
      than shown empty and presented as fact.
    </div>
  {:else}
    <ArchitectureView containerName={container} {view} />
  {/if}
</div>
