<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { ErrorState } from '$lib/components/ui';
  import ConveyorMap from '$lib/components/library/ConveyorMap.svelte';
  import type { ConveyorPageData } from './+page';

  let { data }: { data: ConveyorPageData } = $props();
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <PageHeader
    title="Conveyor map"
    subtitle="Every card type of this workspace, placed by phase and capability. Read from its requirements catalogue."
  />

  {#if data.error || !data.taxonomy}
    <ErrorState
      title="Couldn't load the conveyor taxonomy"
      error={data.error ?? 'No data'}
      onRetry={() => void invalidateAll()}
    />
  {:else}
    <ConveyorMap taxonomy={data.taxonomy} />
  {/if}
</div>
