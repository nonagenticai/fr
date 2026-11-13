<!--
  "Import defaults" (tenant admins). RM seeds the tenant's catalogue from its
  defaults; existing rows are left alone (Tier 1: unset attributes are filled).
  The counts RM returns are shown as received.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { importCatalogueDefaults, type CatalogueFailure } from '$lib/api/conveyor-catalogue';
  import { importRows, type ImportRow } from '$lib/conveyor-catalogue/state';
  import FailureNotice from './FailureNotice.svelte';

  let { onImported }: { onImported?: () => void } = $props();

  let busy = $state(false);
  let rows = $state<ImportRow[] | null>(null);
  let skipped = $state<[string, string[]][]>([]);
  let failure = $state<CatalogueFailure | null>(null);

  async function run(): Promise<void> {
    busy = true;
    failure = null;
    const r = await importCatalogueDefaults();
    busy = false;
    if (!r.ok) {
      failure = r;
      return;
    }
    const out = importRows(r.data);
    rows = out.rows;
    skipped = out.skipped;
    onImported?.();
  }
</script>

<div class="flex flex-col gap-2" data-testid="catalogue-import">
  <div>
    <Button variant="secondary" size="sm" disabled={busy} onclick={run}>
      {busy ? 'Importing…' : 'Import defaults'}
    </Button>
  </div>
  {#if failure}
    <FailureNotice {failure} title="Import failed" />
  {/if}
  {#if rows}
    <div class="overflow-x-auto">
      <table class="w-max min-w-[24rem] text-left text-xs" data-testid="catalogue-import-counts">
        <thead class="text-[var(--color-text-muted)]">
          <tr><th class="pr-4">Collection</th><th class="pr-4">Created</th><th class="pr-4">Existing</th><th>Filled</th></tr>
        </thead>
        <tbody>
          {#each rows as row (row.collection)}
            <tr>
              <td class="pr-4 font-mono">{row.collection}</td>
              <td class="pr-4">{row.created}</td>
              <td class="pr-4">{row.existing}</td>
              <td>{row.filled ?? 'not reported'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#each skipped as [key, names] (key)}
      <p class="text-xs text-[var(--color-text-muted)]">{key}: {names.join(', ')}</p>
    {/each}
  {/if}
</div>
