<!--
  /decisions — list view, manifest-driven AssetWorkspace shell.

  UI review 2026-10-07: the list was the whole workspace with no way to narrow
  it, and the same ADR title appeared many times. The manifest now opts into a
  status facet and same-title grouping (×N); this page adds a project filter
  that defaults to the selected project.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { decisionsManifest } from '$lib/manifests/decisions';
  import { activeProject } from '$lib/stores/activeProject.svelte';

  // ⚠️ `project_id`, NOT `bound_to`. On `GET /api/assets/decisions`
  // (backend/src/routes/assets/decisions.ts) `project_id` is the EFFECTIVE
  // project scope: decisions the project can see (its own + inherited
  // workspace-scope ones), and an unknown id yields an empty list rather than
  // the whole tenant. `bound_to` filters by EXPLICIT asset binding only — the
  // same narrow population that makes the cockpit's asset strip read 0 on
  // nearly every project — so filtering by it would hide most decisions that
  // actually apply to the project.
  //
  // `''` = every project. `undefined` = the user has not chosen yet, so the
  // selected project (if any) is the default.
  let chosen = $state<string | undefined>(undefined);
  const projectFilter = $derived(chosen ?? activeProject.activeId ?? '');
  const query = $derived<Record<string, string> | undefined>(
    projectFilter ? { project_id: projectFilter } : undefined,
  );

  onMount(() => {
    // Names for the select; a failed list read only costs the names — the
    // filter still works by id, and the active project is always offered.
    if (!activeProject.loaded) void activeProject.load();
  });

  const options = $derived.by(() => {
    const opts = activeProject.projects.map((p) => ({ id: p.id, name: p.name }));
    if (projectFilter && !opts.some((o) => o.id === projectFilter)) {
      opts.unshift({ id: projectFilter, name: activeProject.active?.name ?? projectFilter });
    }
    return opts;
  });
</script>

<div class="flex flex-wrap items-center gap-2 px-6 pt-4 text-sm" data-testid="decisions-project-filter">
  <label for="decisions-project-select" class="text-[var(--color-text-muted)]">Project</label>
  <select
    id="decisions-project-select"
    value={projectFilter}
    onchange={(e) => (chosen = (e.currentTarget as HTMLSelectElement).value)}
    class="rounded border border-[var(--color-border-strong)] px-2 py-1.5 text-sm"
    data-testid="decisions-project-select"
  >
    <option value="">All projects</option>
    {#each options as o (o.id)}
      <option value={o.id}>{o.name}</option>
    {/each}
  </select>
  {#if projectFilter}
    <span class="text-xs text-[var(--color-text-muted)]">
      Decisions visible to this project — its own plus those inherited from the workspace.
    </span>
  {/if}
</div>

<!-- The list reads `query` once on mount, so a filter change remounts it. -->
{#key projectFilter}
  <AssetWorkspace manifest={decisionsManifest} mode="list" {query} />
{/key}
