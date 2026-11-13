<!--
  /library/architecture/views/new — create form (control-plane Phase 5).
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureViewsManifest } from '$lib/manifests/architecture/views';
</script>

<AssetWorkspace manifest={architectureViewsManifest} mode="new" />
