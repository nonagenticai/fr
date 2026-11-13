<script lang="ts">
  /**
   * "← Cockpit" for the GLOBAL library pages (Research, Artifacts, /library/[type]
   * e.g. Triggers). Their sidebar rows sit under the project rows while a project
   * is selected, so they read as cockpit pages — but had no way back (fr review
   * round 3). Renders only while a project is selected in the header; the
   * project-scoped pages carry their own link (ProjectLibraryTab).
   */
  import { activeProject } from '$lib/stores/activeProject.svelte';
  import { projectNavHref } from '$lib/layout/navConfig';

  const projectId = $derived(activeProject.activeId);
</script>

{#if projectId}
  <a
    href={projectNavHref(projectId, '')}
    class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
    data-testid="cockpit-back-link"
  >
    ← Cockpit
  </a>
{/if}
