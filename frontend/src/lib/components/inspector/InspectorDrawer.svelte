<script lang="ts">
  // Generic right-hand inspector drawer — the reusable shell modelled on
  // kag/KagNodeDetailPanel: a type tag + title + subtitle identity header with a
  // close button, over a scrollable body the caller composes (KvBlock,
  // CheckList, EvidencePillRow, …). The drawer is a dumb shell; callers own the
  // content and the close callback.
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** Small type pill above the title, e.g. 'Card'. */
    tag?: string;
    /** Muted line under the title (identity / status). */
    subtitle?: string;
    onclose?: () => void;
    /** The scrollable body. */
    children?: Snippet;
    class?: string;
  }
  let { title, tag, subtitle, onclose, children, class: className = '' }: Props = $props();
</script>

<aside
  class={`flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}
  data-testid="inspector-drawer"
>
  <header class="border-b border-[var(--color-border)] p-4">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        {#if tag}
          <span
            class="inline-block rounded-full bg-[var(--color-accent-bg)] px-2 py-0.5 text-xs font-medium text-[var(--color-accent-strong)]"
            >{tag}</span
          >
        {/if}
        <h3 class="mt-1.5 break-words text-lg font-semibold text-[var(--color-text)]">{title}</h3>
        {#if subtitle}
          <p class="mt-0.5 break-words text-xs text-[var(--color-text-muted)]">{subtitle}</p>
        {/if}
      </div>
      <button
        type="button"
        onclick={() => onclose?.()}
        class="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)]"
        title="Close"
        aria-label="Close details">✕</button
      >
    </div>
  </header>

  <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
    {@render children?.()}
  </div>
</aside>
