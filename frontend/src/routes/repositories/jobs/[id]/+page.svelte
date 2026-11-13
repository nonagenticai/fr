<!--
  /repositories/jobs/:id — coding-analysis deep-link findings view. Re-homed
  from /tools/coding/jobs/:id during the /tools dissolution (control-plane
  roadmap Phase 3); /tools/coding/jobs/:id 308-redirects here.

  Spec: docs/superpowers/specs/completed/2026-04-24-coding-analysis-ui.md §Architecture
  ("Wave-2 kanban bridge deep-links land here").
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import {
    getFindings,
    getJob,
    type CodingFinding,
    type CodingJob,
    type Severity,
  } from '$lib/api/coding';
  import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';

  let job = $state<CodingJob | null>(null);
  let findings = $state<CodingFinding[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  function severityBadge(s: Severity): string {
    if (s === 'critical') return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]';
    if (s === 'high') return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]';
    if (s === 'medium') return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]';
    if (s === 'low') return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-bg)]';
    return 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border)]';
  }

  async function load() {
    const jobId = $page.params.id ?? '';
    loading = true;
    error = null;
    if (!jobId) {
      error = 'Missing job id in route';
      loading = false;
      return;
    }
    try {
      [job, findings] = await Promise.all([getJob(jobId), getFindings(jobId)]);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<div class="p-4 max-w-4xl mx-auto" data-testid="coding-job-page">
  <a href="/repositories/analysis" class="text-xs text-[var(--color-accent)] hover:underline">← All jobs</a>
  {#if loading}
    <div class="mt-4">
      <Skeleton variant="box" height="6rem" />
      <div class="mt-4">
        <Skeleton variant="text" count={4} height="1rem" />
      </div>
    </div>
  {:else if error}
    <ErrorState error={error} title="Couldn't load job" onRetry={load} class="mt-4" />
  {:else if job}
    <h1 class="text-xl font-semibold mt-4">
      {job.type} · {job.status}
    </h1>
    <dl class="text-xs text-[var(--color-text)] mt-2 grid grid-cols-2 gap-y-1 gap-x-4 dark:text-[var(--color-text-muted)]">
      <dt>Job id</dt><dd class="font-mono">{job.id}</dd>
      <dt>Repo id</dt><dd class="font-mono">{job.repo_id}</dd>
      <dt>Correlation</dt><dd class="font-mono">{job.correlation_id}</dd>
      <dt>Findings</dt><dd>{job.findings_count ?? '—'}</dd>
    </dl>

    <h2 class="text-sm font-semibold mt-6 mb-2">Findings ({findings.length})</h2>
    {#if findings.length === 0}
      <EmptyState title="No findings" body="This job completed without surfacing any findings." />
    {:else}
      <ul class="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded dark:divide-[var(--color-border-strong)] dark:border-[var(--color-border)]">
        {#each findings as f (f.id)}
          <li class="px-3 py-2">
            <div class="flex items-center gap-2">
              <span class="inline-block text-xs px-2 py-0.5 rounded border {severityBadge(f.severity)}">
                {f.severity}
              </span>
              {#if f.rule_id}<span class="font-mono text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{f.rule_id}</span>{/if}
            </div>
            <p class="text-sm font-medium mt-1">{f.title}</p>
            {#if f.message}<p class="text-xs text-[var(--color-text)] mt-1 whitespace-pre-wrap dark:text-[var(--color-text-muted)]">{f.message}</p>{/if}
            {#if f.location}
              <p class="text-xs text-[var(--color-text-muted)] font-mono mt-1 dark:text-[var(--color-text-muted)]">
                {f.location.file}{f.location.line ? `:${f.location.line}` : ''}{f.location.symbol ? ` (${f.location.symbol})` : ''}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
