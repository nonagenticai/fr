<!--
  /requirements — list view, manifest-driven AssetWorkspace shell.
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { requirementsManifest } from '$lib/manifests/requirements';
</script>

<AssetWorkspace manifest={requirementsManifest} mode="list" />
