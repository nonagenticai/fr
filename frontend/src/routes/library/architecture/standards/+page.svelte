<!--
  /library/architecture/standards — the standards list. Was a 308 into the /library/architecture?tab=standards
  hub tab; the nav standard (2026-10-03) inverted that: this route renders the
  list itself and is a sidebar row. It is also the back-link target that
  AssetWorkspace builds for the detail pages (/<name>).
-->
<script lang="ts">
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureStandardsManifest } from '$lib/manifests/architecture/standards';
</script>

<AssetWorkspace manifest={architectureStandardsManifest} mode="list" />
