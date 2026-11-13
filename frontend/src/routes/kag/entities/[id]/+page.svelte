<!--
  /kag/entities/[id] — Detail view of a single KAG graph entity. See
  the parent route for the manifest description.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { kagManifest } from '$lib/manifests/kag';

  const id = $derived(decodeURIComponent(page.params.id ?? ''));
</script>

<AssetWorkspace manifest={kagManifest} mode="detail" {id} />
