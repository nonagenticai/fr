<!-- Page header for a catalogue section, with the admin import action and the member read-only note. -->
<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import type { CatalogueMode } from '$lib/conveyor-catalogue/state';
  import ImportDefaults from './ImportDefaults.svelte';

  let {
    title,
    subtitle,
    mode,
    onImported,
  }: { title: string; subtitle: string; mode: CatalogueMode; onImported?: () => void } = $props();
</script>

<PageHeader {title} {subtitle} />
{#if mode === 'edit'}
  <ImportDefaults {onImported} />
{:else if mode === 'read'}
  <p data-testid="catalogue-read-only" class="text-xs text-[var(--color-text-muted)]">
    Read-only: only a workspace admin can change the conveyor catalogue.
  </p>
{:else}
  <p class="text-xs text-[var(--color-text-muted)]">Checking your workspace role…</p>
{/if}
