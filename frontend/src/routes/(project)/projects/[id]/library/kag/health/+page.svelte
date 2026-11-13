<!-- /projects/[id]/library/kag/health — the tenant /library/kag/health page inside the project shell. KAG calls are project-scoped automatically while a project is open ($lib/api/kagProjectScope). -->
<script lang="ts">
  import KagPage from '../../../../../../library/kag/KagPage.svelte';
  import KagVerificationHealthTab from '../../../../../../library/kag/KagVerificationHealthTab.svelte';
</script>

<KagPage title="KAG verification health" testid="project-kag-health-page">
  <KagVerificationHealthTab />
</KagPage>
