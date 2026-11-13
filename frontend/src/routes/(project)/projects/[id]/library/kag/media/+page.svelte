<!-- /projects/[id]/library/kag/media — the tenant /library/kag/media page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagMediaTab from '../../../../../../library/kag/KagMediaTab.svelte';
</script>

<KagPage title="KAG media" testid="project-kag-media-page">
  <KagMediaTab />
</KagPage>
