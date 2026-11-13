<!--
  /library/architecture/views — the views list. Was a 308 into the /library/architecture?tab=views
  hub tab; the nav standard (2026-10-03) inverted that: this route renders the
  list itself and is a sidebar row. It is also the back-link target that
  AssetWorkspace builds for the detail pages (/<name>).
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureViewsManifest } from '$lib/manifests/architecture/views';
</script>

<AssetWorkspace manifest={architectureViewsManifest} mode="list" />
