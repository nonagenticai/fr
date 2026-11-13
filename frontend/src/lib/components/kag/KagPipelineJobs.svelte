<!--
  KagPipelineJobs (P2-5) — drive one KAG ingestion as a single TRACKED pipeline
  job: submit content, poll its status to terminal with stage progress, and
  cancel / resume / delete it. Backed by the `/api/assets/kag/pipeline/jobs*` BFF
  write passthroughs (deliberate, admin-gated boundary carve-out). The upstream
  status bag varies by pipeline, so it's rendered defensively. Honest submit /
  polling / terminal / error states; the admin verbs surface the approval-bus
  pending-action envelope when the gateway requires one.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { kagApi, isPending, type KagRecord, type PendingAction } from '$lib/api/kag';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import { AssetError } from '$lib/api/assets';

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  const TERMINAL = new Set(['completed', 'complete', 'failed', 'error', 'cancelled', 'canceled']);
  function num(o: KagRecord, keys: string[]): number | undefined {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  }
  function str(o: KagRecord, keys: string[]): string {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v) return v;
    }
    return '';
  }

  let content = $state('');
  let sourceType = $state('text');
  let submitting = $state(false);
  let error = $state('');
  let pending = $state<PendingAction | null>(null);

  let jobId = $state<string | null>(null);
  let status = $state<KagRecord | null>(null);
  let actionMsg = $state('');

  const jobState = $derived(status ? str(status, ['status', 'state']).toLowerCase() : '');
  const jobStage = $derived(status ? str(status, ['stage', 'current_stage', 'phase']) : '');
  const jobProgress = $derived(status ? num(status, ['progress', 'progress_pct', 'percent']) : undefined);
  const isTerminal = $derived(TERMINAL.has(jobState));

  const pollHandles = new Map<string, PollHandle>();
  function clearPoll(key: string): void {
    pollHandles.get(key)?.stop();
    pollHandles.delete(key);
  }

  function jobIdOf(res: unknown): string | null {
    if (!res || typeof res !== 'object') return null;
    const o = res as KagRecord;
    const v = o.job_id ?? o.id ?? o.ingestion_id;
    return typeof v === 'string' && v ? v : null;
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!content.trim() || submitting) return;
    submitting = true;
    error = '';
    pending = null;
    actionMsg = '';
    status = null;
    jobId = null;
    try {
      const res = await kagApi.submitPipeline({ source_type: sourceType, content: content.trim() });
      if (isPending(res)) {
        pending = res;
        return;
      }
      const id = jobIdOf(res);
      if (!id) {
        error = 'Submitted, but the pipeline returned no job id to track.';
        return;
      }
      jobId = id;
      status = (res && typeof res === 'object' ? res : {}) as KagRecord;
      startPolling(id);
    } catch (err) {
      error = errMsg(err);
    } finally {
      submitting = false;
    }
  }

  function startPolling(id: string): void {
    clearPoll(`job:${id}`);
    const handle = usePoll(
      async () => {
        try {
          const s = await kagApi.getJobStatus(id);
          if (jobId === id) status = s;
          if (jobId === id && isTerminal) clearPoll(`job:${id}`);
        } catch (e) {
          if (jobId === id) {
            error = `poll error: ${errMsg(e)}`;
            clearPoll(`job:${id}`);
          }
        }
      },
      { intervalMs: 3000 },
    );
    pollHandles.set(`job:${id}`, handle);
    handle.start();
  }

  async function act(verb: 'cancel' | 'resume' | 'delete'): Promise<void> {
    if (!jobId) return;
    actionMsg = '';
    error = '';
    try {
      const fn =
        verb === 'cancel' ? kagApi.cancelJob : verb === 'resume' ? kagApi.resumeJob : kagApi.deleteJob;
      const res = await fn(jobId);
      if (isPending(res)) {
        pending = res;
        actionMsg = `${verb}: pending approval`;
        return;
      }
      if (verb === 'delete') {
        clearPoll(`job:${jobId}`);
        actionMsg = 'Job deleted.';
        jobId = null;
        status = null;
        return;
      }
      actionMsg = `${verb === 'cancel' ? 'Cancel' : 'Resume'} requested.`;
      // Refresh once so the new state shows immediately, then resume polling.
      status = await kagApi.getJobStatus(jobId);
      if (verb === 'resume' && !isTerminal) startPolling(jobId);
    } catch (err) {
      error = errMsg(err);
    }
  }

  onDestroy(() => {
    for (const key of Array.from(pollHandles.keys())) clearPoll(key);
  });
