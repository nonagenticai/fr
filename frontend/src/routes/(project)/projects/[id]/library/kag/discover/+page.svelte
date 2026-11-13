<!-- /projects/[id]/library/kag/discover — the tenant /library/kag/discover page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagDiscoverTab from '../../../../../../library/kag/KagDiscoverTab.svelte';
</script>

<KagPage title="KAG discovery" testid="project-kag-discover-page">
  <KagDiscoverTab />
</KagPage>
