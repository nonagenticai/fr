<!-- /projects/[id]/library/kag/benchmarks — the tenant /library/kag/benchmarks page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagBenchmarksTab from '../../../../../../library/kag/KagBenchmarksTab.svelte';
</script>

<KagPage title="KAG retrieval quality" testid="project-kag-benchmarks-page">
  <KagBenchmarksTab />
</KagPage>
