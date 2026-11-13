<!--
  /library/architecture/elements/new — create form (control-plane Phase 5).
  Manifest-driven AssetWorkspace shell; on save it navigates to the new
  element's detail route under the /library/architecture/elements list.
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureElementsManifest } from '$lib/manifests/architecture/elements';
</script>

<AssetWorkspace manifest={architectureElementsManifest} mode="new" />
