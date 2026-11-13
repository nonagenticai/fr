<!-- /projects/[id]/library/kag/graph — the tenant /library/kag/graph page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagGraphExploreTab from '../../../../../../library/kag/KagGraphExploreTab.svelte';
</script>

<KagPage title="KAG graph explorer" testid="project-kag-graph-page">
  <KagGraphExploreTab />
</KagPage>
