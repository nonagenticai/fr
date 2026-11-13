<!-- /projects/[id]/library/kag/capabilities — the tenant /library/kag/capabilities page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagCapabilitiesTab from '../../../../../../library/kag/KagCapabilitiesTab.svelte';
</script>

<KagPage title="KAG formats &amp; models" testid="project-kag-capabilities-page">
  <KagCapabilitiesTab />
</KagPage>
