<!--
  /principles/[id]/edit — edit view, driven by the principlesManifest +
  AssetWorkspace. Linked from the detail view's Edit action.
  Plan: docs/superpowers/plans/...woolly-harp Wave 6 Tasks 6.3–6.9.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { principlesManifest } from '$lib/manifests/principles';

  const id = $derived(decodeURIComponent($page.params.id ?? ''));
</script>

<AssetWorkspace manifest={principlesManifest} mode="edit" {id} />
