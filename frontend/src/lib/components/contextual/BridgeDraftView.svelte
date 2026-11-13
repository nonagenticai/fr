<!--
  BridgeDraftView — right-pane embed for a single analysis-to-kanban draft.
  Plan 3 follow-up §T11. Uses unified-client's bridge.getDraft.
  Project context is taken from the optional `meta.project_id` field
  the agent loop puts on rightPane.setContent.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiClient } from '$lib/api/unified-client';
  import { rightPane } from '$lib/stores/rightPane.svelte';
  import { Pill } from '$lib/components/ui';

  type Props = { id: string };
  let { id }: Props = $props();

  let draft = $state<Record<string, unknown> | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    const projectId =
      (rightPane.meta?.project_id as string | undefined) ??
      (rightPane.meta?.projectId as string | undefined);
    if (!projectId) {
      error = 'BridgeDraftView requires meta.project_id on rightPane.setContent';
      return;
    }
    try {
      const res = await apiClient.bridge.getDraft(projectId, id);
      draft = res as unknown as Record<string, unknown>;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  onMount(load);
</script>

<div class="flex flex-col gap-3 p-4">
  <header class="flex items-center justify-between">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">Bridge draft</h2>
    <code class="text-xs text-[var(--color-text-muted)]">{id}</code>
  </header>
  {#if error}
    <Pill tone="warning">{error}</Pill>
  {:else if draft === null}
    <div class="text-xs italic text-[var(--color-text-muted)]">Loading…</div>
  {:else}
    <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      <dt class="text-[var(--color-text-muted)]">Title</dt>
      <dd>{String(draft.title ?? '—')}</dd>
      <dt class="text-[var(--color-text-muted)]">Status</dt>
      <dd>{String(draft.status ?? '—')}</dd>
    </dl>
    <pre class="max-h-64 overflow-auto rounded bg-[var(--color-surface-muted)] p-2 text-xs">{JSON.stringify(draft, null, 2)}</pre>
  {/if}
</div>
