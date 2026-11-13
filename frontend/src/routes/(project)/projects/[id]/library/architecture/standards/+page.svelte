<!--
  /projects/[id]/library/architecture/standards — the tenant /library/architecture/standards
  list filtered to this project: requirements_management's list op accepts
  `project_id` and fr's passthrough forwards it.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { AssetWorkspace } from '$lib/asset-workspace';
  import { architectureStandardsManifest } from '$lib/manifests/architecture/standards';

  const query = $derived({ project_id: page.params.id ?? '' });
</script>

<AssetWorkspace manifest={architectureStandardsManifest} mode="list" {query} />
