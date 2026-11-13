<!--
  library/architecture/standards/[id] — read-only asset detail (control-plane roadmap Phase 4).
  Manifest-driven AssetWorkspace; the back-link returns to the
  /library/architecture/standards list route.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import AssetRelationships from '$lib/asset-workspace/AssetRelationships.svelte';
  import { architectureStandardsManifest } from '$lib/manifests/architecture/standards';

  const id = $derived(decodeURIComponent($page.params.id ?? ''));
</script>

<div class="flex flex-col gap-4">
  <AssetWorkspace manifest={architectureStandardsManifest} mode="detail" {id} />
  {#if id}
    <AssetRelationships entityType="architecture_standards" entityId={id} />
  {/if}
</div>
