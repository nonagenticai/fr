<!--
  /library/architecture/relationships/new — create form (control-plane Phase 5).
  Relationships are immutable upstream, so there is no edit route (manifest
  exposes create + remove only).
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureRelationshipsManifest } from '$lib/manifests/architecture/relationships';
</script>

<AssetWorkspace manifest={architectureRelationshipsManifest} mode="new" />
