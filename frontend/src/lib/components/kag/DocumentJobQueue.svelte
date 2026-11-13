<!--
  DocumentJobQueue — the KAG document-ingestion job queue (PR-F P2-2).

  Lists the async ingestion jobs from the gateway's job queue via the
  `/api/assets/kag/ingest/documents/jobs` BFF passthrough (a deliberate,
  admin-scoped crossing of the read-only kag boundary). Supports per-row delete
  and "clear completed", each behind a confirm dialog with honest inline
  feedback. Polls every 5s ONLY while a non-terminal job exists.

  Self-contained so it can drop into the Documents tab (its mount) or the
  Web-sources tab unchanged. Job payloads are untyped loose bags → every field is
  read defensively and the expanded detail renders labeled rows, never raw JSON.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { kagApi, type KagRecord } from '$lib/api/kag';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';
  import { kagDetailRows } from '$lib/components/kag/graph-normalise';

  let jobs = $state<KagRecord[]>([]);
  let loading = $state(true);
  let error = $state<unknown>(null);
  let clearing = $state(false);
  let deletingId = $state<string | null>(null);
  let note = $state('');
  let expandedId = $state<string | null>(null);

  const TERMINAL = new Set([
    'completed',
    'complete',
    'done',
    'succeeded',
    'success',
    'failed',
    'error',
    'rejected',
    'cancelled',
    'canceled',
  ]);

  function str(job: KagRecord, keys: string[]): string | undefined {
    for (const k of keys) {
      const v = job[k];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return undefined;
  }
  function jobId(job: KagRecord): string {
    return str(job, ['job_id', 'id', 'jobId', 'uuid']) ?? '';
  }
  function jobStatus(job: KagRecord): string {
    return str(job, ['status', 'state']) ?? 'unknown';
  }
  function jobName(job: KagRecord): string {
    return (
      str(job, ['filename', 'file_name', 'name', 'document_id', 'documentId']) ??
      '—'
    );
  }
  function isTerminal(status: string): boolean {
    return TERMINAL.has(status.toLowerCase());
  }
  /** Relative age from a created-at timestamp; '—' when missing/unparseable. */
  function fmtAge(job: KagRecord): string {
    const raw = str(job, ['created_at', 'createdAt', 'submitted_at', 'started_at', 'age']);
    if (!raw) return '—';
    const t = typeof raw === 'string' ? Date.parse(raw) : Number(raw);
    if (!Number.isFinite(t)) return '—';
    const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }
  function detailRows(job: KagRecord): Array<[string, string]> {
    return kagDetailRows(job, [], { dropInputEcho: false })
      .filter((r) => !r.raw)
      .map((r) => [r.key, r.value] as [string, string]);
  }

  const hasActiveJob = $derived(jobs.some((j) => !isTerminal(jobStatus(j))));

  async function refreshJobs(): Promise<void> {
    try {
      const list = await kagApi.listDocumentJobs();
      jobs = list;
      error = null;
    } catch (e) {
      error = e;
    } finally {
      loading = false;
    }
  }

  async function onDelete(job: KagRecord): Promise<void> {
    const id = jobId(job);
    if (!id) return;
    if (!confirm(`Delete ingestion job "${jobName(job)}"? This can't be undone.`)) {
      return;
    }
    deletingId = id;
    note = '';
    try {
      await kagApi.deleteDocumentJob(id);
      note = `Deleted job ${id}.`;
      await refreshJobs();
    } catch (e) {
      note = `Couldn't delete job: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      deletingId = null;
    }
  }

  async function onClearCompleted(): Promise<void> {
    if (!confirm('Clear all completed ingestion jobs?')) return;
    clearing = true;
    note = '';
    try {
      await kagApi.clearDocumentJobs();
      note = 'Cleared completed jobs.';
      await refreshJobs();
    } catch (e) {
      note = `Couldn't clear jobs: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      clearing = false;
    }
  }

  function toggleExpand(id: string): void {
    expandedId = expandedId === id ? null : id;
  }

  // Poll only while a non-terminal job exists — no idle 5s loop otherwise.
  const pollHandle: PollHandle = usePoll(refreshJobs, {
    intervalMs: 5000,
    initialDelayMs: 5000,
  });
  $effect(() => {
    if (hasActiveJob) pollHandle.start();
    else pollHandle.stop();
  });

  onMount(() => {
    void refreshJobs();
  });
  onDestroy(() => pollHandle.stop());
</script>

<div
  class="bg-[var(--color-bg)] rounded-lg shadow p-6 dark:bg-[var(--color-surface)]"
  data-testid="kag-document-jobs"
>
  <div class="mb-4 flex items-center justify-between">
    <h2 class="text-xl font-semibold text-[var(--color-text)]">Ingestion jobs</h2>
    <div class="flex items-center gap-3">
      <button
        onclick={refreshJobs}
        disabled={loading}
        class="px-4 py-2 text-sm font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-strong)] disabled:opacity-50"
        data-testid="kag-jobs-refresh"
      >
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
      <button
        onclick={onClearCompleted}
        disabled={clearing || jobs.length === 0}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        data-testid="kag-jobs-clear"
      >
        {clearing ? 'Clearing…' : 'Clear completed'}
      </button>
    </div>
  </div>

  {#if note}
    <p class="mb-3 text-xs text-[var(--color-text-muted)]" data-testid="kag-jobs-note">{note}</p>
  {/if}

  {#if loading && jobs.length === 0}
    <Skeleton variant="text" count={3} height="2.5rem" />
  {:else if error}
    <ErrorState {error} title="Couldn't load jobs" onRetry={refreshJobs} />
  {:else if jobs.length === 0}
    <EmptyState
      title="No ingestion jobs"
      body="Uploaded documents appear here while they process."
    />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <th class="py-2 pr-3 font-medium">Job</th>
            <th class="py-2 pr-3 font-medium">Document</th>
            <th class="py-2 pr-3 font-medium">Status</th>
            <th class="py-2 pr-3 font-medium">Age</th>
            <th class="py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each jobs as job, i (jobId(job) || i)}
            {@const id = jobId(job)}
            <tr class="border-b border-[var(--color-border)]">
              <td class="py-2 pr-3">
                <button
                  type="button"
                  class="max-w-[16rem] truncate font-mono text-xs text-[var(--color-accent)] hover:underline"
                  onclick={() => toggleExpand(id)}
                  data-testid="kag-job-expand"
                  title={id}
                >{id || '(no id)'}</button>
              </td>
              <td class="py-2 pr-3 text-[var(--color-text)]">{jobName(job)}</td>
              <td class="py-2 pr-3">
                <span class="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text)]"
                  >{jobStatus(job)}</span
                >
              </td>
              <td class="py-2 pr-3 font-mono text-xs text-[var(--color-text-muted)]">{fmtAge(job)}</td>
              <td class="py-2 text-right">
                <button
                  type="button"
                  onclick={() => onDelete(job)}
                  disabled={!id || deletingId === id}
                  class="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
                  data-testid="kag-job-delete"
                >
                  {deletingId === id ? 'Deleting…' : 'Delete'}
                </button>
              </td>
            </tr>
            {#if expandedId === id}
              {@const rows = detailRows(job)}
              <tr class="border-b border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
                <td colspan="5" class="px-3 py-2">
                  {#if rows.length > 0}
                    <dl class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2" data-testid="kag-job-detail">
                      {#each rows as [k, v] (k)}
                        <div class="flex items-baseline justify-between gap-2 text-xs">
                          <dt class="text-[var(--color-text-muted)]">{k}</dt>
                          <dd class="font-mono text-[var(--color-text)]">{v}</dd>
                        </div>
                      {/each}
                    </dl>
                  {:else}
                    <p class="text-xs text-[var(--color-text-muted)]">No further job detail.</p>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
