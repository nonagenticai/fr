<!--
  /projects/[id]/library/architecture/relationships — the tenant /library/architecture/relationships
  list filtered to this project: requirements_management's list op accepts
  `project_id` and fr's passthrough forwards it.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureRelationshipsManifest } from '$lib/manifests/architecture/relationships';

  const query = $derived({ project_id: page.params.id ?? '' });
</script>

<AssetWorkspace manifest={architectureRelationshipsManifest} mode="list" {query} />
