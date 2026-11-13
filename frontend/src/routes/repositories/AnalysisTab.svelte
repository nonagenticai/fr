<!--
  Repositories → Analysis tab — coding analysis dashboard.

  Lifted from /tools/coding during the /tools dissolution (control-plane
  roadmap Phase 3); the per-job poll registry + onMount(refresh)/onDestroy
  teardown move intact. Mounted as /repositories/analysis (nav standard
  2026-10-03 — formerly a keepAlive tab), so polls stop on navigate-away and
  onMount(refresh) restores the job list on return.

  Spec: docs/superpowers/specs/completed/2026-04-24-coding-analysis-ui.md
    §"Architecture" — single surface, repo picker + type picker + job list.

  The page wires:
    - repo picker (onboarded-to-coding repos),
    - analysis-type picker over the frozen 5-type enum,
    - trigger button that mints a client_idempotency_key from
      `(repo, type, ts_5min_bucket)` so accidental double-submits dedup,
    - job list scoped to the calling user (filterable by type / status),
    - inline findings drawer per job.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    ANALYSIS_TYPE_LABELS,
    buildIdempotencyKey,
    getJob,
    listJobs,
    triggerAnalysis,
    type AnalysisType,
    type CodingJob,
    type JobStatus,
  } from '$lib/api/coding';
  import { handlePollError } from '$lib/coding/poll-helpers';
  import { createPollRegistry } from '$lib/coding/poll-registry';
  import { IDEMPOTENCY_WINDOW_MS, POLL_INTERVAL_MS } from '$lib/coding/constants';
  import { isUuid } from '$lib/coding/uuid';
  import { listRepositories, type Repository } from '$lib/api/repositories';
  import CodingJobView from '$lib/components/contextual/CodingJobView.svelte';

  const TYPES: AnalysisType[] = [
    'security',
    'bug_hunt',
    'quality',
    'dependencies',
    'tests',
  ];

  const STATUSES: JobStatus[] = [
    'queued',
    'running',
    'succeeded',
    'failed',
    'canceled',
  ];

  let repoId = $state('');
  let repos = $state<Repository[]>([]);
  let reposLoading = $state(true);
  let reposError = $state<string | null>(null);
  let type = $state<AnalysisType>('security');
  let typeFilter = $state<AnalysisType | ''>('');
  let statusFilter = $state<JobStatus | ''>('');

  let jobs = $state<CodingJob[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let status = $state<string | null>(null);
  let triggering = $state(false);

  let drawerJobId = $state<string | null>(null);

  // Polling intervals — keyed by job id so we can clear individually.
  const polls = createPollRegistry(POLL_INTERVAL_MS);

  function isTerminal(s: JobStatus | undefined): boolean {
    return s === 'succeeded' || s === 'failed' || s === 'canceled';
  }

  function startJobPoll(jobId: string): void {
    polls.set(`job:${jobId}`, async () => {
      try {
        const detail = await getJob(jobId);
        if (isTerminal(detail.status)) {
          polls.clear(`job:${jobId}`);
          await refresh();
        } else {
          // Refresh the list so the user sees in-flight status updates.
          await refresh();
        }
      } catch (err) {
        handlePollError(err, {
          onSilentStop: () => {
            polls.clear(`job:${jobId}`);
            void refresh();
          },
          onUserError: (msg) => {
            polls.clear(`job:${jobId}`);
            error = msg;
          },
        });
      }
    });
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const params: Parameters<typeof listJobs>[0] = {};
      if (typeFilter) params.type = typeFilter;
      if (statusFilter) params.status = statusFilter;
      jobs = await listJobs(params);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function onTrigger(): Promise<void> {
    const trimmed = repoId.trim();
    if (!trimmed) {
      error = 'Repository id is required';
      return;
    }
    if (!isUuid(trimmed)) {
      error = 'Repository id must be a valid UUID';
      return;
    }
    triggering = true;
    error = null;
    status = null;
    try {
      const idempotencyWindow = String(Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS));
      const key = buildIdempotencyKey(trimmed, type, idempotencyWindow);
      const result = await triggerAnalysis({
        repo_id: trimmed,
        type,
        client_idempotency_key: key,
      });
      await refresh();
      if (result.deduped) {
        status = `Reused existing job ${result.job.id} (deduped)`;
      } else {
        status = `Started job ${result.job.id}`;
        if (!isTerminal(result.job.status)) {
          startJobPoll(result.job.id);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      triggering = false;
    }
  }

  function openDrawer(jobId: string): void {
    drawerJobId = jobId;
  }

  function closeDrawer(): void {
    drawerJobId = null;
  }

  function statusBadge(s: JobStatus): { label: string; cls: string } {
    if (s === 'running' || s === 'queued') {
      return { label: s, cls: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]' };
    }
    if (s === 'succeeded') {
      return { label: s, cls: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]' };
    }
    if (s === 'failed') {
      return { label: s, cls: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]' };
    }
    return { label: s, cls: 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)]' };
  }

  function fmtDuration(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
  }

  function fmtTime(iso: string | null): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    return new Date(t).toLocaleString();
  }

  async function loadRepos(): Promise<void> {
    reposLoading = true;
    reposError = null;
    try {
      repos = await listRepositories({ onboardedTo: 'coding' });
      // Preselect the first onboarded repo so the trigger button works in
      // one click. Only set if the user hasn't typed/picked something.
      if (repos.length > 0 && !repoId) {
        repoId = repos[0]!.id;
      }
    } catch (err) {
      reposError = err instanceof Error ? err.message : String(err);
    } finally {
      reposLoading = false;
    }
  }

  onMount(() => {
    void refresh();
    void loadRepos();
  });

  onDestroy(() => {
    polls.clearAll();
  });
</script>

<div class="flex flex-col h-full" data-testid="coding-page">
  <header class="mb-4">
    <h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Coding analysis</h2>
    <p class="text-sm text-[var(--color-text-muted)] mt-1 dark:text-[var(--color-text-muted)]">
      Trigger and review security, bug-hunt, quality, dependency and test
      analyses across registered repositories.
    </p>
  </header>

  <section class="border border-[var(--color-border)] rounded p-3 mb-4 bg-[var(--color-surface)] dark:border-[var(--color-border)] dark:bg-[var(--color-bg)]">
    <h3 class="text-sm font-semibold text-[var(--color-text)] mb-2 dark:text-[var(--color-text-muted)]">Run analysis</h3>
    <div class="flex flex-wrap items-center gap-2">
      {#if reposLoading}
        <span class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]" data-testid="coding-repo-loading">
          Loading repositories…
        </span>
      {:else if reposError}
        <span class="text-sm text-[var(--color-danger)] dark:text-[var(--color-danger-text)]" data-testid="coding-repo-error">
          {reposError}
        </span>
      {:else if repos.length === 0}
        <span class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]" data-testid="coding-repo-empty">
          No onboarded repositories.
          <a href="/repositories/registry" class="text-[var(--color-accent)] underline">Onboard one</a>
          to start.
        </span>
      {:else}
        <select
          bind:value={repoId}
          class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-sm font-mono w-80 dark:border-[var(--color-border-strong)]"
          data-testid="coding-repo-id"
        >
          {#each repos as r (r.id)}
            <option value={r.id}>
              {r.name ?? r.id}{r.container_name ? ` — ${r.container_name}` : ''}
            </option>
          {/each}
        </select>
      {/if}
      <select
        bind:value={type}
        class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-sm dark:border-[var(--color-border-strong)]"
        data-testid="coding-type"
      >
        {#each TYPES as t}
          <option value={t}>{ANALYSIS_TYPE_LABELS[t]}</option>
        {/each}
      </select>
      <button
        type="button"
        onclick={onTrigger}
        disabled={triggering}
        class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
        data-testid="coding-trigger"
      >
        {triggering ? 'Triggering…' : 'Trigger'}
      </button>
    </div>
  </section>

  <section class="flex items-center gap-2 mb-3">
    <label class="text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Type
      <select
        bind:value={typeFilter}
        onchange={refresh}
        class="ml-1 px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs dark:border-[var(--color-border-strong)]"
      >
        <option value="">all</option>
        {#each TYPES as t}
          <option value={t}>{t}</option>
        {/each}
      </select>
    </label>
    <label class="text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Status
      <select
        bind:value={statusFilter}
        onchange={refresh}
        class="ml-1 px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs dark:border-[var(--color-border-strong)]"
      >
        <option value="">all</option>
        {#each STATUSES as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </label>
    <button
      type="button"
      onclick={refresh}
      disabled={loading}
      class="ml-auto px-3 py-1 bg-[var(--color-surface-strong)] text-[var(--color-text)] text-xs rounded disabled:bg-[var(--color-surface-strong)]"
    >
      {loading ? '…' : 'Refresh'}
    </button>
  </section>

  {#if error}
    <div
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4"
      role="alert"
      aria-live="assertive"
    >
      {error}
    </div>
  {/if}

  {#if status}
    <div
      class="bg-[var(--color-accent-bg)] border border-[var(--color-accent-border)] text-[var(--color-accent-text)] px-3 py-2 rounded text-sm mb-4"
      data-testid="coding-status"
      role="status"
      aria-live="polite"
    >
      {status}
    </div>
  {/if}

  {#if jobs.length === 0 && !loading}
    <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No analysis jobs yet for your account.</p>
  {:else}
    <table class="w-full text-sm border border-[var(--color-border)] rounded overflow-hidden dark:border-[var(--color-border)]">
      <thead class="bg-[var(--color-surface)] text-xs uppercase text-[var(--color-text)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
        <tr>
          <th class="text-left px-2 py-1">Status</th>
          <th class="text-left px-2 py-1">Type</th>
          <th class="text-left px-2 py-1">Job</th>
          <th class="text-left px-2 py-1">Repo</th>
          <th class="text-right px-2 py-1">Findings</th>
          <th class="text-right px-2 py-1">Duration</th>
          <th class="text-left px-2 py-1">Started</th>
          <th class="text-left px-2 py-1">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each jobs as job (job.id)}
          {@const sb = statusBadge(job.status)}
          <tr class="border-t border-[var(--color-border)] hover:bg-[var(--color-accent)] dark:border-[var(--color-border)]" data-testid="coding-row">
            <td class="px-2 py-1">
              <span class="inline-block text-xs px-2 py-0.5 rounded border {sb.cls}">{sb.label}</span>
            </td>
            <td class="px-2 py-1 text-xs">{job.type}</td>
            <td class="px-2 py-1 font-mono text-xs">{job.id}</td>
            <td class="px-2 py-1 font-mono text-xs">{job.repo_id}</td>
            <td class="px-2 py-1 text-right tabular-nums text-xs">{job.findings_count ?? '—'}</td>
            <td class="px-2 py-1 text-right tabular-nums text-xs">{fmtDuration(job.duration_ms)}</td>
            <td class="px-2 py-1 text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{fmtTime(job.started_at)}</td>
            <td class="px-2 py-1 text-xs">
              <button
                type="button"
                onclick={() => openDrawer(job.id)}
                class="text-[var(--color-accent)] hover:underline"
              >
                Findings →
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if drawerJobId}
    <aside
      class="fixed inset-y-0 right-0 w-[36rem] max-w-full bg-[var(--color-bg)] border-l border-[var(--color-border)] shadow-xl flex flex-col dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
      data-testid="coding-findings-drawer"
    >
      <header class="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
        <div>
          <h2 class="text-sm font-semibold">Findings</h2>
          <p class="text-xs text-[var(--color-text-muted)] font-mono dark:text-[var(--color-text-muted)]">{drawerJobId}</p>
        </div>
        <button type="button" onclick={closeDrawer} class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] dark:text-[var(--color-text-muted)] dark:hover:text-[var(--color-text)]">Close</button>
      </header>
      <CodingJobView id={drawerJobId} />

    </aside>
  {/if}
</div>
