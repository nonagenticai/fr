<!--
  DrilldownTable.svelte — per-(date, service) breakdown rendered beneath
  the sparkline grid on /tools/analytics.

  Spec: docs/archive/2026-04-27-foundation-design.md §9.3
        "Drill-down table — per-(date, service) row table beneath the
         sparkline; click a sparkline point to filter the table; sortable
         columns."

  Pure render component — sorting + filtering happens against the supplied
  rows via the `sortBy` / `dateFilter` runes; the page owns the data fetch
  and is responsible for handing in the union of breakdown buckets it wants
  visible. Logic-heavy bits (date formatting, sort comparator) are exported
  via `sortRows` so the co-located unit test doesn't need to mount Svelte.
-->
<script lang="ts" module>
  export interface DrilldownRow {
    date: string;        // ISO date e.g. '2026-04-29'
    service: string;     // metric_name slice e.g. 'kag.ingests.upload'
    requests: number;
    tokens: number;
    cost: number;
  }

  export type SortKey = 'date' | 'service' | 'requests' | 'tokens' | 'cost';
  export type SortDir = 'asc' | 'desc';

  /**
   * Pure comparator-driven sort. Date is sorted lexicographically (ISO
   * strings collate correctly); numerics by Number-cast.
   */
  export function sortRows(
    rows: ReadonlyArray<DrilldownRow>,
    key: SortKey,
    dir: SortDir,
  ): DrilldownRow[] {
    const m = dir === 'asc' ? 1 : -1;
    const out = [...rows];
    out.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * m;
      return String(av).localeCompare(String(bv)) * m;
    });
    return out;
  }

  export function filterByDate(
    rows: ReadonlyArray<DrilldownRow>,
    date: string | null,
  ): DrilldownRow[] {
    if (!date) return [...rows];
    return rows.filter((r) => r.date === date);
  }
</script>

<script lang="ts">
  interface Props {
    rows: ReadonlyArray<DrilldownRow>;
    /** When set, only rows matching this ISO date are shown. */
    dateFilter?: string | null;
    onClearFilter?: () => void;
  }

  const { rows, dateFilter = null, onClearFilter }: Props = $props();

  let sortKey = $state<SortKey>('date');
  let sortDir = $state<SortDir>('desc');

  const visible = $derived(sortRows(filterByDate(rows, dateFilter), sortKey, sortDir));

  function setSort(k: SortKey): void {
    if (sortKey === k) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = k;
      sortDir = k === 'date' || k === 'service' ? 'asc' : 'desc';
    }
  }

  function arrow(k: SortKey): string {
    if (sortKey !== k) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  function fmt(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return Math.round(n).toString();
  }
</script>

<div class="border border-[var(--color-border)] rounded mt-6 dark:border-[var(--color-border)]" data-testid="analytics-drilldown">
  <header class="flex items-center px-3 py-2 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
    <h2 class="text-sm font-semibold text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Drill-down</h2>
    {#if dateFilter}
      <span class="ml-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">filtered: {dateFilter}</span>
      <button
        type="button"
        class="ml-2 text-xs underline text-[var(--color-accent)] hover:text-[var(--color-accent-strong)]"
        onclick={onClearFilter}
        data-testid="analytics-drilldown-clear"
      >
        clear
      </button>
    {/if}
    <span class="ml-auto text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      {visible.length} {visible.length === 1 ? 'row' : 'rows'}
    </span>
  </header>

  {#if visible.length === 0}
    <p class="text-sm text-[var(--color-text-muted)] px-3 py-6 text-center dark:text-[var(--color-text-muted)]">
      No drill-down rows for the current selection.
    </p>
  {:else}
    <table class="w-full text-sm" data-testid="analytics-drilldown-table">
      <thead class="bg-[var(--color-surface)] dark:bg-[var(--color-surface)]">
        <tr>
          <th class="text-left px-3 py-2 cursor-pointer" onclick={() => setSort('date')}>
            Date{arrow('date')}
          </th>
          <th class="text-left px-3 py-2 cursor-pointer" onclick={() => setSort('service')}>
            Service{arrow('service')}
          </th>
          <th class="text-right px-3 py-2 cursor-pointer" onclick={() => setSort('requests')}>
            Requests{arrow('requests')}
          </th>
          <th class="text-right px-3 py-2 cursor-pointer" onclick={() => setSort('tokens')}>
            Tokens{arrow('tokens')}
          </th>
          <th class="text-right px-3 py-2 cursor-pointer" onclick={() => setSort('cost')}>
            Cost{arrow('cost')}
          </th>
        </tr>
      </thead>
      <tbody>
        {#each visible as row (row.date + '|' + row.service)}
          <tr class="border-t border-[var(--color-border)] dark:border-[var(--color-border-strong)]">
            <td class="px-3 py-1.5 font-mono text-xs">{row.date}</td>
            <td class="px-3 py-1.5">{row.service}</td>
            <td class="px-3 py-1.5 text-right tabular-nums">{fmt(row.requests)}</td>
            <td class="px-3 py-1.5 text-right tabular-nums">{fmt(row.tokens)}</td>
            <td class="px-3 py-1.5 text-right tabular-nums">{fmt(row.cost)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
