<!-- /projects/[id]/library/kag/documents — the tenant /library/kag/documents page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import { page } from '$app/state';
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import DocumentUploadPanel from '$lib/components/kag/DocumentUploadPanel.svelte';

  // "Manage scope" here is the project's own bound KAG documents list, not the tenant one.
  const scopeHref = $derived(`/projects/${encodeURIComponent(page.params.id ?? '')}/library/kag-documents`);
</script>

<KagPage title="KAG documents" testid="project-kag-documents-page">
  {#snippet actions()}
    <a
      href={scopeHref}
      data-testid="project-kag-hub-link-manage-scope"
      class="text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:underline"
    >Manage scope →</a>
  {/snippet}
  {#key page.params.id}
    <DocumentUploadPanel projectId={page.params.id ?? null} />
  {/key}
</KagPage>
