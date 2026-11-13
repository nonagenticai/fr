<!--
  CodingJobView — shared embed for a single coding-gateway job + its findings.
  Used by:
    - the right-pane (rightPane store kind: 'coding-job')
    - /tools/coding/+page.svelte's findings drawer
  Loads job + findings via getJob() + getFindings() from $lib/api/coding,
  the same calls the page uses, so the rendering matches.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getJob,
    getFindings,
    type CodingJob,
    type CodingFinding,
    type Severity,
  } from '$lib/api/coding';

  type Props = { id: string };
  let { id }: Props = $props();

  let job = $state<CodingJob | null>(null);
  let findings = $state<CodingFinding[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  function severityBadge(s: Severity): string {
    if (s === 'critical') return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]';
    if (s === 'high')
      return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]';
    if (s === 'medium') return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]';
    if (s === 'low')
      return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-bg)]';
    return 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border)]';
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const [j, f] = await Promise.all([getJob(id), getFindings(id)]);
      job = j;
      findings = f;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<div class="overflow-y-auto flex-1 px-4 py-2">
  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <p class="text-xs text-[var(--color-danger)] dark:text-[var(--color-danger-text)]">{error}</p>
  {:else}
    {#if job}
      <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs mb-3">
        <dt class="text-[var(--color-text-muted)]">Type</dt>
        <dd>{job.type ?? '—'}</dd>
        <dt class="text-[var(--color-text-muted)]">Status</dt>
        <dd>{job.status ?? '—'}</dd>
        <dt class="text-[var(--color-text-muted)]">Repo</dt>
        <dd>{job.repo_id ?? '—'}</dd>
        <dt class="text-[var(--color-text-muted)]">Findings</dt>
        <dd>{job.findings_count ?? findings.length}</dd>
      </dl>
      {#if job.error && job.status === 'failed'}
        <div
          class="mb-3 rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2"
        >
          <p class="text-xs font-medium text-[var(--color-danger-text)]">
            ⚠ {job.error.message}
          </p>
        </div>
      {/if}
      {#if job.degraded}
        <div
          class="mb-3 rounded-md border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2"
        >
          <p class="text-xs font-medium text-[var(--color-warning-text)]">
            ⚠ Partial / degraded scan — results may be incomplete
          </p>
          {#if job.scan_summary && (job.scan_summary.grade || job.scan_summary.total_vulnerabilities != null || job.scan_summary.total_files_scanned != null)}
            <p class="text-xs text-[var(--color-warning-text)] mt-1">
              {#if job.scan_summary.grade}Grade {job.scan_summary.grade}{/if}{#if job.scan_summary.total_vulnerabilities != null} · {job.scan_summary.total_vulnerabilities} vulnerabilities{/if}{#if job.scan_summary.total_files_scanned != null} · {job.scan_summary.total_files_scanned} files scanned{/if}
            </p>
          {/if}
        </div>
      {/if}
    {/if}
    {#if findings.length === 0}
      <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No findings reported.</p>
    {:else}
      <ul class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
        {#each findings as f (f.id)}
          <li class="py-2">
            <div class="flex items-center gap-2">
              <span
                class="inline-block text-xs px-2 py-0.5 rounded border {severityBadge(f.severity)}"
              >
                {f.severity}
              </span>
              <span class="text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{f.type}</span>
              {#if f.rule_id}
                <span class="font-mono text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{f.rule_id}</span>
              {/if}
            </div>
            <p class="text-sm font-medium mt-1">{f.title}</p>
            {#if f.message}
              <p class="text-xs text-[var(--color-text)] mt-1 whitespace-pre-wrap dark:text-[var(--color-text-muted)]">
                {f.message}
              </p>
            {/if}
            {#if f.location}
              <p class="text-xs text-[var(--color-text-muted)] font-mono mt-1 dark:text-[var(--color-text-muted)]">
                {f.location.file}{f.location.line
                  ? `:${f.location.line}`
                  : ''}{f.location.symbol ? ` (${f.location.symbol})` : ''}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
