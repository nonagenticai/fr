<!--
  ArchitectureGovernance — the Architecture Governance (conformance) surface,
  rendered by the two /govern/architecture/<view> routes.

  NAV STANDARD (owner ruling 2026-10-03): this was /govern/architecture with an
  AssetTabs strip. Tab hubs are not exempt from "no menu inside a page", so each
  tab is now a route + a row in the rail's "Conformance" sub-group, and this
  component renders ONE `view`. /govern/architecture is a 308 that maps the
  legacy `?tab=`. The Proposals view (the LLM-mapped proposals queue) was
  removed with requirements_management's proposals route (RM #238); a legacy
  `?tab=queue` lands on the dashboard.

  The `?projectId=` query is the page state. A rail row is a bare path, so the
  last value is kept in module memory and restored (with replaceState) when a
  view opens without it — switching views via the rail keeps the project,
  exactly as switching tabs did.

  ⛔ That memory is SCOPED to (signed-in user, active tenant) and is dropped the
  moment either changes or the user signs out: a project id remembered in one
  workspace must never be re-injected into another (validator D1, 2026-10-03).
  And because a restored ?projectId= hides the project picker, the header
  carries an explicit "Change project" control that forgets the selection and
  shows the picker again — without it the picker was unreachable for the rest
  of the session.

  P3.1 + P3.2 of the fr Architecture Governance lane (plan:
  ~/.claude/plans/fr-phase-5-architecture-lucky-fog.md). Read-only conformance
  surface over the deterministic upstream tool shipped in
  `requirements_management` PR #31 (P2), exposed in fr via the BFF at
  `GET /api/governance/architecture/conformance?projectId=<uuid>`.

  Views (formerly AssetTabs panels): Dashboard (summary cards + findings lists, with honest
  empty-state branching) and Graph (conformance overlay extending the same D3
  primitives used by TraceabilityGraph). Row + node click-throughs land on the
  existing /library/architecture/{elements,relationships}/{id} detail pages —
  no new edit UI in P3.

  Project scoping: `?projectId=<uuid>` query param (fr has no global "current
  project" store yet; the /measure page uses the same convention).

  Honest empty-state: the upstream returns `realization_coverage = 1.0` when
  `total_application_components === 0` — `isEmptyModel()` branches on the
  count, NOT the score, so "no model" never reads as "100% conformant".
-->
<script lang="ts" module>
  // Last project seen by any view — survives client navigation between the
  // routes (see the header). Never persisted. `key` is
  // `<user id>|<active tenant id>`; a mismatch means "forget".
  let remembered: { key: string; projectId: string } | null = null;

  export type GovernanceView = 'dashboard' | 'graph';
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    getArchitectureConformance,
    isEmptyModel,
    type ArchitectureConformanceResult,
  } from '$lib/api/governance';
  import ConformanceOverlayGraph from '$lib/components/conformance/ConformanceOverlayGraph.svelte';
  import { deriveConformanceGraph } from '$lib/components/conformance/derive';
  import { auth } from '$lib/stores/auth.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';

  let { view }: { view: GovernanceView } = $props();

  // Same words as the rail rows (navConfig 'conformance-*') and TITLES.
  const VIEW_TITLES: Record<GovernanceView, string> = {
    dashboard: 'Conformance dashboard',
    graph: 'Conformance graph',
  };

  let projectIdInput = $state('');
  let result = $state<ArchitectureConformanceResult | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let cached = $state(false);

  // Drive the fetch from the URL ?projectId — keeps the page deep-linkable.
  const projectId = $derived(page.url.searchParams.get('projectId') ?? '');

  // Whose memory this is: signed-in user + the tenant the next request carries.
  // '' (signed out, or no tenant yet) remembers nothing.
  const memoryKey = $derived(
    auth.user?.id && workspaces.scopeKey ? `${auth.user.id}|${workspaces.scopeKey}` : '',
  );

  // Carry the project across the view routes (header note).
  $effect(() => {
    const url = new URL(page.url.href);
    const key = memoryKey;
    const pid = url.searchParams.get('projectId') ?? '';
    // Signed out, or user / tenant switched: forget, never carry across.
    if (!key || (remembered && remembered.key !== key)) remembered = null;
    if (!key) return;
    if (pid) {
      remembered = { key, projectId: pid };
      return;
    }
    if (!remembered) return;
    const next = new URL(url);
    next.searchParams.set('projectId', remembered.projectId);
    goto(`${next.pathname}?${next.searchParams.toString()}`, { replaceState: true, reset: false });
  });

  /** Forget the selection (this tenant's memory too) and show the picker. */
  function changeProject(): void {
    remembered = null;
    projectIdInput = '';
    const url = new URL(page.url.href);
    url.searchParams.delete('projectId');
    const qs = url.searchParams.toString();
    goto(qs ? `${url.pathname}?${qs}` : url.pathname, { reset: false });
  }

  $effect(() => {
    const id = projectId;
    if (!id) {
      result = null;
      error = null;
      return;
    }
    loading = true;
    error = null;
    getArchitectureConformance(id)
      .then((env) => {
        result = env.data;
        cached = env.meta.cached;
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
        result = null;
      })
      .finally(() => {
        loading = false;
      });
  });

  function submitProject(e: Event) {
    e.preventDefault();
    const id = projectIdInput.trim();
    if (!id) return;
    const url = new URL(page.url.href);
    url.searchParams.set('projectId', id);
    goto(`${url.pathname}?${url.searchParams.toString()}`, { reset: false });
  }

  function pct(v: number): string {
    return `${(v * 100).toFixed(0)}%`;
  }

  function elementHref(id: string): string {
    return `/library/architecture/elements/${id}`;
  }

  const graphData = $derived(result ? deriveConformanceGraph(result) : { nodes: [], links: [] });
