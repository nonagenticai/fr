<!-- /projects/[id]/library/kag/text-analysis — the tenant /library/kag/text-analysis page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagTextAnalysisTab from '../../../../../../library/kag/KagTextAnalysisTab.svelte';
</script>

<KagPage title="KAG text analysis" testid="project-kag-text-analysis-page">
  <KagTextAnalysisTab />
</KagPage>
