<!--
  /library/architecture/views/[id]/edit — edit form (control-plane Phase 5).
-->
<script lang="ts">
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureViewsManifest } from '$lib/manifests/architecture/views';

  const id = $derived(decodeURIComponent(page.params.id ?? ''));
</script>

<AssetWorkspace manifest={architectureViewsManifest} mode="edit" {id} />
