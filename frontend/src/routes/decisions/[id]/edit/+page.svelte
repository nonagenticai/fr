<!--
  /decisions/[id]/edit — edit form, manifest-driven AssetWorkspace shell.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { decisionsManifest } from '$lib/manifests/decisions';

  const id = $derived(decodeURIComponent($page.params.id ?? ''));
</script>

<AssetWorkspace manifest={decisionsManifest} mode="edit" {id} />
