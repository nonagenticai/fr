<!--
  /projects/[id]/artifacts — the project's OUTPUTS (rail row "Outputs").

  R3 / DOC-3 (FR-PROJECT-HOME-REDESIGN-2026-10-26 §3, §7.1): a project run by the conveyor shows
  its DOCUMENT TRAIL (GET /api/projects/:id/outputs) — the final report first, then the documents
  and pull requests per phase; each document opens in the reader (/projects/[id]/documents/[aid]).
  A project the conveyor does not run (`available: false`) keeps the previous page: the PRs on its
  approved cards, the RM assets and the hand-bound artifacts (ProjectLibraryTab).
  Three states, never collapsed: reading / failed read (NOT "nothing produced") / loaded.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { apiClient } from '$lib/api/unified-client';
  import { deliveredPrsFromApprovals, type DeliveredPr } from '$lib/projects/delivered-prs';
  import { ProjectLibraryTab } from '$lib/components/library';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import ProjectRmArtifacts from '$lib/components/projects/ProjectRmArtifacts.svelte';
  import DocumentTrail from '$lib/components/outputs/DocumentTrail.svelte';
  import { fetchProjectOutputs } from '$lib/api/project-outputs';
  import type { ProjectOutputs } from '$lib/types/outputs';

  const projectId = $derived(page.params.id ?? '');

  // No per-id artifact detail route exists, so a row links to the tenant
  // Artifacts page and the fragment names the row to scroll to.
  //
  // ⚠️ CORRECTED — this comment used to claim the link applied "the project
  // filter … via the anchor". It did not and could not: a URL fragment is never
  // sent to the server, `/library/artifacts` reads no query params at all
  // (it GETs `/api/me/projects/artifacts?limit=…&offset=…` and nothing else),
  // and the target rendered NO element carrying `id="artifact-<id>"` — the
  // nearest things were `data-testid="artifact-row"` and the comment textarea's
  // `id="comment-<id>"`. So the anchor matched nothing, the browser stayed at
  // the top, and the list was the whole tenant's.
  //
  // What is true now: the target `<li>` carries `id="artifact-<id>"`, so the
  // fragment resolves for a row on the loaded page, and that page says so
  // explicitly when the named artifact is NOT among the rows it has loaded
  // rather than silently landing at the top. The list is still tenant-wide.
  const link = (id: string): string => `/library/artifacts#artifact-${encodeURIComponent(id)}`;

  // ── DELIVERED BY CARDS ──────────────────────────────────────────
  //
  // UI review 2026-10-07: the page listed only manually bound artifacts, so a
  // project whose cards had shipped PRs read as having produced nothing. A
  // card's approved gate carries `metadata.pr_url`; list each distinct one.
  // Three states, never collapsed: loading / failed read (NOT "none") / rows.
  const PR_PAGE = 100;
  let prs = $state<DeliveredPr[]>([]);
  let prsLoading = $state(true);
  let prsError = $state<string | null>(null);
  // The read is ONE page of approved approvals; if the server says more exist,
  // the list is "from the most recent N", never presented as complete.
  let prsCapped = $state(false);

  // ── THE DOCUMENT TRAIL (conveyor projects) ───────────────────────
  type TrailView = { kind: 'reading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; data: ProjectOutputs };
  let trail = $state<TrailView>({ kind: 'reading' });

  async function loadDeliveredPrs(): Promise<void> {
    try {
      const res = await apiClient.approvals.listAll({
        projectId,
        status: 'approved',
        limit: PR_PAGE,
      });
      prs = deliveredPrsFromApprovals(res.items ?? []);
      prsCapped = typeof res.total === 'number' ? res.total > (res.items?.length ?? 0) : false;
    } catch (err) {
      prsError = err instanceof Error ? err.message : String(err);
    } finally {
      prsLoading = false;
    }
  }

  onMount(async () => {
    if (!projectId) {
      prsLoading = false;
      trail = { kind: 'failed', message: 'No project is open.' };
      return;
    }
    try {
      const data = await fetchProjectOutputs(projectId);
      trail = { kind: 'loaded', data };
      if (!data.available) await loadDeliveredPrs();
    } catch (err) {
      trail = { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  });
</script>

{#if trail.kind === 'reading'}
  <ProjectInspectHeader {projectId} title="Outputs" subtitle="What this project produced." />
  <p class="p-6 text-sm text-[var(--color-text-muted)]" data-testid="outputs-reading">Reading this project's outputs…</p>
{:else if trail.kind === 'failed'}
  <ProjectInspectHeader {projectId} title="Outputs" subtitle="What this project produced." />
  <p class="p-6 text-sm text-[var(--color-warning-text)]" role="alert" data-testid="outputs-failed">
    This project's outputs could not be read, so what it produced is not known here — not nothing. ({trail.message})
  </p>
{:else if trail.data.available}
  <ProjectInspectHeader
    {projectId}
    title="Outputs"
    subtitle="Every document this project produced, by phase, newest first. Only documents that exist are listed."
  />
  <div class="p-6">
    <DocumentTrail {projectId} outputs={trail.data} />
  </div>
{:else}
<ProjectInspectHeader
  {projectId}
  title="Artifacts"
  subtitle="Pull requests recorded on this project's approved cards, the requirements, decisions and architecture it produced, and the artifacts bound to it by hand."
/>

<div class="space-y-6 p-6">
  <section class="space-y-2" data-testid="delivered-prs">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">Delivered by cards</h2>
    {#if prsLoading}
      <p class="text-sm text-[var(--color-text-muted)]">Loading pull requests…</p>
    {:else if prsError}
      <p class="text-sm text-[var(--color-warning-text)]" role="alert" data-testid="delivered-prs-error">
        The project's approvals could not be read, so whether its cards delivered pull requests is
        unknown — not none. ({prsError})
      </p>
    {:else if prs.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="delivered-prs-empty">
        No pull requests have been recorded for this project's cards{prsCapped
          ? ` in the ${PR_PAGE} most recent approved approvals`
          : ''}.
      </p>
    {:else}
      <ul class="space-y-1">
        {#each prs as pr (pr.url)}
          <li
            class="flex flex-wrap items-baseline gap-2 rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            data-testid="delivered-pr-row"
          >
            <a class="break-all font-mono text-xs text-[var(--color-accent)] hover:underline" href={pr.url} target="_blank" rel="noopener noreferrer">{pr.url}</a>
            {#if pr.summary}
              <span class="text-[var(--color-text)]">{pr.summary}</span>
            {/if}
          </li>
        {/each}
      </ul>
      {#if prsCapped}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="delivered-prs-capped">
          From the {PR_PAGE} most recent approved approvals — older ones are not shown.
        </p>
      {/if}
    {/if}
  </section>

  <section class="space-y-2" data-testid="produced-assets">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">Produced assets</h2>
    <p class="text-xs text-[var(--color-text-muted)]">Read from requirements_management, narrowed to this project on the server.</p>
    <ProjectRmArtifacts {projectId} />
  </section>

  <h2 class="text-sm font-semibold text-[var(--color-text)]">Bound artifacts</h2>
  <ProjectLibraryTab kind="artifact" pluralLabel="Artifacts" linkBuilder={link} />
</div>
{/if}
