<!--
  /projects/[id]/traceability — the tenant /knowledge/graph scoped to this project:
  fr's graph route forwards `project_id` to requirements_management's relationship list
  and keeps only that project's edges on a rooted walk.
-->
<script lang="ts">
  import { page } from '$app/state';
  import TraceabilityPage from '$lib/components/traceability/TraceabilityPage.svelte';

  const projectId = $derived(page.params.id ?? '');
</script>

{#key projectId}
  <TraceabilityPage {projectId} basePath="/projects/{projectId}/traceability" />
{/key}
