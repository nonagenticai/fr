<!--
  /principles — list view, driven by the principlesManifest + AssetWorkspace.
  Plan: docs/superpowers/plans/...woolly-harp Wave 6 Tasks 6.3–6.9.
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { principlesManifest } from '$lib/manifests/principles';
</script>

<AssetWorkspace manifest={principlesManifest} mode="list" />
