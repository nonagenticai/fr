<script lang="ts">
  // Reusable "Create card from this" button consumed by Wave-1 list pages
  // (coding analyses, KAG ingestion sessions, artifacts). See spec
  // 2026-04-24-analysis-to-kanban-bridge.md §Frontend bullet 1.
  import { goto } from '$app/navigation';
  import { apiClient } from '$lib/api/unified-client';
  import { bridgeSelection } from './selection.svelte';
  import type { ProducerId, ToolOutput } from './types';

  interface Props {
    /**
     * Project scope. Every bridge route is `(user_id, project_id)`-scoped
     * by the backend (see backend/src/routes/tools/bridge.ts:84-92,240-246).
     * Required — there is no global current-project store; consumers must
     * pass it explicitly from the route param / page state.
     */
    project_id: string;
    producer: ProducerId;
    output: ToolOutput;
    /** 'single' = POST + navigate; 'select' = toggle the selection store. */
    mode?: 'single' | 'select';
    /** Optional override for compact rendering inside dense tables. */
    compact?: boolean;
  }

  let {
    project_id,
    producer,
    output,
    mode = 'single',
    compact = false,
  }: Props = $props();

  let busy = $state(false);
  let error = $state<string | null>(null);

  const isSelected = $derived(bridgeSelection.has(output.stable_id));

  async function promoteSingle() {
    if (busy) return;
    if (!project_id) {
      error = 'Missing project_id; cannot create draft';
      return;
    }
    busy = true;
    error = null;
    try {
      // For producer='coding', output.run_id is the FR coding_analysis_runs
      // id — pass it as `coding_job_id` so the backend can resolve the
      // output on a cache miss without requiring a prior listOutputs call.
      const { drafts } = await apiClient.bridge.createDrafts(project_id, {
        producer,
        output_ids: [output.output_id],
        ...(producer === 'coding' && output.run_id
          ? { coding_job_id: output.run_id }
          : {}),
      });
      const draft = drafts?.[0];
      const qs = `?project=${encodeURIComponent(project_id)}`;
      if (draft) {
        await goto(`/bridge/${draft.id}${qs}`);
      } else {
        await goto(`/bridge${qs}`);
      }
    } catch (err) {
      console.error('PromoteButton: createDrafts failed', err);
      error = err instanceof Error ? err.message : 'Failed to create draft';
    } finally {
      busy = false;
    }
  }

  function toggleSelection() {
    // Pin the selection store to this project; if the user crosses projects
    // the store self-resets to avoid mixing scopes (see selection.svelte.ts).
    bridgeSelection.ensureProject(project_id);
    bridgeSelection.toggle(output);
  }

  function handleClick() {
    if (mode === 'select') {
      toggleSelection();
    } else {
      promoteSingle();
    }
  }
</script>

<button
  type="button"
  onclick={handleClick}
  disabled={busy}
  title={error ?? undefined}
  aria-label={mode === 'single'
    ? `Create card from ${producer} output ${output.title}`
    : `Add ${producer} output ${output.title} to bridge selection`}
  class={
    'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
    (compact ? 'px-2 py-1 text-xs ' : 'px-3 py-1.5 text-sm ') +
    (mode === 'select'
      ? isSelected
        ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] '
        : 'bg-[var(--color-bg)] text-[var(--color-accent-strong)] dark:text-[var(--color-accent)] border border-[var(--color-accent)] dark:border-[var(--color-accent-strong)] hover:bg-[var(--color-accent)] dark:hover:bg-[var(--color-accent-strong)]/30 '
      : 'bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] ')
  }
>
  {#if busy}
    <svg class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
    </svg>
  {:else if mode === 'select'}
    {#if isSelected}
      <svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
      </svg>
    {:else}
      <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
    {/if}
  {/if}
  <span>
    {#if mode === 'select'}
      {isSelected ? 'Selected' : 'Select'}
    {:else}
      Create card
    {/if}
  </span>
</button>
