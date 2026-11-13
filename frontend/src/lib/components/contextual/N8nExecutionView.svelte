<!--
  N8nExecutionView — right-pane embed for a single n8n execution.
  Plan 3 follow-up §T11. Loads via the same getExecution() the
  /tools/n8n route uses, so the rendering is consistent without yet
  refactoring the larger /tools/n8n page.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getExecution } from '$lib/api/n8n';
  import { Pill } from '$lib/components/ui';

  type Props = { id: string };
  let { id }: Props = $props();

  let exec = $state<unknown | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      exec = await getExecution(id);
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  onMount(load);
</script>

<div class="flex flex-col gap-3 p-4">
  <header class="flex items-center justify-between">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">n8n execution</h2>
    <code class="text-xs text-[var(--color-text-muted)]">{id}</code>
  </header>
  {#if error}
    <Pill tone="warning">load failed: {error}</Pill>
  {:else if exec === null}
    <div class="text-xs italic text-[var(--color-text-muted)]">Loading…</div>
  {:else}
    <pre class="overflow-auto rounded bg-[var(--color-surface-muted)] p-2 text-xs">{JSON.stringify(exec, null, 2)}</pre>
  {/if}
</div>
