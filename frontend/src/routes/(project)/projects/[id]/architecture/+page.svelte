<!--
  /projects/[id]/architecture — the project's Architecture hub.

  Architecture is a fundamental part of every project (George, 2026-10-28), so
  it is a MAIN row of the project rail and this page gathers it in one place,
  scoped to THIS project:
    1. the conformance verdict (the same read as the Governance page:
       GET /api/governance/architecture/conformance?projectId=),
    2. the project's ArchiMate / UML models (the modeling API filtered by
       project_id), each opening /library/architecture/models/[id], with
       "New model" / "Import a file" pre-scoped to this project,
    3. the code-graph views (graph, dependencies, quality gate).
  Every empty state says what is missing and offers the action that fills it.
  fr is a facilitator: every verdict shown is the one requirements_management
  stored; nothing here computes one.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { loadProject } from '$lib/projects/load-project';
  import {
    getArchitectureConformance,
    isEmptyModel,
    type ArchitectureConformanceResult,
  } from '$lib/api/governance';
  import { listModels, type ArchitectureModel } from '$lib/api/modeling';
  import { when } from '$lib/modeling/explain';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import type { Project } from '$lib/types/api';

  const projectId = $derived(page.params.id ?? '');
  const base = $derived(`/projects/${encodeURIComponent(projectId)}`);
  const modelsHref = $derived(`/library/architecture/models?project_id=${encodeURIComponent(projectId)}`);

  let project = $state<Project | null>(null);
  let projectUnreadable = $state(false);
  let projectLoaded = $state(false);

  let conformance = $state<ArchitectureConformanceResult | null>(null);
  let conformanceLoaded = $state(false);
  let conformanceError = $state<string | null>(null);

  let models = $state<ArchitectureModel[]>([]);
  let modelsTruncated = $state(false);
  let modelsLoaded = $state(false);
  let modelsError = $state<string | null>(null);

  // Each loader is numbered; only the LATEST call of each may write state. A
  // late response — from a project the user switched away from (A→B, or
  // A→B→A), or from an earlier Try again — is dropped, never shown.
  // Plain counters, not runes: the $effect must not track them.
  let projectSeq = 0;
  let conformanceSeq = 0;
  let modelsSeq = 0;

  async function loadConformance(id: string): Promise<void> {
    const seq = ++conformanceSeq;
    conformanceLoaded = false;
    conformanceError = null;
    let next: ArchitectureConformanceResult | null = null;
    let error: string | null = null;
    try {
      next = (await getArchitectureConformance(id)).data;
    } catch (e) {
      error = e instanceof Error ? e.message : 'The conformance could not be loaded.';
    }
    if (seq !== conformanceSeq) return;
    conformance = next;
    conformanceError = error;
    conformanceLoaded = true;
  }

  async function loadModels(id: string): Promise<void> {
    const seq = ++modelsSeq;
    modelsLoaded = false;
    modelsError = null;
    let next: ArchitectureModel[] = [];
    let truncated = false;
    let error: string | null = null;
    try {
      const res = await listModels({ project_id: id });
      // The filter is the backend's; keep only this project's rows so a
      // looser upstream can never show another project's model here.
      next = res.items.filter((m) => m.project_id === id);
      truncated = res.truncated;
    } catch (e) {
      error = e instanceof Error ? e.message : 'The models could not be loaded.';
    }
    if (seq !== modelsSeq) return;
    models = next;
    modelsTruncated = truncated;
    modelsError = error;
    modelsLoaded = true;
  }

  // Keyed on projectId: a project switch that reuses this component reloads
  // all three reads instead of showing the previous project's data.
  $effect(() => {
    const id = projectId;
    project = null;
    projectUnreadable = false;
    projectLoaded = false;
    conformance = null;
    models = [];
    modelsTruncated = false;
    // Invalidate every in-flight load from the previous project.
    const seq = ++projectSeq;
    conformanceSeq++;
    modelsSeq++;
    if (!id) {
      conformanceError = modelsError = null;
      projectLoaded = conformanceLoaded = modelsLoaded = true;
      return;
    }
    void loadProject(id).then((res) => {
      if (seq !== projectSeq) return;
      project = res.project;
      projectUnreadable = res.unreadable;
      projectLoaded = true;
    });
    void loadConformance(id);
    void loadModels(id);
  });

  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const languageLabel = (l: string): string => (l === 'uml' ? 'UML' : l === 'archimate' ? 'ArchiMate' : l);

  const container = $derived(project?.container_name ?? '');
  const graphInitialized = $derived(project?.graph_initialized);

  $effect(() => {
    setPageTitle(page.url.pathname, project?.name ?? null);
  });

  const card = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
  const empty = 'rounded-lg border border-dashed border-[var(--color-border-strong)] p-4 text-sm text-[var(--color-text-muted)]';
  const primary =
    'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)]';
  const secondary =
    'rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]';
  const link = 'text-sm font-medium text-[var(--color-link)] hover:underline';
