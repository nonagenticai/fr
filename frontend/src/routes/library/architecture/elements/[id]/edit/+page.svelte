<!--
  /library/architecture/elements/[id]/edit — edit form (control-plane Phase 5).
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureElementsManifest } from '$lib/manifests/architecture/elements';

  const id = $derived(decodeURIComponent($page.params.id ?? ''));
</script>

<AssetWorkspace manifest={architectureElementsManifest} mode="edit" {id} />
