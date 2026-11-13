<!--
  ScopeFilter.svelte
  ===================
  Toolbar at the top of Library list views. Four mutually-exclusive chips:

      All inherited · Defined here only · Overrides only · Blocked

  Optional `counts` prop renders a count badge on each chip so users can
  see scope sizes before clicking. Counts are not loaded by ScopeFilter
  itself — caller computes them from the rows it already has.

  Spec: §6.4 (3) — "Library filter bar — Show: All inherited · Defined here
                    only · Overrides only · Blocked".
-->
<script lang="ts">
  type FilterKind = 'all_inherited' | 'defined_here' | 'overrides' | 'blocked';

  type Counts = Partial<Record<FilterKind, number>>;

  let {
    selected = 'all_inherited',
    counts,
    onChange,
  }: {
    selected?: FilterKind;
    counts?: Counts;
    onChange: (v: FilterKind) => void;
  } = $props();

  const OPTIONS: { value: FilterKind; label: string }[] = [
    { value: 'all_inherited', label: 'All' },
    { value: 'defined_here', label: 'Defined' },
    { value: 'overrides', label: 'Overrides' },
    { value: 'blocked', label: 'Blocked' },
  ];
</script>

<div
  data-testid="scope-filter"
  role="group"
  aria-label="Library scope filter"
  class="inline-flex items-center gap-1 rounded-[var(--radius-md)] bg-[var(--color-surface)] p-1"
>
  {#each OPTIONS as opt (opt.value)}
    {@const isActive = selected === opt.value}
    {@const count = counts?.[opt.value]}
    <button
      type="button"
      data-testid={`scope-filter-${opt.value}`}
      aria-pressed={isActive}
      onclick={() => onChange(opt.value)}
      class={`h-8 px-3 text-sm font-medium rounded-[var(--radius-sm)] transition inline-flex items-center gap-1.5 whitespace-nowrap ${
        isActive
          ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]'
          : 'bg-transparent text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]'
      }`}
    >
      <span>{opt.label}</span>
      {#if typeof count === 'number'}
        <span
          data-testid={`scope-filter-count-${opt.value}`}
          class={`inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 text-xs font-semibold rounded-full ${
            isActive
              ? 'bg-[var(--color-on-primary)]/20 text-[var(--color-on-primary)]'
              : 'bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]'
          }`}
        >
          {count}
        </span>
      {/if}
    </button>
  {/each}
</div>
