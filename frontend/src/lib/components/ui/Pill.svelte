<script lang="ts">
  import type { Snippet } from 'svelte';
  type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

  let {
    tone = 'neutral',
    children,
    onclick,
    class: className = ''
  }: { tone?: Tone; children: Snippet; onclick?: (e: MouseEvent) => void; class?: string } = $props();

  const toneClass = $derived(
    {
      neutral: 'bg-[var(--color-surface-strong)] text-[var(--color-text)]',
      accent: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]',
      success: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
      warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
      danger: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
    }[tone]
  );
</script>

{#if onclick}
  <button
    {onclick}
    class={`inline-flex h-6 items-center rounded-full px-2 text-xs font-medium ${toneClass} ${className}`}
  >
    {@render children()}
  </button>
{:else}
  <span
    class={`inline-flex h-6 items-center rounded-full px-2 text-xs font-medium ${toneClass} ${className}`}
  >
    {@render children()}
  </span>
{/if}
