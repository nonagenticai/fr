<script lang="ts">
  // Fleet KPI band from the `fleet` block (FleetKpis). DERIVED
  // (confidence:'derived') — folded over the canonical tenants, n8n running
  // count and the approvals rollup. The KAG-backlog tile now
  // carries a real worst-case backlog age from kag_orchestrator /health/lag
  // (a backlog-age proxy, NOT a true p95); it falls back to a muted "—" gap
  // only when the orchestrator is unset/unreachable (kag_lag_available:false).
  import type { FleetKpis } from '$lib/types/control-tower';
  import { fmtNum, fmtDurationSecs } from './logic';

  interface Props {
    fleet: FleetKpis | null;
  }
  let { fleet }: Props = $props();

  const execLabel = $derived(
    fleet == null
      ? '—'
      : `${fleet.active_executions}${fleet.active_executions_capped ? '+' : ''}`,
  );

  // Available + reachable ⇒ show the backlog age (null age = idle ⇒ "0s"),
  // never a gap. Unavailable ⇒ muted "—" gap tile.
  const kagAvailable = $derived(fleet?.kag_lag_available === true);
  const kagLabel = $derived(kagAvailable ? fmtDurationSecs(fleet?.kag_lag_p95 ?? 0) : '—');

  // TRUE DONE→searchable completion-latency p95 (seconds). Available only when the
  // orchestrator is reachable AND had completed items in the window (sample_count>0);
  // otherwise a muted "—" gap — never a fabricated latency.
  const kagCompletionAvailable = $derived(fleet?.kag_completion_p95_available === true);
  const kagCompletionLabel = $derived(
    kagCompletionAvailable ? fmtDurationSecs(fleet?.kag_completion_p95_seconds ?? 0) : '—',
  );

  const tiles = $derived([
    { label: 'Tenants', value: fmtNum(fleet?.tenants), gap: false },
    { label: 'Active executions', value: execLabel, gap: false },
    { label: 'Gate waiting', value: fmtNum(fleet?.gate_waiting), gap: false },
    { label: 'Open approvals', value: fmtNum(fleet?.open_approvals), gap: false },
    { label: 'Overdue callbacks', value: fmtNum(fleet?.overdue_callbacks), gap: false },
    {
      label: 'KAG backlog age',
      value: kagLabel,
      gap: !kagAvailable,
      title: kagAvailable
        ? 'Worst-case oldest-pending age across KAG pipeline stages (backlog-age proxy — not a true DONE→searchable p95)'
        : 'Not reported — kag_orchestrator unreachable',
    },
    {
      label: 'KAG completion p95',
      value: kagCompletionLabel,
      gap: !kagCompletionAvailable,
      title: kagCompletionAvailable
        ? 'True DONE→searchable completion-latency p95 across KAG pipeline stages (kag_orchestrator /health/kag-latency)'
        : 'Not reported — kag_orchestrator unreachable or no completed items in the window',
    },
  ]);
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" data-testid="control-tower-kpi-band">
  {#each tiles as tile (tile.label)}
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <p class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {tile.label}
      </p>
      <p
        class="mt-1 text-xl font-bold {tile.gap
          ? 'text-[var(--color-text-muted)]'
          : 'text-[var(--color-text)]'}"
        title={tile.title ?? (tile.gap ? 'Not reported — data-gap (kag service)' : undefined)}
      >
        {tile.value}
      </p>
    </div>
  {/each}
</div>
