<!-- The frame every tenant-home card shares: a heading, a one-line explanation, an optional link. -->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    explain,
    linkLabel = '',
    linkHref = '',
    testid,
    children,
  }: {
    title: string;
    explain: string;
    linkLabel?: string;
    linkHref?: string;
    testid: string;
    children: Snippet;
  } = $props();
</script>

<section
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
  data-testid={testid}
>
  <div class="flex items-baseline justify-between gap-3">
    <h2 class="text-base font-semibold text-[var(--color-text)]">{title}</h2>
    {#if linkLabel && linkHref}
      <a href={linkHref} class="shrink-0 text-xs text-[var(--color-accent)] hover:underline">{linkLabel}</a>
    {/if}
  </div>
  <p class="mt-0.5 text-xs text-[var(--color-text-muted)]">{explain}</p>
  <div class="mt-3">
    {@render children()}
  </div>
</section>
