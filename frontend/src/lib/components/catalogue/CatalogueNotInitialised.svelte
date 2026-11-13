<!--
  The `catalogue_not_initialised` state (backend services/catalogue/tenant-catalogue.ts):
  the tenant's RM catalogue has no phases or no project types, so nothing that
  needs its vocabulary can be shown. There is no fallback list.

  A SUPER-ADMIN gets the remedy: "Import defaults for this tenant" (RM
  import-defaults via POST /api/admin/tenants/:tenantId/catalogue/import-defaults).
  Everyone else gets a plain message.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    importTenantCatalogueDefaults,
    type CatalogueFailure,
    type CatalogueNotInitialisedInfo,
  } from '$lib/api/conveyor-catalogue';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';

  let { info, onImported }: { info: CatalogueNotInitialisedInfo; onImported?: () => void } = $props();

  let busy = $state(false);
  let failure = $state<CatalogueFailure | null>(null);
  let done = $state(false);

  async function run(): Promise<void> {
    if (!info.tenantId) return;
    busy = true;
    failure = null;
    const r = await importTenantCatalogueDefaults(info.tenantId);
    busy = false;
    if (!r.ok) {
      failure = r;
      return;
    }
    done = true;
    onImported?.();
  }
</script>

<div class="flex flex-col gap-2 rounded border border-[var(--color-border)] p-3 text-sm" data-testid="catalogue-not-initialised">
  <p class="font-medium">This workspace's project catalogue is not set up yet.</p>
  {#if auth.isSuperAdmin && info.tenantId}
    <p class="text-xs text-[var(--color-text-muted)]">
      Its project types and phases live in requirements management and are empty for tenant
      <span class="font-mono">{info.tenantId}</span>.
    </p>
    <div>
      <Button variant="secondary" size="sm" disabled={busy || done} onclick={run}>
        {busy ? 'Importing…' : done ? 'Imported' : 'Import defaults for this tenant'}
      </Button>
    </div>
    {#if failure}
      <FailureNotice {failure} title="Import failed" />
    {/if}
  {:else}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="catalogue-not-initialised-message">
      Ask a platform administrator to initialise it. Projects cannot be created or shown by phase until then.
    </p>
  {/if}
</div>
