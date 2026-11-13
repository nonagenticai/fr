<!--
  /decisions/new — create form, manifest-driven AssetWorkspace shell.
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { decisionsManifest } from '$lib/manifests/decisions';
</script>

<AssetWorkspace manifest={decisionsManifest} mode="new" />
