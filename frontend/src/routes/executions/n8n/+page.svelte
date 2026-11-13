<!--
  /executions/n8n — the n8n executions table (formerly /tools/n8n, then the
  "n8n" tab of /executions; nav standard 2026-10-03 made it a route + row).
-->
<script lang="ts">
  import N8nExecutionsTab from '../N8nExecutionsTab.svelte';
</script>

<div class="flex flex-col gap-6 h-full" data-testid="executions-n8n-page">
  <header class="flex flex-col gap-1">
    <h1 class="text-2xl font-semibold text-[var(--color-text)]">n8n executions</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Workflow runs scoped to your account, across the n8n engine.
    </p>
  </header>
  <N8nExecutionsTab />
</div>