</script>

<section
  class="rounded border bg-[var(--color-bg)] p-4 shadow-sm dark:bg-[var(--color-surface)]"
  data-testid="kag-pipeline"
>
  <h2 class="text-lg font-semibold mb-1">Pipeline job</h2>
  <p class="text-xs text-[var(--color-text-muted)] mb-3">
    Run one ingestion as a single tracked pipeline job — submit content, watch its
    stages, and cancel / resume / delete it. Admin-gated.
  </p>

  <form onsubmit={submit} class="space-y-3">
    <textarea
      data-testid="kag-pipeline-content"
      bind:value={content}
      rows="3"
      placeholder="Paste text to ingest as a tracked pipeline job…"
      class="w-full rounded border px-3 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      required
    ></textarea>
    <div class="flex flex-wrap items-center gap-3 text-sm">
      <label class="flex items-center gap-2">
        <span>Source type</span>
        <select
          data-testid="kag-pipeline-source-type"
          bind:value={sourceType}
          class="rounded border px-2 py-1 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        >
          <option value="text">text</option>
          <option value="document">document</option>
          <option value="url">url</option>
        </select>
      </label>
      <button
        type="submit"
        data-testid="kag-pipeline-submit"
        disabled={submitting || !content.trim()}
        class="ml-auto rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] text-sm disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Submit pipeline job'}
      </button>
    </div>
  </form>

  {#if error}
    <p class="mt-3 rounded bg-[var(--color-danger-bg)] p-2 text-sm text-[var(--color-danger-text)]" data-testid="kag-pipeline-error">
      {error}
    </p>
  {/if}
  {#if pending}
    <p class="mt-2 text-xs text-[var(--color-warning)]" data-testid="kag-pipeline-pending">
      Pending approval — actionId: <code>{pending.actionId}</code>
    </p>
  {/if}
  {#if actionMsg}
    <p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="kag-pipeline-action-msg">{actionMsg}</p>
  {/if}

  {#if jobId && status}
    <div class="mt-4 border-t border-[var(--color-border)] pt-3" data-testid="kag-pipeline-job">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Job</span>
        <code class="text-xs">{jobId}</code>
        <span
          class="rounded-full border px-2 py-0.5 text-[10px] {isTerminal && (jobState === 'failed' || jobState === 'error')
            ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
            : 'border-[var(--color-accent)] text-[var(--color-accent)]'}"
          data-testid="kag-pipeline-status"
          >{jobState || 'unknown'}</span
        >
        {#if jobStage}<span class="text-xs text-[var(--color-text-muted)]" data-testid="kag-pipeline-stage">{jobStage}</span>{/if}
        {#if jobProgress !== undefined}
          <span class="text-xs text-[var(--color-text-muted)]">{Math.round(jobProgress)}%</span>
        {/if}
      </div>

      <div class="mt-2 flex flex-wrap gap-2">
        {#if !isTerminal}
          <button type="button" data-testid="kag-pipeline-cancel" onclick={() => void act('cancel')} class="rounded border px-3 py-1 text-xs">Cancel</button>
        {/if}
        {#if isTerminal && (jobState === 'failed' || jobState === 'error' || jobState === 'cancelled' || jobState === 'canceled')}
          <button type="button" data-testid="kag-pipeline-resume" onclick={() => void act('resume')} class="rounded border px-3 py-1 text-xs">Resume</button>
        {/if}
        <button type="button" data-testid="kag-pipeline-delete" onclick={() => void act('delete')} class="rounded border border-[var(--color-danger)] px-3 py-1 text-xs text-[var(--color-danger)]">Delete</button>
      </div>
    </div>
  {/if}
</section>
