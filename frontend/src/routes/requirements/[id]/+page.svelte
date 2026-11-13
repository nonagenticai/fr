<!--
  /requirements/[id] — detail view, manifest-driven AssetWorkspace shell.
-->
<script lang="ts">
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { requirementsManifest } from '$lib/manifests/requirements';
  import AssetClrPanel from '$lib/components/toc/AssetClrPanel.svelte';

  const id = $derived(decodeURIComponent(page.params.id ?? ''));
</script>

<AssetWorkspace manifest={requirementsManifest} mode="detail" {id} />

{#if id}
  <div class="px-6 pb-6">
    <AssetClrPanel kind="requirements" {id} />
  </div>
{/if}

{#if id}
  <div class="px-6 pb-6">
    {#key id}<TraceLinksPanel kind="requirement" itemId={id} />{/key}
  </div>
{/if}
