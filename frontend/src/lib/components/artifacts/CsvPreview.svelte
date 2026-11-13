<script lang="ts">
  import { onMount } from 'svelte';
  import { createVirtualizer, type SvelteVirtualizer } from '@tanstack/svelte-virtual';
  import type { Readable } from 'svelte/store';
  import { parseCsv } from './preview-loader';

  interface Props {
    body: string;
    truncated?: boolean;
  }

  const { body, truncated = false }: Props = $props();

  // CSV parsing extracted to preview-loader.ts so it's unit-testable.
  const rows = $derived(parseCsv(body));
  const header = $derived(rows[0] ?? []);
  const dataRows = $derived(rows.slice(1));

  let scrollEl = $state<HTMLDivElement | null>(null);
  // `createVirtualizer` returns a Svelte store (Readable<SvelteVirtualizer>);
  // we subscribe to it manually below to populate `vInstance`. Using `$state`
  // for the unwrapped instance lets `$derived` track recomputes when the
  // store fires.
  let vStore = $state<Readable<SvelteVirtualizer<HTMLDivElement, Element>> | null>(null);
  let vInstance = $state<SvelteVirtualizer<HTMLDivElement, Element> | null>(null);

  onMount(() => {
    if (!scrollEl) return;
    vStore = createVirtualizer<HTMLDivElement, Element>({
      count: dataRows.length,
      getScrollElement: () => scrollEl,
      estimateSize: () => 28,
      overscan: 10,
    });
    const unsub = vStore.subscribe((v) => {
      vInstance = v;
    });
    return unsub;
  });

  const items = $derived(vInstance?.getVirtualItems() ?? []);
  const totalSize = $derived(vInstance?.getTotalSize() ?? 0);
</script>

<div class="csv-preview" data-testid="csv-preview">
  {#if truncated}
    <div class="text-xs text-[var(--color-warning)] bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] px-2 py-1 rounded mb-2 dark:text-[var(--color-warning-text)] dark:bg-[var(--color-warning-bg)]/20">
      Preview truncated at 1 MiB; trailing rows omitted.
    </div>
  {/if}
  <div class="text-xs text-[var(--color-text-muted)] mb-2 dark:text-[var(--color-text-muted)]">
    {dataRows.length} rows × {header.length} columns
  </div>

  <div class="border border-[var(--color-border)] rounded overflow-hidden bg-[var(--color-bg)] dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]">
    <!-- Header (non-virtualized; sticky) -->
    <div class="grid sticky top-0 z-10 bg-[var(--color-surface)] border-b border-[var(--color-border)] text-xs font-semibold dark:bg-[var(--color-bg)] dark:border-[var(--color-border)]"
         style:grid-template-columns="repeat({Math.max(header.length, 1)}, minmax(8rem, 1fr))">
      {#each header as h, i (i)}
        <div class="px-2 py-1 truncate border-r border-[var(--color-border)] dark:border-[var(--color-border)]">{h}</div>
      {/each}
    </div>

    <!-- Virtualized body -->
    <div bind:this={scrollEl} class="overflow-auto max-h-[60vh]" data-testid="csv-preview-scroll">
      {#if vInstance}
        <div style:height="{totalSize}px" style:position="relative">
          {#each items as v (v.index)}
            <div
              class="grid absolute left-0 right-0 text-xs border-b border-[var(--color-border)] dark:border-[var(--color-border-strong)]"
              style:top="{v.start}px"
              style:height="{v.size}px"
              style:grid-template-columns="repeat({Math.max(header.length, 1)}, minmax(8rem, 1fr))"
            >
              {#each dataRows[v.index] ?? [] as cell, c (c)}
                <div class="px-2 py-1 truncate border-r border-[var(--color-border)] font-mono dark:border-[var(--color-border-strong)]">{cell}</div>
              {/each}
            </div>
          {/each}
        </div>
      {:else}
        <!-- SSR / pre-mount fallback: render first 50 rows so the page is meaningful -->
        {#each dataRows.slice(0, 50) as r, i (i)}
          <div
            class="grid text-xs border-b border-[var(--color-border)] dark:border-[var(--color-border-strong)]"
            style:grid-template-columns="repeat({Math.max(header.length, 1)}, minmax(8rem, 1fr))"
          >
            {#each r as cell, c (c)}
              <div class="px-2 py-1 truncate border-r border-[var(--color-border)] font-mono dark:border-[var(--color-border-strong)]">{cell}</div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
