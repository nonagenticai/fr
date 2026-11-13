<!--
  /projects/[id]/governance — as-built vs as-designed conformance (INSPECT).
  Reuses getArchitectureConformance (the summary verdict). The architecture
  proposals queue was removed with requirements_management's proposals route
  (RM #238).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { apiClient } from '$lib/api/unified-client';
  import { loadProject } from '$lib/projects/load-project';
  import {
    getArchitectureConformance,
    isEmptyModel,
    type ArchitectureConformanceResult,
  } from '$lib/api/governance';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import type { Project } from '$lib/types/api';

  const projectId = $derived(page.params.id ?? '');
  let project = $state<Project | null>(null);
  // true ⇒ the project read FAILED; every 'not provisioned' / 'not found'
  // message below is unearned while this is set.
  let projectUnreadable = $state(false);
  let result = $state<ArchitectureConformanceResult | null>(null);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  const container = $derived(project?.container_name ?? '');

  onMount(async () => {
    if (!projectId) {
      loaded = true;
      return;
    }
    const res = await loadProject(projectId);
    project = res.project;
    projectUnreadable = res.unreadable;
    try {
      const env = await getArchitectureConformance(projectId);
      result = env.data;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load conformance';
    } finally {
      loaded = true;
    }
  });

  const pct = (n: number): string => `${Math.round(n * 100)}%`;

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle(page.url.pathname, project?.name ?? null);
  });
</script>

<ProjectInspectHeader
  {projectId}
  title="Governance"
  subtitle="As-built vs as-designed — does the realised system conform to the architecture model?"
/>

<div class="space-y-6 p-6">
  {#if !loaded}
    <p class="text-sm text-[var(--color-text-muted)]">Loading conformance…</p>
  {:else}
    {#if error}
      <div
        class="rounded-[var(--radius-sm)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]"
      >
        {error}
      </div>
    {:else if result && !isEmptyModel(result)}
      <div class="space-y-2">
        <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        {#each [{ label: 'Realization coverage', value: pct(result.summary.realization_coverage) }, { label: 'Conformance score', value: pct(result.summary.conformance_score) }, { label: 'Illegal dependencies', value: String(result.summary.illegal_count) }, { label: 'Unrealized components', value: String(result.summary.unrealized_components) }] as m (m.label)}
          <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <p class="text-2xl font-bold text-[var(--color-text)]">{m.value}</p>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">{m.label}</p>
          </div>
        {/each}
        </div>
        <p data-testid="conformance-scope" class="text-xs text-[var(--color-text-muted)]">
          {#if container || projectUnreadable}
            Measured across this project’s whole architecture model — not per code container.
          {:else}
            <!-- UI review 2026-10-07: with no container these counts are the
                 WORKSPACE's whole model, not this project's — say so. -->
            Measured across the whole architecture model of this workspace — this project has no
            container, so these counts are not specific to it.
            <a class="underline" href={`/projects/${projectId}/settings`} data-testid="conformance-scope-settings"
              >Set up a container in Settings</a
            >.
          {/if}
        </p>
      </div>
    {:else if result}
      <!--
        isEmptyModel: the upstream returns realization_coverage/conformance_score
        = 1.0 (100%) for a tenant with ZERO application components — showing those
        metrics reads as "perfect compliance" when there's simply nothing modelled
        yet. Suppress them rather than mislead.
      -->
      <div
        class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
      >
        No architecture is modelled for this project yet — nothing to measure conformance against.
      </div>
    {/if}
  {/if}
</div>
