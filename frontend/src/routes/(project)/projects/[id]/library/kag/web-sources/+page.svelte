<!-- /projects/[id]/library/kag/web-sources — the tenant /library/kag/web-sources page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagIngestionTab from '../../../../../../library/kag/KagIngestionTab.svelte';
</script>

<KagPage title="KAG web sources" testid="project-kag-web-sources-page">
  <KagIngestionTab />
</KagPage>
