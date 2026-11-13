<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    toolName,
    status = 'running',
    summary = '',
    children,
    class: className = ''
  }: {
    toolName: string;
    status?: 'running' | 'success' | 'failed';
    summary?: string;
    children?: Snippet;
    class?: string;
  } = $props();

  const statusTone = $derived(
    status === 'running'
      ? 'border-[var(--color-accent)]'
      : status === 'success'
        ? 'border-[var(--color-success)]'
        : 'border-[var(--color-danger)]'
  );
</script>

<div
  class={`rounded-[var(--radius-md)] border-l-2 bg-[var(--color-surface)] p-3 text-sm ${statusTone} ${className}`}
>
  <div class="font-mono text-xs text-[var(--color-text-muted)]">tool: {toolName} — {status}</div>
  {#if summary}
    <div class="mt-1 text-[var(--color-text)]">{summary}</div>
  {/if}
  {#if children}
    <div class="mt-2">{@render children()}</div>
  {/if}
</div>
