<!--
  library/architecture/elements/[id] — read-only asset detail (control-plane roadmap Phase 4).
  Manifest-driven AssetWorkspace; the back-link returns to the
  /library/architecture/elements list route.
-->
<script lang="ts">
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import AssetRelationships from '$lib/asset-workspace/AssetRelationships.svelte';
  import { architectureElementsManifest } from '$lib/manifests/architecture/elements';

  const id = $derived(decodeURIComponent(page.params.id ?? ''));
</script>

<div class="flex flex-col gap-4">
  <AssetWorkspace manifest={architectureElementsManifest} mode="detail" {id} />
  {#if id}
    {#key id}<TraceLinksPanel kind="element" itemId={id} />{/key}
    <AssetRelationships entityType="architecture_elements" entityId={id} />
  {/if}
</div>
