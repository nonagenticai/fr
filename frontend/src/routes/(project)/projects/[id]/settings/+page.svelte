<!--
  /projects/[id]/settings — per-project controls relocated from the old 7-lens
  page that the cockpit (D) replaced: the Andon cord (stop-the-line) + repository
  provisioning + project metadata. No capability lost in the cutover — just
  re-homed off the cockpit into project settings.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { activeProject } from '$lib/stores/activeProject.svelte';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { apiClient, ApiError } from '$lib/api/unified-client';
  import { loadProject } from '$lib/projects/load-project';
  // The shared three-state repository reader. See its header for why sharing is
  // correct here and what the `none` / `unknown` split is protecting.
  import { readProjectRepoView } from '$lib/projects/repo-view';
  import { authFetch } from '$lib/api/auth-fetch';
  import { toast } from '$lib/stores/toast.svelte';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import ProjectRestartPanel from '$lib/components/ProjectRestartPanel.svelte';
  import { priorityLabel, storedPriorityLevel, type PriorityLevel } from '$lib/priority/priority';
  import { listTenantPriorityLevels } from '$lib/api/conveyor-catalogue';
  import type { Project } from '$lib/types/api';

  const projectId = $derived($page.params.id ?? '');
  let project = $state<Project | null>(null);
  // true ⇒ the project read FAILED; every 'not provisioned' / 'not found'
  // message below is unearned while this is set.
  let projectUnreadable = $state(false);
  let loading = $state(true);
  let andonBusy = $state(false);
  let provisioning = $state(false);

  onMount(async () => {
    if (!projectId) {
      loading = false;
      return;
    }
    const res = await loadProject(projectId);
    project = res.project;
    projectUnreadable = res.unreadable;
    loading = false;
  });

  // Andon cord — engaged = every automated loop (scheduled-trigger-tick,
  // suggestion-heuristic, agent loops) pre-flight-skips this project. Refresh
  // from server after toggling (audit-relevant fields are not trusted locally).
  async function toggleAndon() {
    if (!project || !projectId || andonBusy) return;
    const verb = project.andon_engaged ? 'disengage' : 'engage';
    const ok = confirm(
      `${project.andon_engaged ? 'Disengage' : 'Engage'} the andon cord on "${project.name}"?\n\n` +
        (project.andon_engaged
          ? 'Automated loops will RESUME picking up this project.'
          : 'All automated loops (scheduled triggers, heuristics, agent loops) will SKIP this project until disengaged.'),
    );
    if (!ok) return;
    andonBusy = true;
    try {
      const r = await authFetch(`/api/projects/${projectId}/andon/${verb}`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
      }
      // PROJECT-READ-WAIVER: post-mutation refresh — NOT the page's initial load
      // (that goes through `loadProject` in onMount above). This re-reads an
      // audit-relevant field after a write we just made; a failure here is caught
      // below and surfaced as a toast on a page that already holds a project, so
      // it can never turn into an unearned "not found" / "not provisioned" claim.
      project = await apiClient.projects.get(projectId);
      toast.success(`Andon cord ${verb}d`);
    } catch (err) {
      toast.error(`Andon ${verb} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      andonBusy = false;
    }
  }

  // ── REPOSITORIES: all of them, primary marked (unit F2) ─────────────────────
  //
  // ⭐ THE DEFECT. This page's Details list had ONE "Repository" row reading
  // `project.repository_url` — the DENORMALISED PRIMARY cache of whichever
  // `project_repositories` row carries `is_primary` (migration 072). A project
  // with three attached repositories rendered exactly like a project with one, on
  // the page whose job is to show what this project is configured against. And
  // the `?? '—'` fallback collapsed two further facts into one dash: "none
  // attached" and "the server did not tell us".
  //
  // The three-state reading lives in `$lib/projects/repo-view.ts`, shared with
  // `/projects` and `/admin/assets/projects`. What matters HERE is the third
  // state: this page already refuses to turn a failed project read into an
  // absence claim (`projectUnreadable` above), and the same rule applies one
  // field down — `unknown` shows the denormalised primary and says the rest is
  // unreported. It must never read as "no repositories".
  //
  // `$derived.by` rather than a call per use: the markup reads this four times
  // (the count in the <dt>, the list, the shortfall line, the no-primary line)
  // and they must all describe ONE reading of one payload.
  const repoView = $derived.by(() => readProjectRepoView(project));

  /**
   * How the attached repositories are driven together. `'coordinated'` = one
   * change set spans them; `'independent'` = each moves on its own.
   *
   * ⚠️ `null` is UNKNOWN, not a default. Picking either value for a backend that
   * never sent the field would state a coordination policy nobody configured.
   */
  const coordinationMode = $derived.by((): 'coordinated' | 'independent' | null => {
    const v = (project as { coordination_mode?: unknown } | null)?.coordination_mode;
    return v === 'coordinated' || v === 'independent' ? v : null;
  });

  // ── PRIORITY (a requirements_management priority level of the workspace) ──
  //
  // READ-ONLY (George 2026-10-13, D15/R16): after the project request only the
  // PM writes the project's RM resources, its priority included. The label is
  // the workspace's RM priority level whose id the backend read FROM RM
  // (`priority_level_id`, else `priority_name` by name — fr keeps no
  // project_data copy). A failed level load is shown, never an empty label.
  let priorityLevels = $state<PriorityLevel[]>([]);
  let priorityLevelsError = $state<string | null>(null);
  $effect(() => {
    void listTenantPriorityLevels().then((r) => {
      if (r.ok) priorityLevels = r.data;
      else priorityLevelsError = r.message;
    });
  });
  const savedPriority = $derived(
    storedPriorityLevel(priorityLevels, {
      id: project?.priority_level_id,
      text: project?.priority_name,
    }),
  );

  // ── DETAILS (name / description / branch) ───────────────────────
  //
  // READ-ONLY (George 2026-10-13, D15/R16): name (RM title), description and
  // branch (RM repositories) are requirements_management's after the request
  // and only the PM writes them; PATCH /api/projects/:id refuses them (422
  // rm_owned_field). No edit control is rendered.

  function serverMessage(err: unknown, fallback: string): string {
    if (err instanceof ApiError) {
      const data = err.data as { error?: unknown; code?: unknown } | undefined;
      const msg = typeof data?.error === 'string' ? data.error : err.message;
      return typeof data?.code === 'string' ? `${msg} (${data.code})` : msg;
    }
    return err instanceof Error ? err.message : fallback;
  }

  // ── CONTAINER (architecture model) ──────────────────────────────
  //
  // UI review 2026-10-07: `container_name` read "N/A", which hid that the
  // project simply has no architecture container yet — and that the governance
  // counts then come from the whole workspace model. POST /provision is the only
  // writer of `container_name`; its result/error is shown inline on the row.
  let containerError = $state<string | null>(null);

  async function provisionContainer() {
    if (!projectId || provisioning) return;
    provisioning = true;
    containerError = null;
    try {
      project = await apiClient.projects.provision(projectId);
      toast.success(`Provisioned container ${project.container_name ?? ''}`);
    } catch (err) {
      containerError = serverMessage(err, 'Provisioning failed');
    } finally {
      provisioning = false;
    }
  }

  // ── DANGER ZONE: archive ────────────────────────────────────────
  //
  // UI review 2026-10-07: there was no way to archive a project from the UI.
  // DELETE /api/projects/:id is the archive path and it is irreversible from
  // here (PHI purged, pending approvals voided, Planka board torn down), so the
  // button only enables once the exact project name is typed — no confirm().
  let archiveConfirm = $state('');
  let archiving = $state(false);
  let archiveError = $state<string | null>(null);
  const archiveArmed = $derived(!!project && archiveConfirm === project.name);

  async function archiveProject() {
    if (!project || !projectId || archiving || !archiveArmed) return;
    archiving = true;
    archiveError = null;
    try {
      await apiClient.projects.delete(projectId);
      if (activeProject.activeId === projectId) activeProject.clear();
      toast.success(`Archived "${project.name}"`);
      await goto('/');
    } catch (err) {
      archiveError = serverMessage(err, 'Archive failed');
    } finally {
      archiving = false;
    }
  }

  const fmt = (d: string | Date | null | undefined): string =>
    d ? new Date(d).toLocaleString() : '—';

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
  title="Project settings"
  subtitle="The stop-the-line control, repository provisioning, and project metadata."
/>

<div class="max-w-2xl space-y-6 p-6">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if projectUnreadable}
    <p class="text-sm text-[var(--color-warning-text)]" data-testid="project-unreadable">
      The project could not be read. It has NOT been shown to be missing — this is a failed
      request. Retry, and report it if it persists.
    </p>
  {:else if !project}
    <p class="text-sm text-[var(--color-text-muted)]">Project not found.</p>
  {:else}
    <!-- Andon cord -->
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-semibold text-[var(--color-text)]">Andon cord</h2>
          <p class="mt-1 text-xs text-[var(--color-text-muted)]">
            Stop the line — pause every automated loop on this project.
            {#if project.andon_engaged && project.andon_engaged_at}
              Engaged {fmt(project.andon_engaged_at)}{project.andon_engaged_by
                ? ` by ${project.andon_engaged_by}`
                : ''}.
            {/if}
          </p>
        </div>
        <button
          type="button"
          onclick={toggleAndon}
          disabled={andonBusy}
          data-testid="andon-toggle"
          class="shrink-0 rounded-[var(--radius-md)] border px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50 {project.andon_engaged
            ? 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
            : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]'}"
        >
          {andonBusy
            ? '…'
            : project.andon_engaged
              ? '🛑 Engaged — click to disengage'
              : '🟢 Off — click to engage'}
        </button>
      </div>
    </section>

    <!-- Start again: restart the whole project or its current phase (George 2026-10-31) -->
    <ProjectRestartPanel {projectId} />

    <!-- Priority: RM-owned, read-only (D15/R16) -->
    <section
      class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="project-priority"
    >
      <h2 class="text-sm font-semibold text-[var(--color-text)]">Priority</h2>
      <p class="mt-1 text-sm text-[var(--color-text)]">
        <span data-testid="project-priority-saved">{priorityLabel(savedPriority)}</span>
      </p>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        Set by the conveyor in requirements management; read-only here.
      </p>
      {#if priorityLevelsError}
        <p class="mt-2 text-xs text-[var(--color-danger-text)]" role="alert" data-testid="project-priority-levels-error">
          Priority levels unavailable: {priorityLevelsError}
        </p>
      {/if}
    </section>

    <!-- Metadata + provisioning -->
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div class="mb-3 flex items-center justify-between gap-4">
        <h2 class="text-sm font-semibold text-[var(--color-text)]">Details</h2>
        <span class="text-xs text-[var(--color-text-muted)]" data-testid="project-details-read-only">
          Name, description and branch are held in requirements management (read-only)
        </span>
      </div>
      <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt class="text-[var(--color-text-muted)]">Name</dt>
        <dd class="font-semibold text-[var(--color-text)]" data-testid="project-details-name-value">{project.name}</dd>
        <dt class="text-[var(--color-text-muted)]">Description</dt>
        <dd class="whitespace-pre-line text-[var(--color-text)]" data-testid="project-details-description-value">
          {#if project.description}{project.description}{:else}<span class="text-[var(--color-text-muted)]">No description.</span>{/if}
        </dd>
        <dt class="text-[var(--color-text-muted)]">Branch</dt>
        <dd class="font-mono text-[var(--color-text)]" data-testid="project-details-branch-value">{project.branch || '—'}</dd>
        <dt class="text-[var(--color-text-muted)]">Status</dt>
        <dd class="font-semibold text-[var(--color-text)]">{project.status}</dd>
        <dt class="text-[var(--color-text-muted)]">
          Repositories{repoView.kind === 'listed' ? ` (${repoView.total})` : ''}
        </dt>
        <dd class="text-[var(--color-text)]">
          {#if repoView.kind === 'listed'}
            <ul class="space-y-1" data-testid="project-repo-list">
              {#each repoView.rows as repo (repo.repo_id)}
                <li class="flex flex-wrap items-baseline gap-2" data-testid="project-repo-row">
                  <span class="break-all" title={repo.url}>{repo.url}</span>
                  {#if repo.branch}
                    <span class="font-mono text-xs text-[var(--color-text-muted)]">{repo.branch}</span>
                  {/if}
                  {#if repo.is_primary}
                    <span
                      class="rounded-full bg-[var(--color-accent-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-strong)]"
                      data-testid="project-repo-primary-badge">primary</span
                    >
                  {/if}
                </li>
              {/each}
            </ul>
            {#if repoView.countOutrunsRows}
              <!-- The count outran the rows: say so rather than let the list read as complete. -->
              <p class="mt-1 text-xs text-[var(--color-warning-text)]" data-testid="project-repo-unnamed">
                {repoView.total - repoView.rows.length} further attached, not named in this response.
              </p>
            {/if}
            {#if !repoView.primary}
              <!-- 0..N with EXACTLY ONE primary is the backend's invariant. No flag
                   on any row means the invariant is broken or the field was dropped —
                   marking the first row anyway would invent the answer. -->
              <p class="mt-1 text-xs text-[var(--color-warning-text)]" data-testid="project-repo-no-primary">
                None of these is flagged primary — which one is cannot be shown.
              </p>
            {/if}
          {:else if repoView.kind === 'none'}
            <span data-testid="project-repo-none">No repositories attached.</span>
          {:else if project.repository_url}
            <!-- The server did not report the list. The denormalised primary, plus
                 the fact that the rest is unreported — never "no repositories". A
                 project with NO repository (null, migration 190) renders nothing. -->
            <span data-testid="project-repos-unknown">
              {project.repository_url}
              <span class="block text-xs text-[var(--color-text-muted)]">
                Primary repository. Whether other repositories are attached was not
                reported by this response — this is not a statement that none are.
              </span>
            </span>
          {/if}
        </dd>
        <dt class="text-[var(--color-text-muted)]">Coordination</dt>
        <dd class="text-[var(--color-text)]" data-testid="project-coordination-mode">
          {#if coordinationMode === 'coordinated'}
            Coordinated — one change set spans every attached repository.
          {:else if coordinationMode === 'independent'}
            Independent — each repository moves on its own.
          {:else}
            <span class="text-[var(--color-text-muted)]">Not reported by this response.</span>
          {/if}
        </dd>
        <dt class="text-[var(--color-text-muted)]">Container</dt>
        <dd class="text-[var(--color-text)]" data-testid="project-container">
          <div class="flex flex-wrap items-center gap-3">
            {#if project.container_name}
              <span class="font-mono" data-testid="project-container-name">{project.container_name}</span>
            {:else}
              <span class="text-[var(--color-text-muted)]" data-testid="project-container-none">Not provisioned</span>
              <button
                type="button"
                onclick={provisionContainer}
                disabled={provisioning}
                data-testid="project-container-provision"
                class="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
              >
                {provisioning ? 'Provisioning…' : 'Provision container'}
              </button>
            {/if}
          </div>
          {#if !project.container_name}
            <span class="mt-1 block text-xs text-[var(--color-text-muted)]">
              Without a container, governance counts come from the whole workspace architecture model.
            </span>
          {/if}
          {#if containerError}
            <p class="mt-1 text-xs text-[var(--color-danger-text)]" role="alert" data-testid="project-container-error">
              Provisioning failed: {containerError}
            </p>
          {/if}
        </dd>
        <dt class="text-[var(--color-text-muted)]">Created</dt>
        <dd class="text-[var(--color-text)]">{fmt(project.created_at)}</dd>
        <dt class="text-[var(--color-text-muted)]">Updated</dt>
        <dd class="text-[var(--color-text)]">{fmt(project.updated_at)}</dd>
        <dt class="text-[var(--color-text-muted)]">Provisioned</dt>
        <dd class="flex items-center gap-3 text-[var(--color-text)]">
          <span>{project.repository_provisioned ? 'Yes' : 'No'}</span>
          <!-- UI review 2026-10-07: same endpoint as "Provision container"; shown
               here only once a container exists, so one action never has two buttons. -->
          {#if !project.repository_provisioned && project.container_name}
            <button
              type="button"
              onclick={provisionContainer}
              disabled={provisioning}
              class="rounded bg-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
            >
              {provisioning ? 'Provisioning…' : 'Provision repository'}
            </button>
          {/if}
        </dd>
      </dl>
    </section>

    <!-- Danger zone — UI review 2026-10-07 -->
    <section
      class="rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-surface)] p-4"
      data-testid="project-danger-zone"
    >
      <h2 class="text-sm font-semibold text-[var(--color-danger-text)]">Danger zone</h2>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        Archiving voids this project's pending approvals, removes its board and purges its
        PHI — it cannot be undone from the UI.
      </p>
      <label class="mt-3 block text-xs text-[var(--color-text-muted)]">
        Type <span class="font-mono font-semibold text-[var(--color-text)]">{project.name}</span> to confirm
        <input
          type="text"
          bind:value={archiveConfirm}
          disabled={archiving}
          autocomplete="off"
          data-testid="project-archive-confirm"
          class="mt-1 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)] disabled:opacity-50"
        />
      </label>
      {#if archiveError}
        <p class="mt-2 text-xs text-[var(--color-danger-text)]" role="alert" data-testid="project-archive-error">
          Not archived: {archiveError}
        </p>
      {/if}
      <button
        type="button"
        onclick={archiveProject}
        disabled={!archiveArmed || archiving}
        data-testid="project-archive"
        class="mt-3 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-4 py-2 text-sm font-semibold text-[var(--color-danger-text)] disabled:opacity-50"
      >
        {archiving ? 'Archiving…' : 'Archive project'}
      </button>
    </section>
  {/if}
</div>
