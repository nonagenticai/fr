<!--
  /projects/[id]/needs-you — R4 (FR-PROJECT-HOME-REDESIGN §3, §5 R4): the ONE place for every open
  ask, sign-off and review on the project, oldest first and answerable inline, with the decided
  history below and the caller's project conversations. /projects/[id]/approvals and
  /projects/[id]/threads 308 here. See ProjectNeedsYou for where each row comes from.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import ProjectNeedsYou from '$lib/components/needs-you/ProjectNeedsYou.svelte';

  const projectId = $derived($page.params.id ?? '');
</script>

<ProjectInspectHeader
  {projectId}
  title="Needs you"
  subtitle="Every question, sign-off and review waiting on people for this project, oldest first, with what was decided below."
/>

{#if projectId}
  {#key projectId}
    <ProjectNeedsYou {projectId} />
  {/key}
{/if}
