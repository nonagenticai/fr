<!--
  /projects/[id]/quality — the "Project code quality" rail row (fr#1305, INSPECT).

  Shows the STORED quality result for each repo (primary first) at a known
  commit, CI for that SAME commit, and a trend drawn from `complete` rows only.
  Viewing never analyses anything: the only thing that runs an analysis is the
  explicit Analyze button (POST → 202, then this page polls GET every 5s).
  Status → text rules live in $lib/quality/project-quality-view.ts.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { apiClient } from '$lib/api/unified-client';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import Pill from '$lib/components/ui/Pill.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import {
    statusView,
    ciView,
    shortSha,
    completeTrend,
    sparklinePoints,
  } from '$lib/quality/project-quality-view';
  import type {
    ProjectQuality,
    ProjectQualityAnalysis,
    ProjectQualityHistory,
  } from '$lib/types/api';

  const POLL_MS = 5_000;
  const POLL_MAX_MS = 10 * 60 * 1000;

  const projectId = $derived($page.params.id ?? '');
  let data = $state<ProjectQuality | null>(null);
  let loadError = $state<string | null>(null);
  let loaded = $state(false);
  let histories = $state<Record<string, ProjectQualityHistory | { error: string }>>({});
  let starting = $state(false);
  let analyzeError = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollDeadline = 0;

  const analysis = $derived<ProjectQualityAnalysis | null>(data?.analysis ?? null);
  const inFlight = $derived(
    analysis?.state === 'provisioning' || analysis?.state === 'analyzing',
  );

  $effect(() => {
    setPageTitle($page.url.pathname, null);
  });

  async function load(): Promise<void> {
    try {
      data = await apiClient.quality.getProjectQuality(projectId);
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loaded = true;
    }
  }

  async function loadHistories(): Promise<void> {
    if (!data) return;
    const next: typeof histories = {};
    await Promise.all(
      data.repositories
        .filter((r) => r.container_name)
        .map(async (r) => {
          try {
            next[r.repo_id] = await apiClient.quality.getProjectQualityHistory(projectId, r.repo_id);
          } catch (err) {
            next[r.repo_id] = { error: err instanceof Error ? err.message : String(err) };
          }
        }),
    );
    histories = next;
  }

  function stopPolling(): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(): void {
    stopPolling();
    if (Date.now() > pollDeadline) return;
    pollTimer = setTimeout(async () => {
      await load();
      if (inFlight) {
        schedulePoll();
      } else {
        stopPolling();
        await loadHistories();
      }
    }, POLL_MS);
  }

  async function analyze(): Promise<void> {
    starting = true;
    analyzeError = null;
    try {
      const state = await apiClient.quality.analyzeProject(projectId);
      if (data) data = { ...data, analysis: state };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      // 409: one is already running — follow it rather than failing.
      if (e?.status !== 409) analyzeError = e?.message ?? 'Could not start the analysis';
      await load();
    } finally {
      starting = false;
    }
    if (inFlight) {
      pollDeadline = Date.now() + POLL_MAX_MS;
      schedulePoll();
    }
  }

  onMount(async () => {
    if (!projectId) {
      loaded = true;
      return;
    }
    await load();
    await loadHistories();
    // A reload mid-analysis resumes following it.
    if (inFlight) {
      pollDeadline = Date.now() + POLL_MAX_MS;
      schedulePoll();
    }
  });

  onDestroy(stopPolling);

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return 'unknown time';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function progressText(a: ProjectQualityAnalysis): string {
    const parts = a.repos.map((r) => `${r.name}: ${r.state}`);
    return parts.length ? parts.join(' · ') : a.state;
  }
</script>

