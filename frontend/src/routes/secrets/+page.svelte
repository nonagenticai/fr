<!--
  /secrets — list view, manifest-driven AssetWorkspace shell.
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { secretsManifest } from '$lib/manifests/secrets';
</script>

<AssetWorkspace manifest={secretsManifest} mode="list" />
