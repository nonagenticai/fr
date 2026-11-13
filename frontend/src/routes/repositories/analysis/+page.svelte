<!--
  /repositories/analysis — trigger/review coding analyses (formerly
  /tools/coding, then the "Analysis" tab of /repositories; nav standard
  2026-10-03 made it a route + row). Job detail stays /repositories/jobs/[id].
-->
<script lang="ts">
  import AnalysisTab from '../AnalysisTab.svelte';
</script>

<div class="px-6 py-4 flex flex-col gap-4" data-testid="repositories-analysis-page">
  <h1 class="sr-only">Code analysis</h1>
  <AnalysisTab />
</div>
