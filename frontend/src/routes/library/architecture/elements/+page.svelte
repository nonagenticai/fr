<!--
  /library/architecture/elements — the elements list. Was a 308 into the /library/architecture?tab=elements
  hub tab; the nav standard (2026-10-03) inverted that: this route renders the
  list itself and is a sidebar row. It is also the back-link target that
  AssetWorkspace builds for the detail pages (/<name>).
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureElementsManifest } from '$lib/manifests/architecture/elements';
</script>

<AssetWorkspace manifest={architectureElementsManifest} mode="list" />
