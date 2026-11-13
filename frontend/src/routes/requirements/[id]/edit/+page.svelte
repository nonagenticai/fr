<!--
  /requirements/[id]/edit — edit form, manifest-driven AssetWorkspace shell.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { requirementsManifest } from '$lib/manifests/requirements';

  const id = $derived(decodeURIComponent($page.params.id ?? ''));
</script>

<AssetWorkspace manifest={requirementsManifest} mode="edit" {id} />