{#snippet analyzeAction()}
  <Button variant="primary" size="sm" disabled={inFlight || starting || !loaded} onclick={analyze}>
    <span data-testid="quality-analyze">
      {#if inFlight}
        Analysing…
      {:else if starting}
        Starting…
      {:else}
        Analyze
      {/if}
    </span>
  </Button>
{/snippet}

<ProjectInspectHeader
  {projectId}
  title="Quality"
  subtitle="Stored static-analysis result per repository, at a known commit, with CI for that same commit."
  actions={analyzeAction}
/>

<div class="p-6 space-y-4">
  {#if analysis}
    <div
      class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-text)]"
      data-testid="quality-analysis-state"
    >
      {#if inFlight}
        Analysis {analysis.state} (started {fmtDate(analysis.started_at)}) — {progressText(analysis)}.
        This page refreshes every 5 seconds.
      {:else if analysis.state === 'error'}
        <span class="text-[var(--color-danger-text)]">Last analysis ended with an error:</span>
        {analysis.error}
      {:else}
        Last analysis finished {fmtDate(analysis.finished_at)}.
      {/if}
    </div>
  {/if}
  {#if analyzeError}
    <p class="text-sm text-[var(--color-danger-text)]" data-testid="quality-analyze-error">{analyzeError}</p>
  {/if}

  {#if !loaded}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError}
    <p class="text-sm text-[var(--color-warning-text)]" data-testid="quality-load-error">
      Quality results could not be read: {loadError}. This is a failed request, not an unanalysed
      project.
    </p>
  {:else if !data || data.repositories.length === 0}
    <div
      class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
      data-testid="quality-no-repos"
    >
      This project has no repositories attached, so there is nothing to analyse.
    </div>
  {:else}
    {#each data.repositories as repo, i (repo.repo_id)}
      {@const sv = statusView(repo.latest)}
      {@const sha = repo.latest?.commit_sha ?? null}
      {@const cv = ciView(repo.ci.state, sha, repo.ci.reason)}
      {@const hist = histories[repo.repo_id]}
      {@const trend = hist && 'results' in hist ? completeTrend(hist.results) : []}
      <section
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-3"
        data-testid="quality-repo-card"
        data-status={repo.latest?.status ?? 'unavailable'}
      >
        <header class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h2 class="truncate text-base font-semibold text-[var(--color-text)]">
              {repo.name}
              {#if repo.is_primary}<span class="ml-1 text-xs font-normal text-[var(--color-text-muted)]">primary</span>{/if}
            </h2>
            <p class="truncate text-xs text-[var(--color-text-muted)]" title={repo.url}>{repo.url}</p>
          </div>
          <div class="flex items-center gap-2">
            <span data-testid="quality-status-pill"><Pill tone={sv.tone}>{sv.pill}</Pill></span>
            <span data-testid="quality-ci-badge"><Pill tone={cv.tone}>{cv.label}</Pill></span>
          </div>
        </header>

        <div class="flex flex-wrap items-baseline gap-4">
          <p class="text-2xl font-bold text-[var(--color-text)]" data-testid="quality-headline">
            {sv.headline}
          </p>
          {#if sv.grade}
            <p class="text-2xl font-bold text-[var(--color-accent-text)]" data-testid="quality-grade">
              {sv.grade}
            </p>
          {/if}
        </div>

        {#if repo.latest === null}
          <p class="text-sm text-[var(--color-warning-text)]">{repo.latest_error}</p>
        {:else}
          <dl class="grid grid-cols-1 gap-1 text-sm text-[var(--color-text)] sm:grid-cols-3">
            <div>
              <dt class="text-xs text-[var(--color-text-muted)]">Commit</dt>
              <dd data-testid="quality-commit">
                {#if sha}
                  <code title={sha}>{shortSha(sha)}</code>
                {:else}
                  commit unknown
                {/if}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-[var(--color-text-muted)]">Analysed</dt>
              <dd>{repo.latest.analyzed_at ? fmtDate(repo.latest.analyzed_at) : 'never'}</dd>
            </div>
            <div>
              <dt class="text-xs text-[var(--color-text-muted)]">Tools</dt>
              <dd>
                {#if repo.latest.tools_attempted.length}
                  {repo.latest.tools_succeeded.length} of {repo.latest.tools_attempted.length} succeeded
                  {#if repo.latest.tools_failed.length}
                    <span class="text-[var(--color-text-muted)]">(failed: {repo.latest.tools_failed.join(', ')})</span>
                  {/if}
                {:else}
                  none run
                {/if}
              </dd>
            </div>
          </dl>

          {#if repo.latest.status === 'failed' && repo.latest.error_message}
            <p class="text-sm text-[var(--color-danger-text)]">{repo.latest.error_message}</p>
          {/if}

          {#if (repo.latest.status === 'complete' || repo.latest.status === 'partial') && repo.latest.issues_total > 0}
            <details class="text-sm">
              <summary class="cursor-pointer text-[var(--color-text)]">
                {repo.latest.issues_total} issue{repo.latest.issues_total === 1 ? '' : 's'}
                ({repo.latest.severity_counts.critical} critical, {repo.latest.severity_counts.high} high,
                {repo.latest.severity_counts.medium} medium{repo.latest.issues_truncated ? '; stored list truncated' : ''})
              </summary>
              <ul class="mt-2 space-y-1">
                {#each repo.latest.issues as issue, j (j)}
                  <li class="text-[var(--color-text)]">
                    <span class="text-xs uppercase text-[var(--color-text-muted)]">{issue.severity}</span>
                    {issue.message}
                    {#if issue.file_path}
                      <code class="text-xs text-[var(--color-text-muted)]">{issue.file_path}{issue.line_number ? `:${issue.line_number}` : ''}</code>
                    {/if}
                  </li>
                {/each}
              </ul>
            </details>
          {/if}
        {/if}

        {#if repo.ci.runs.length > 0}
          <ul class="flex flex-wrap gap-2 text-xs" data-testid="quality-ci-runs">
            {#each repo.ci.runs as run (run.id)}
              <li>
                {#if run.html_url}
                  <a class="text-[var(--color-accent-text)] underline" href={run.html_url} target="_blank" rel="noreferrer">
                    {run.name ?? `run ${run.id}`}: {run.conclusion ?? run.status ?? 'unknown'}
                  </a>
                {:else}
                  {run.name ?? `run ${run.id}`}: {run.conclusion ?? run.status ?? 'unknown'}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <div class="border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-text-muted)]" data-testid="quality-history">
          {#if !repo.container_name}
            No history — this repository has never been analysed.
          {:else if !hist}
            Loading history…
          {:else if 'error' in hist}
            History could not be read: {hist.error}
          {:else if trend.length === 0}
            No complete runs yet — the trend only plots complete results.
          {:else}
            <div class="flex items-center gap-3">
              <svg width="120" height="28" viewBox="0 0 120 28" aria-label="score trend of complete runs" role="img">
                <polyline
                  fill="none"
                  stroke="var(--color-accent)"
                  stroke-width="2"
                  points={sparklinePoints(trend.map((r) => r.overall_score as number))}
                />
              </svg>
              <span>
                {trend.length} complete run{trend.length === 1 ? '' : 's'}
                {#if hist.results.length > trend.length}
                  ({hist.results.length - trend.length} partial/inconclusive/failed not plotted)
                {/if}
              </span>
            </div>
            <ol class="mt-1 space-y-0.5">
              {#each trend.slice(-5).reverse() as row (row.id)}
                <li>
                  {Math.round(row.overall_score as number)} {row.grade ?? ''} ·
                  <code title={row.commit_sha ?? 'commit unknown'}>{row.commit_sha ? shortSha(row.commit_sha) : 'commit unknown'}</code>
                  · {fmtDate(row.created_at)}
                </li>
              {/each}
            </ol>
          {/if}
        </div>
        {#if i >= (data.analyze_repo_cap ?? 5)}
          <p class="text-xs text-[var(--color-text-muted)]">
            Beyond the first {data.analyze_repo_cap} repositories — Analyze does not include this one.
          </p>
        {/if}
      </section>
    {/each}
  {/if}
</div>