</script>

<div class="px-6 py-4 flex flex-col gap-4" data-testid="govern-architecture" data-view={view}>
  <header>
    <h1 class="text-2xl font-semibold text-[var(--color-text)]">{VIEW_TITLES[view]}</h1>
    <p class="mt-1 text-sm text-[var(--color-text-muted)]">
      As-designed (ArchiMate) versus as-built (code-graph) conformance. Read-only;
      findings link to the matching element / relationship pages.
    </p>
    {#if projectId}
      <p class="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]" data-testid="govern-architecture-project">
        Project <code class="font-mono text-[var(--color-text)]">{projectId}</code>
        <button
          type="button"
          onclick={changeProject}
          class="rounded-md border border-[var(--color-border-strong)] px-2 py-0.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
          data-testid="govern-architecture-change-project"
        >
          Change project
        </button>
      </p>
    {/if}
  </header>

  {#if !projectId}
    <section
      class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)] p-6 flex flex-col items-start gap-3"
      data-testid="govern-architecture-no-project"
    >
      <h2 class="text-lg font-medium text-[var(--color-text)]">Pick a project</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Conformance is per-project — enter or paste a project id to load its
        Architecture Governance state.
      </p>
      <form onsubmit={submitProject} class="flex gap-2 items-center w-full max-w-xl">
        <input
          type="text"
          bind:value={projectIdInput}
          placeholder="project id (uuid)"
          class="flex-1 px-3 py-2 text-sm rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text)]"
          data-testid="govern-architecture-project-input"
        />
        <button
          type="submit"
          class="px-3 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50"
          disabled={!projectIdInput.trim()}
        >
          Load
        </button>
      </form>
    </section>
  {:else}
    <!-- The Dashboard and Graph branches handle their own loading /
         empty-model / error states. -->
        {#if view === 'dashboard'}
          {#if loading && !result}
            <p class="text-sm text-[var(--color-text-muted)]">Loading conformance…</p>
          {:else if error}
            <section
              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)] p-4"
              data-testid="govern-architecture-error"
            >
              <p class="text-sm text-[var(--color-danger)]">Failed to load: {error}</p>
            </section>
          {:else if result && isEmptyModel(result)}
            <!-- Honest empty-state: the score is 1.0 because there's nothing
                 modelled, NOT because everything is conformant. -->
            <section
              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)] p-6 flex flex-col items-start gap-3"
              data-testid="govern-architecture-empty-model"
            >
              <h2 class="text-lg font-medium text-[var(--color-text)]">No model yet</h2>
              <p class="text-sm text-[var(--color-text-muted)]">
                This project has no Application Components authored. Conformance is
                undefined on an empty model — author one to begin.
              </p>
              <a
                href="/library/architecture/elements/new?layer=application&element_type=application_component"
                class="px-3 py-2 text-sm rounded-md bg-[var(--color-accent)] text-white hover:opacity-90"
              >
                Add an Application Component
              </a>
            </section>
          {:else if result}
            {@const r = result}
          <div class="flex flex-col gap-6" data-testid="govern-architecture-dashboard">
            <!-- Summary cards: coverage / score / illegal count -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)] p-4"
              >
                <p class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  Realization coverage
                </p>
                <p class="mt-1 text-3xl font-semibold text-[var(--color-text)]">
                  {pct(r.summary.realization_coverage)}
                </p>
                <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                  {r.realization_coverage.realized_count}
                  of
                  {r.realization_coverage.total_application_components}
                  Application Components realized
                </p>
              </div>
              <div
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)] p-4"
              >
                <p class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  Dependency conformance
                </p>
                <p class="mt-1 text-3xl font-semibold text-[var(--color-text)]">
                  {pct(r.summary.conformance_score)}
                </p>
                <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                  {r.dependency_conformance.matched.length} matched
                  · {r.dependency_conformance.missing.length} missing
                  · {r.dependency_conformance.extra.length} extra
                </p>
              </div>
              <div
                class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)] p-4"
              >
                <p class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  Illegal dependencies
                </p>
                <p
                  class="mt-1 text-3xl font-semibold"
                  style="color: var({r.summary.illegal_count > 0
                    ? '--color-danger'
                    : '--color-text'})"
                >
                  {r.summary.illegal_count}
                </p>
                <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                  layer-order violations
                </p>
              </div>
            </div>

            <!-- Findings: three lists driven directly off the response. Rows
                 click-through to the existing /library/architecture detail
                 pages — no new edit UI in P3. -->
            <section>
              <h3 class="text-sm font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Unrealized Application Components
              </h3>
              {#if r.realization_coverage.unrealized.length === 0}
                <p class="mt-2 text-sm text-[var(--color-text-muted)]">
                  None — every Application Component has at least one realizing Artifact.
                </p>
              {:else}
                <ul class="mt-2 divide-y divide-[var(--color-border)]">
                  {#each r.realization_coverage.unrealized as el (el.id)}
                    <li class="py-2">
                      <a
                        href={elementHref(el.id)}
                        class="text-sm text-[var(--color-text)] hover:underline"
                      >
                        {el.title}
                      </a>
                      <span class="ml-2 text-xs text-[var(--color-text-muted)]">{el.layer}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>

            <section>
              <h3 class="text-sm font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Orphan Artifacts
              </h3>
              {#if r.realization_coverage.orphan_artifacts.length === 0}
                <p class="mt-2 text-sm text-[var(--color-text-muted)]">
                  None — every bound Artifact has a realization edge.
                </p>
              {:else}
                <ul class="mt-2 divide-y divide-[var(--color-border)]">
                  {#each r.realization_coverage.orphan_artifacts as el (el.id)}
                    <li class="py-2">
                      <a
                        href={elementHref(el.id)}
                        class="text-sm text-[var(--color-text)] hover:underline"
                      >
                        {el.title}
                      </a>
                      <span class="ml-2 text-xs text-[var(--color-text-muted)]">{el.layer}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>

            <section data-testid="govern-architecture-unbound">
              <div class="flex flex-wrap items-baseline gap-3">
                <h3 class="text-sm font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  Unbound code units
                  {#if r.realization_coverage.unbound_code_units.length > 0}
                    <span class="text-[var(--color-text)]">
                      ({r.realization_coverage.unbound_code_units.length})
                    </span>
                  {/if}
                </h3>
              </div>
              {#if r.realization_coverage.unbound_code_units.length === 0}
                <p class="mt-2 text-sm text-[var(--color-text-muted)]">
                  None — every detected code unit is bound to an Artifact.
                </p>
              {:else}
                <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                  Code detected by the graph that no Artifact realizes yet.
                </p>
                <ul class="mt-2 divide-y divide-[var(--color-border)]">
                  {#each r.realization_coverage.unbound_code_units as unit (unit.container + '::' + unit.id)}
                    <li class="py-2 flex flex-wrap items-baseline gap-2">
                      <span class="text-sm text-[var(--color-text)]">{unit.name}</span>
                      <code class="text-xs text-[var(--color-text-muted)]">{unit.container}</code>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>

            <section data-testid="govern-conformance-findings">
              <h3 class="text-sm font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Dependency conformance
              </h3>
              {#if r.dependency_conformance.missing.length === 0 && r.dependency_conformance.extra.length === 0}
                <p class="mt-2 text-sm text-[var(--color-text-muted)]">
                  None — every designed dependency is realized, and no extra realized dependencies exist.
                </p>
              {:else}
                {#if r.dependency_conformance.missing.length > 0}
                  <p class="mt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                    Missing — designed but not realized
                  </p>
                  <ul class="mt-1 divide-y divide-[var(--color-border)]">
                    {#each r.dependency_conformance.missing as edge (edge.source.id + '->' + edge.target.id)}
                      <li class="py-2 text-sm text-[var(--color-text)]">
                        <a href={elementHref(edge.source.id)} class="hover:underline">{edge.source.title}</a>
                        <span class="text-[var(--color-text-muted)] mx-1">→</span>
                        <a href={elementHref(edge.target.id)} class="hover:underline">{edge.target.title}</a>
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if r.dependency_conformance.extra.length > 0}
                  <p class="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                    Extra — realized but not designed
                  </p>
                  <ul class="mt-1 divide-y divide-[var(--color-border)]">
                    {#each r.dependency_conformance.extra as edge (edge.source.id + '->' + edge.target.id)}
                      <li class="py-2 text-sm text-[var(--color-text)]">
                        <a href={elementHref(edge.source.id)} class="hover:underline">{edge.source.title}</a>
                        <span class="text-[var(--color-text-muted)] mx-1">→</span>
                        <a href={elementHref(edge.target.id)} class="hover:underline">{edge.target.title}</a>
                      </li>
                    {/each}
                  </ul>
                {/if}
              {/if}
            </section>

            <section>
              <h3 class="text-sm font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Illegal dependencies
              </h3>
              {#if r.illegal_dependencies.illegal_dependencies.length === 0}
                <p class="mt-2 text-sm text-[var(--color-text-muted)]">
                  None — every realized dependency respects the layer order.
                </p>
              {:else}
                <ul class="mt-2 divide-y divide-[var(--color-border)]">
                  {#each r.illegal_dependencies.illegal_dependencies as edge (edge.source.id + '->' + edge.target.id)}
                    <li class="py-2 flex flex-col gap-1">
                      <div class="text-sm text-[var(--color-text)]">
                        <a href={elementHref(edge.source.id)} class="hover:underline">
                          {edge.source.title}
                        </a>
                        <span class="text-[var(--color-text-muted)] mx-1">→</span>
                        <a href={elementHref(edge.target.id)} class="hover:underline">
                          {edge.target.title}
                        </a>
                      </div>
                      <p class="text-xs text-[var(--color-text-muted)]">
                        {edge.source_layer} → {edge.target_layer} · {edge.reason}
                      </p>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>

            {#if cached}
              <p class="text-xs text-[var(--color-text-muted)]">Served from 60s cache.</p>
            {/if}
          </div>
          {/if}
        {:else if view === 'graph'}
          {#if loading && !result}
            <p class="text-sm text-[var(--color-text-muted)]">Loading conformance…</p>
          {:else if !result}
            <p class="text-sm text-[var(--color-text-muted)]">
              No conformance data yet — load it on Conformance dashboard.
            </p>
          {:else}
            <div class="h-[640px]" data-testid="govern-architecture-graph">
              <ConformanceOverlayGraph
                data={graphData}
                onnodeclick={(n) => goto(elementHref(n.id))}
              />
            </div>
          {/if}
        {/if}
  {/if}
</div>