</script>

<ProjectInspectHeader
  {projectId}
  title="Architecture"
  subtitle="This project's architecture: does the built system conform, the models that describe it, and its code graph."
/>

<div class="space-y-8 p-6" data-testid="project-architecture-hub">
  <!-- 1. Conformance -->
  <section class="space-y-3" data-testid="hub-conformance">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Conformance</h2>
      <a class={link} href={`${base}/governance`} data-testid="hub-governance-link">Open Governance</a>
    </div>
    {#if !conformanceLoaded}
      <p class="text-sm text-[var(--color-text-muted)]">Loading conformance…</p>
    {:else if conformanceError}
      <div class="flex flex-wrap items-center gap-2" data-testid="hub-conformance-error">
        <p class="text-sm text-[var(--color-danger)]">The conformance could not be loaded: {conformanceError}</p>
        <button type="button" class={link} onclick={() => loadConformance(projectId)}>Try again</button>
      </div>
    {:else if conformance && !isEmptyModel(conformance)}
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="hub-conformance-tiles">
        <div class={card}>
          <p class="text-2xl font-bold text-[var(--color-text)]">{pct(conformance.summary.realization_coverage)}</p>
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">Realization coverage</p>
        </div>
        <div class={card}>
          <p class="text-2xl font-bold text-[var(--color-text)]">{pct(conformance.summary.conformance_score)}</p>
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">Conformance score</p>
        </div>
        <div class={card}>
          <p class="text-2xl font-bold text-[var(--color-text)]">{conformance.summary.illegal_count}</p>
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">Illegal dependencies</p>
        </div>
        <div class={card}>
          <p class="text-2xl font-bold text-[var(--color-text)]">{conformance.summary.unrealized_components}</p>
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">Unrealized components</p>
        </div>
      </div>
      <!-- Same scope statement as the Governance page: without a container the
           counts are the WORKSPACE's whole model, not this project's. -->
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="hub-conformance-scope">
        {#if container || projectUnreadable || !projectLoaded}
          Measured across this project’s whole architecture model — not per code container.
        {:else}
          Measured across the whole architecture model of this workspace — this project has no container, so these
          counts are not specific to it.
        {/if}
      </p>
    {:else}
      <!-- isEmptyModel: zero application components. The upstream then reports
           100% coverage, which is not a score — say there is nothing to measure. -->
      <div class={empty} data-testid="hub-conformance-empty">
        No architecture is modelled for this project yet, so there is nothing to measure conformance against.
        Create or import a model below.
      </div>
    {/if}
  </section>

  <!-- 2. Models -->
  <section class="space-y-3" data-testid="hub-models">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-[var(--color-text)]">Models</h2>
      <div class="flex flex-wrap gap-2">
        <a class={secondary} href={`${modelsHref}&import=1`} data-testid="hub-models-import">Import a file</a>
        <a class={primary} href={`${modelsHref}&new=1`} data-testid="hub-models-new">New model</a>
      </div>
    </div>
    {#if !modelsLoaded}
      <p class="text-sm text-[var(--color-text-muted)]">Loading models…</p>
    {:else if modelsError}
      <div class="flex flex-wrap items-center gap-2" data-testid="hub-models-error">
        <p class="text-sm text-[var(--color-danger)]">The models could not be loaded: {modelsError}</p>
        <button type="button" class={link} onclick={() => loadModels(projectId)}>Try again</button>
      </div>
    {:else if models.length === 0}
      <div class={empty} data-testid="hub-models-empty">
        No architecture model yet for this project.
        <a class="font-medium text-[var(--color-link)] underline" href={`${modelsHref}&new=1`}>Create an ArchiMate or UML model</a>
        or
        <a class="font-medium text-[var(--color-link)] underline" href={`${modelsHref}&import=1`}>import an ArchiMate exchange file</a>.
      </div>
    {:else}
      <ul class="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]" data-testid="hub-models-list">
        {#each models as m (m.id)}
          <li class="flex flex-wrap items-center justify-between gap-2 px-4 py-3" data-testid="hub-model-row">
            <div class="min-w-0">
              <a class="font-medium text-[var(--color-link)] hover:underline" href={`/library/architecture/models/${encodeURIComponent(m.id)}`}>{m.title}</a>
              <span class="ml-2 text-xs text-[var(--color-text-muted)]">{languageLabel(m.language)}</span>
              {#if m.description}<p class="truncate text-xs text-[var(--color-text-muted)]">{m.description}</p>{/if}
            </div>
            <div class="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
              <span>{m.published_revision_id ? 'Published' : 'Not published yet'}</span>
              <span>Changed {when(m.updated_at)}</span>
            </div>
          </li>
        {/each}
      </ul>
      <p class="text-xs text-[var(--color-text-muted)]">
        {#if modelsTruncated}Only the first models are shown. {/if}
        <a class="text-[var(--color-link)] hover:underline" href={modelsHref} data-testid="hub-models-all">Search this project's models in the library</a>
      </p>
    {/if}
  </section>

  <!-- 3. Code graph -->
  <section class="space-y-3" data-testid="hub-code-graph">
    <h2 class="text-base font-semibold text-[var(--color-text)]">Code graph</h2>
    {#if projectLoaded && !projectUnreadable && !container}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="hub-code-graph-no-container">
        No code container is provisioned for this project yet, so the views below have nothing to show.
        <a class="text-[var(--color-link)] underline" href={`${base}/settings`}>Provision it in Settings</a>.
      </p>
    {:else if projectLoaded && container && graphInitialized === false}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="hub-code-graph-uninitialized">
        A container exists but its code graph was never initialised. Re-provision the repository in
        <a class="text-[var(--color-link)] underline" href={`${base}/settings`}>Settings</a> to build it.
      </p>
    {/if}
    <div class="grid gap-3 md:grid-cols-3">
      <a class={`${card} block hover:border-[var(--color-border-strong)]`} href={`${base}/architecture/graph`} data-testid="hub-link-graph">
        <p class="font-medium text-[var(--color-text)]">Architecture graph</p>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">The as-built code graph of this project's container.</p>
      </a>
      <a class={`${card} block hover:border-[var(--color-border-strong)]`} href={`${base}/architecture/dependencies`} data-testid="hub-link-dependencies">
        <p class="font-medium text-[var(--color-text)]">Dependency report</p>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">Dependencies, vulnerable and critical ones first.</p>
      </a>
      <a class={`${card} block hover:border-[var(--color-border-strong)]`} href={`${base}/architecture/quality-gate`} data-testid="hub-link-quality-gate">
        <p class="font-medium text-[var(--color-text)]">Quality gate</p>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">The code-graph quality gate for this container.</p>
      </a>
    </div>
  </section>
</div>
