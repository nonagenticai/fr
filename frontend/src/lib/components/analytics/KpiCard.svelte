<!--
  KpiCard.svelte — single KPI tile with title, big number, and a sparkline
  of the last-N buckets within the active window.

  Spec: docs/superpowers/specs/completed/2026-04-24-analytics-page.md §9.2
        ("KPI grid — one card per hard metric in §10").
-->
<script lang="ts">
  import Sparkline from './Sparkline.svelte';

  interface Props {
    title: string;
    value: number;
    sparkline: number[];
  }

  const { title, value, sparkline }: Props = $props();

  function fmt(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return Math.round(n).toString();
  }
</script>

<div class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 shadow-sm flex flex-col gap-1 dark:border-[var(--color-border)] dark:bg-[var(--color-surface)]" data-testid="analytics-kpi-card">
  <div class="text-xs text-[var(--color-text-muted)] truncate dark:text-[var(--color-text-muted)]" title={title}>{title}</div>
  <div class="text-2xl font-semibold tabular-nums text-[var(--color-text)] dark:text-[var(--color-text)]">{fmt(value)}</div>
  <div class="mt-1">
    <Sparkline values={sparkline} />
  </div>
</div>
