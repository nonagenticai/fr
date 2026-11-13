<script lang="ts">
  // The red banner at the top of every project page while a platform operator has paused the
  // project (its reason only, no buttons). Re-read every 20 s while halted so the banner clears
  // itself once the project continues.
  import { page } from '$app/state';
  import { projectHalt } from '$lib/stores/projectHalt.svelte';
  import { HALT_TEXT, haltHeadline } from '$lib/projects/project-halt';

  // The project shell reads the id from the route; the /kanban page passes the selected
  // board's project (null for a board no project owns).
  let { projectId: forProject = undefined }: { projectId?: string | null } = $props();

  const POLL_MS = 20_000;
  const projectId = $derived(forProject === undefined ? (page.params?.id ?? '') : (forProject ?? ''));

  $effect(() => {
    const id = projectId;
    if (!id) {
      if (forProject !== undefined) projectHalt.clear();
      return;
    }
    void projectHalt.load(id);
  });

  // Poll only while halted (a released project needs no polling).
  $effect(() => {
    if (!projectHalt.halted) return;
    const timer = setInterval(() => void projectHalt.refresh(), POLL_MS);
    return () => clearInterval(timer);
  });

  const headline = $derived(projectHalt.projectId === projectId ? haltHeadline(projectHalt.view) : null);
</script>

{#if headline}
  <div
    role="alert"
    data-testid="project-halt-banner"
    class="border-b border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-6 py-3"
  >
    <p class="text-sm font-semibold text-[var(--color-danger-text)]" data-testid="project-halt-headline">{headline}</p>
  </div>
{:else if projectId && projectHalt.projectId === projectId && projectHalt.unreadable}
  <p class="border-b border-[var(--color-border)] px-6 py-2 text-xs text-[var(--color-text-muted)]" data-testid="project-halt-unreadable">
    {HALT_TEXT.unreadable}
  </p>
{/if}
