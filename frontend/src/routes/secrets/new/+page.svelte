<!--
  /secrets/new — create form, manifest-driven AssetWorkspace shell.
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { secretsManifest } from '$lib/manifests/secrets';
</script>

<AssetWorkspace manifest={secretsManifest} mode="new" />
