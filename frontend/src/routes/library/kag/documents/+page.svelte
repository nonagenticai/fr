<!-- /library/kag/documents — "KAG documents", formerly a tab of the /library/kag hub (see ../KagPage.svelte). -->
<script lang="ts">
  import KagPage from '../KagPage.svelte';
  import DocumentUploadPanel from '$lib/components/kag/DocumentUploadPanel.svelte';
</script>

<KagPage title="KAG documents" testid="kag-documents-page">
  {#snippet actions()}
    <a
      href="/library/kag_document"
      data-testid="kag-hub-link-manage-scope"
      class="text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:underline"
    >Manage scope →</a>
  {/snippet}
  <DocumentUploadPanel />
</KagPage>
