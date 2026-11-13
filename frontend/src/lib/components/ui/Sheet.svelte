<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    open = $bindable(true),
    title,
    children,
    class: className = ''
  }: { open?: boolean; title?: string; children: Snippet; class?: string } = $props();
</script>

{#if open}
  <aside
    class={`flex h-full w-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}
    aria-label={title}
  >
    {#if title}
      <header class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 class="text-sm font-semibold">{title}</h2>
        <button
          type="button"
          aria-label="Close pane"
          class="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          onclick={() => (open = false)}
        >×</button>
      </header>
    {/if}
    <div class="flex-1 overflow-auto p-4">
      {@render children()}
    </div>
  </aside>
{/if}
