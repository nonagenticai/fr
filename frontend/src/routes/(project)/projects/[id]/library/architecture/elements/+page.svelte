<!--
  /projects/[id]/library/architecture/elements — the tenant /library/architecture/elements
  list filtered to this project: requirements_management's list op accepts
  `project_id` and fr's passthrough forwards it.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureElementsManifest } from '$lib/manifests/architecture/elements';

  const query = $derived({ project_id: page.params.id ?? '' });
</script>

<AssetWorkspace manifest={architectureElementsManifest} mode="list" {query} />
