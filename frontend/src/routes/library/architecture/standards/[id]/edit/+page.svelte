<!--
  /library/architecture/standards/[id]/edit — edit form (control-plane Phase 5).
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureStandardsManifest } from '$lib/manifests/architecture/standards';

  const id = $derived(decodeURIComponent($page.params.id ?? ''));
</script>

<AssetWorkspace manifest={architectureStandardsManifest} mode="edit" {id} />
