<!--
  /projects/[id]/repositories — the repositories THIS project builds against.

  ⛔ This page used to render `<RepositoriesTab />` with NO projectId. It derived
  `projectId` for the header and nothing else, so the tab listed
  `GET /api/repositories` — filtered by `user_id` alone — and edited and DELETED
  through that same global scope, under a subtitle claiming to be about "this
  project". Project A's page showed, and could destroy, every repository the
  signed-in user owns across all their projects.

  Passing `projectId` routes list / attach / detach / promote-to-primary through
  `/api/projects/:id/repositories` (migration 072). See the module-script header
  of RepositoriesTab.svelte for the shape normalisation and for the one operation
  that deliberately stays global (Edit), which the subtitle below now states.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import RepositoriesTab from '../../../../repositories/RepositoriesTab.svelte';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';

  const projectId = $derived($page.params.id ?? '');
</script>

<ProjectInspectHeader
  {projectId}
  title="Repositories"
  subtitle="The code repositories this project's cards build against. Attaching, detaching and promoting to primary affect this project only; editing a repository's URL, branch, path, description or linked secret changes the repository record itself, in every project it is attached to."
/>

<div class="p-6">
  <RepositoriesTab {projectId} />
</div>
