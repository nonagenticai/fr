<!--
  SandboxCell — reproduce a reported statistic by running Python in the Scientific
  Processor's sandboxed, time-limited environment. Async: execute → { job_id } →
  poll the job → fetch results. Self-contained (all state + polling live here) so
  it composes into Stage 5 without touching the page's verify state.

  Honest states: running spinner, per-run error, and stdout/stderr/result split.
  onDestroy drains the poll so a stage change never leaks a timer.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { AssetError } from '$lib/api/assets';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import {
    researchApi,
    isSandboxTerminal,
    type SandboxJobStatus,
    type SandboxResult,
  } from '$lib/api/research';

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  let code = $state('');
  let running = $state(false);
  let error = $state('');
  let job = $state<SandboxJobStatus | null>(null);
  let result = $state<SandboxResult | null>(null);
  let poll: PollHandle | null = null;

  function clearPoll(): void {
    poll?.stop();
    poll = null;
  }

  async function fetchResult(jobId: string): Promise<void> {
    try {
      result = await researchApi.sandboxResult(jobId);
    } catch (e) {
      // A failed job may have no results document — surface the job error instead.
      error = job?.error ? job.error : errMsg(e);
    }
  }

  async function run(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    if (running || !code.trim()) return;
    clearPoll();
    running = true;
    error = '';
    job = null;
    result = null;
    try {
      const started = await researchApi.sandboxExecute({
        code,
        language: 'python',
        timeout_seconds: 60,
      });
      const jobId = started.job_id;
      if (!jobId) {
        error = 'No job id returned.';
        running = false;
        return;
      }
      poll = usePoll(
        async () => {
          try {
            const j = await researchApi.sandboxJob(jobId);
            job = j;
            if (isSandboxTerminal(j.status)) {
              clearPoll();
              running = false;
              if ((j.status ?? '').toLowerCase() === 'completed') {
                await fetchResult(jobId);
              } else if (j.error) {
                error = j.error;
              }
            }
          } catch (err) {
            clearPoll();
            running = false;
            error = errMsg(err);
          }
        },
        { intervalMs: 2000 },
      );
      poll.start();
    } catch (err) {
      error = errMsg(err);
      running = false;
    }
  }

  function resultText(): string {
    if (!result) return '';
    if (result.result === undefined || result.result === null) return '';
    return typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result, null, 2);
  }

  onDestroy(() => clearPoll());
</script>

<div class="flex flex-col gap-2" data-testid="sandbox-cell">
  <details>
    <summary class="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">
      Reproduce a statistic (sandboxed Python)
    </summary>
    <form class="mt-2 flex flex-col gap-2" onsubmit={run}>
      <textarea
        data-testid="sandbox-code"
        bind:value={code}
        rows="5"
        placeholder={'# e.g. recompute a pooled mean\nimport statistics\nprint(statistics.mean([0.42, 0.51, 0.38]))'}
        class="w-full rounded border bg-[var(--color-surface)] px-2 py-1 font-mono text-xs"
      ></textarea>
      <div class="flex items-center gap-2">
        <button
          type="submit"
          data-testid="sandbox-run"
          disabled={running || !code.trim()}
          class="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-on-primary)] disabled:opacity-50"
          >{running ? 'Running…' : 'Run'}</button
        >
        {#if job && !running}
          <span class="text-xs text-[var(--color-text-muted)]" data-testid="sandbox-status">
            {job.status}{#if typeof job.execution_time_ms === 'number'}
              · {job.execution_time_ms.toFixed(0)}ms{/if}
          </span>
        {/if}
      </div>
    </form>

    {#if error}
      <p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="sandbox-error">{error}</p>
    {/if}

    {#if result}
      <div class="mt-2 flex flex-col gap-2 text-xs">
        {#if result.stdout}
          <div data-testid="sandbox-stdout">
            <span class="text-[var(--color-text-muted)]">stdout</span>
            <pre
              class="overflow-x-auto rounded border bg-[var(--color-surface)] p-2 font-mono">{result.stdout}</pre>
          </div>
        {/if}
        {#if result.stderr}
          <div data-testid="sandbox-stderr">
            <span class="text-[var(--color-text-muted)]">stderr</span>
            <pre
              class="overflow-x-auto rounded border bg-[var(--color-surface)] p-2 font-mono text-[var(--color-danger)]">{result.stderr}</pre>
          </div>
        {/if}
        {#if resultText()}
          <div data-testid="sandbox-result">
            <span class="text-[var(--color-text-muted)]">result</span>
            <pre
              class="overflow-x-auto rounded border bg-[var(--color-surface)] p-2 font-mono">{resultText()}</pre>
          </div>
        {/if}
      </div>
    {/if}
  </details>
</div>
