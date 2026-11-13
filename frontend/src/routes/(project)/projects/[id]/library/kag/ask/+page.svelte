<!-- /projects/[id]/library/kag/ask — the tenant /library/kag/ask page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagAskSearchTab from '../../../../../../library/kag/KagAskSearchTab.svelte';
</script>

<KagPage title="KAG ask &amp; search" testid="project-kag-ask-page">
  <KagAskSearchTab />
</KagPage>
