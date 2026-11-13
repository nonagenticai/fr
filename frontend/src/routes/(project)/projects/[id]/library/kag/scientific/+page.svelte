<!-- /projects/[id]/library/kag/scientific — the tenant /library/kag/scientific page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagScientificTab from '../../../../../../library/kag/KagScientificTab.svelte';
</script>

<KagPage title="KAG scientific" testid="project-kag-scientific-page">
  <KagScientificTab />
</KagPage>
