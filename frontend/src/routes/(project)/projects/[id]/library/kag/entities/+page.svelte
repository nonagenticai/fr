<!-- /projects/[id]/library/kag/entities — the tenant /library/kag/entities page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagEntitiesTab from '../../../../../../library/kag/KagEntitiesTab.svelte';
</script>

<KagPage title="KAG entities" testid="project-kag-entities-page">
  <KagEntitiesTab />
</KagPage>
