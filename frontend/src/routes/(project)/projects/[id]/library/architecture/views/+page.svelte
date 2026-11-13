<!--
  /projects/[id]/library/architecture/views — the tenant /library/architecture/views
  list filtered to this project: requirements_management's list op accepts
  `project_id` and fr's passthrough forwards it.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureViewsManifest } from '$lib/manifests/architecture/views';

  const query = $derived({ project_id: page.params.id ?? '' });
</script>

<AssetWorkspace manifest={architectureViewsManifest} mode="list" {query} />
