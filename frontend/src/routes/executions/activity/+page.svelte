<!--
  /executions/activity — the global execution/activity feed (formerly
  /tools/activity, then the "Activity" tab of /executions; nav standard
  2026-10-03 made it a route + row).
-->
<script lang="ts">
  import ActivityTab from '../ActivityTab.svelte';
</script>

<div class="flex flex-col gap-6 h-full" data-testid="executions-activity-page">
  <header class="flex flex-col gap-1">
    <h1 class="text-2xl font-semibold text-[var(--color-text)]">Execution activity</h1>
  </header>
  <ActivityTab />
</div>
