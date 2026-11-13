<!--
  /repositories/registry — manage registered repositories + their credentials
  (formerly the "Repositories" tab of /repositories; nav standard 2026-10-03
  made it a route + row).
-->
<script lang="ts">
  import RepositoriesTab from '../RepositoriesTab.svelte';
</script>

<div class="px-6 py-4 flex flex-col gap-4" data-testid="repositories-registry-page">
  <RepositoriesTab />
</div>
