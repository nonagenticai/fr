<!--
  library/architecture/views/[id] — read-only asset detail (control-plane roadmap Phase 4),
  plus the view's diagram as requirements_management draws it (sandboxed; PNG download).
  Manifest-driven AssetWorkspace; the back-link returns to the
  /library/architecture/views list route.
-->
<script lang="ts">
  import TraceLinksPanel from '$lib/components/modeling/TraceLinksPanel.svelte';
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import AssetRelationships from '$lib/asset-workspace/AssetRelationships.svelte';
  import DiagramViewer from '$lib/components/modeling/DiagramViewer.svelte';
  import { architectureViewsManifest } from '$lib/manifests/architecture/views';

  const id = $derived(decodeURIComponent($page.params.id ?? ''));
</script>

<div class="flex flex-col gap-4">
  <AssetWorkspace manifest={architectureViewsManifest} mode="detail" {id} />
  {#if id}
    {#key id}<TraceLinksPanel kind="view" itemId={id} />{/key}
    {#key id}
      <DiagramViewer viewId={id} title="Diagram (current draft)" />
    {/key}
    <AssetRelationships entityType="architecture_views" entityId={id} />
  {/if}
</div>
