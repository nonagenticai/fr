<!--
  Single source of truth for page-title headers.

  - variant="page" (default): the bare cockpit/system title used by top-level lens
    pages (Control tower, the improvement observatories). No border, no back-link.
  - variant="inspect": the bordered, back-linked header used by the project Inspect
    routes (via ProjectInspectHeader, which wraps this). Pass backHref/backLabel.

  Both share the same title/subtitle/actions markup so there is one place to change.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    subtitle?: string;
    /** When set (inspect variant), renders a "← {backLabel}" link. */
    backHref?: string;
    backLabel?: string;
    /** Optional right-aligned actions (snippet). */
    actions?: Snippet;
    variant?: 'page' | 'inspect';
  }
  let {
    title,
    subtitle,
    backHref,
    backLabel = 'Back',
    actions,
    variant = 'page',
  }: Props = $props();
</script>

{#if variant === 'inspect'}
  <header
    class="flex items-end justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4"
  >
    <div class="flex flex-col gap-1">
      {#if backHref}
        <a
          href={backHref}
          class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        >
          ← {backLabel}
        </a>
      {/if}
      <h1 class="text-xl font-semibold text-[var(--color-text)]">{title}</h1>
      {#if subtitle}
        <p class="max-w-3xl text-sm text-[var(--color-text-muted)]">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
    {/if}
  </header>
{:else}
  <div class={actions ? 'flex items-end justify-between gap-4' : ''}>
    <div>
      <h1 class="text-lg font-bold text-[var(--color-text)]">{title}</h1>
      {#if subtitle}
        <p class="text-sm text-[var(--color-text-muted)]">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
    {/if}
  </div>
{/if}
