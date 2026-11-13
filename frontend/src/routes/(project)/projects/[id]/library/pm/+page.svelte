<!--
  /projects/[id]/library/pm — the project's READ-ONLY PM library (fr-agui SPEC
  §16 D12, George 2026-10-14: "fr PM library UI: re-homed read-only in the
  project shell … sourced from RM. Catalogue editing stays in RM").
-->
<script lang="ts">
  import { page } from '$app/stores';
  import ProjectPmLibrary from '$lib/components/project-pm/ProjectPmLibrary.svelte';

  const projectId = $derived($page.params.id ?? '');
</script>

<h1 class="mb-3 text-lg font-semibold">Project PM library</h1>
<ProjectPmLibrary {projectId} />
