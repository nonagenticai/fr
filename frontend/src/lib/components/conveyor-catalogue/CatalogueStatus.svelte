<!--
  The non-ready states of a catalogue list: loading, unavailable (RM down /
  MISSING_TENANT), not shipped by RM yet, refused, and the honest empty state
  that offers the import to admins.
-->
<script lang="ts">
  import { EmptyState, Skeleton } from '$lib/components/ui';
  import type { ListView } from '$lib/conveyor-catalogue/state';
  import type { CatalogueMode } from '$lib/conveyor-catalogue/state';
  import FailureNotice from './FailureNotice.svelte';
  import ImportDefaults from './ImportDefaults.svelte';

  let {
    view,
    mode,
    noun,
    onImported,
  }: { view: ListView<unknown>; mode: CatalogueMode; noun: string; onImported?: () => void } = $props();
</script>

{#if view.kind === 'loading'}
  <Skeleton height="6rem" />
{:else if view.kind === 'unavailable'}
  <div data-testid="catalogue-unavailable" class="flex flex-col gap-2">
    <p class="text-sm text-[var(--color-text)]">
      The conveyor catalogue is unavailable right now. This is not an empty catalogue: requirements_management
      could not be reached, or fr could not name your workspace.
    </p>
    <FailureNotice failure={view.failure} title="Catalogue unavailable" />
  </div>
{:else if view.kind === 'not-shipped'}
  <p data-testid="catalogue-not-shipped" class="text-sm text-[var(--color-text-muted)]">
    requirements_management does not serve {noun} yet (it answered 404).
  </p>
{:else if view.kind === 'error'}
  <FailureNotice failure={view.failure} title="Couldn't read {noun}" />
{:else if view.kind === 'empty'}
  <div data-testid="catalogue-empty" class="flex flex-col gap-3">
    <EmptyState
      title="No catalogue yet — import defaults"
      body={mode === 'edit'
        ? `This workspace has no ${noun}. Import the default catalogue, or create one below.`
        : `This workspace has no ${noun}. A workspace admin can import the default catalogue.`}
    />
    {#if mode === 'edit'}
      <ImportDefaults {onImported} />
    {/if}
  </div>
{/if}
