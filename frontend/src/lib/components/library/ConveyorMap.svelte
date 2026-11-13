<!--
  ConveyorMap — the /library/conveyor catalogue map (fr#1478, design D8 view A).

  Columns = the tenant's RM phases in API order (a gate marker where `gate` is
  true). Rows = the tenant's RM capabilities (grouped by level when RM ever
  supplies one). Each cell lists a chip per card type with that (capability,
  phase). Card types no project type composes (`phase: null`) go to the tray.

  Everything is derived from the `taxonomy` prop (GET /api/conveyor/taxonomy);
  this component declares no phase, capability or card-type list of its own.
  A type whose phase or capability is not a known column/row also lands in the
  tray, so no type is silently dropped — and it is visibly MARKED there ("unknown
  phase" / "unknown capability" badge, `data-unplaced-reason`, aria-label), so it
  is never mistaken for one of the roster's open types.

  Chips carry the CardTypeBadge colour dot (the capability's token colour). Clicking
  one opens the existing CardTypeProtocol view for it below the grid.
-->
<script lang="ts">
  import CardTypeBadge from '$lib/components/kanban/CardTypeBadge.svelte';
  import CardTypeProtocol from '$lib/cards/CardTypeProtocol.svelte';
  import type { ConveyorTaxonomy, TaxonomyCardType } from '$lib/api/conveyor-taxonomy';

  interface Props {
    taxonomy: ConveyorTaxonomy;
  }
  let { taxonomy }: Props = $props();

  let selected = $state<string | null>(null);

  const LEVEL_ORDER = ['strategic', 'tactical', 'operational'];
  const LEVEL_LABEL: Record<string, string> = {
    strategic: 'Strategic',
    tactical: 'Tactical',
    operational: 'Operational',
  };

  const phaseIds = $derived(new Set(taxonomy.phases.map((p) => p.id)));
  const capNames = $derived(new Set(taxonomy.capabilities.map((c) => c.name)));

  /** Capabilities grouped by level, levels in canonical order then any others. */
  const levelGroups = $derived.by(() => {
    const levels = [
      ...LEVEL_ORDER,
      ...[...new Set(taxonomy.capabilities.map((c) => c.level ?? 'unlevelled'))].filter(
        (l) => !LEVEL_ORDER.includes(l),
      ),
    ];
    return levels
      .map((level) => ({
        level,
        label: LEVEL_LABEL[level] ?? level,
        capabilities: taxonomy.capabilities.filter((c) => (c.level ?? 'unlevelled') === level),
      }))
      .filter((g) => g.capabilities.length > 0);
  });

  function isPlaced(ct: TaxonomyCardType): boolean {
    return (
      ct.phase !== null &&
      phaseIds.has(ct.phase) &&
      ct.capability !== null &&
      capNames.has(ct.capability)
    );
  }

  /** `${capability}\u0000${phase}` → card types, roster order. */
  const cells = $derived.by(() => {
    const m = new Map<string, TaxonomyCardType[]>();
    for (const ct of taxonomy.card_types) {
      if (!isPlaced(ct)) continue;
      const k = `${ct.capability}\u0000${ct.phase}`;
      const list = m.get(k) ?? [];
      list.push(ct);
      m.set(k, list);
    }
    return m;
  });

  /** Why a type is not in the grid. `open` = the roster deliberately gives it
   * no phase; the other two mean the taxonomy is inconsistent with itself. */
  type UnplacedReason = 'open' | 'unknown_phase' | 'unknown_capability';
  function unplacedReason(ct: TaxonomyCardType): UnplacedReason {
    if (ct.capability === null || !capNames.has(ct.capability)) return 'unknown_capability';
    if (ct.phase === null) return 'open';
    return 'unknown_phase';
  }
  const UNPLACED_LABEL: Record<Exclude<UnplacedReason, 'open'>, string> = {
    unknown_phase: 'unknown phase',
    unknown_capability: 'unknown capability',
  };

  const tray = $derived(taxonomy.card_types.filter((ct) => !isPlaced(ct)));
  const openCount = $derived(tray.filter((ct) => unplacedReason(ct) === 'open').length);
  const unknownCount = $derived(tray.length - openCount);

  const selectedType = $derived(
    selected ? (taxonomy.card_types.find((c) => c.id === selected) ?? null) : null,
  );

  const pretty = (id: string) => id.replace(/_/g, ' ');

  function select(id: string): void {
    selected = selected === id ? null : id;
  }
</script>

{#snippet chip(ct: TaxonomyCardType, placed: boolean)}
  {@const reason = placed ? null : unplacedReason(ct)}
  {@const unknown = reason !== null && reason !== 'open' ? UNPLACED_LABEL[reason] : null}
  <button
    type="button"
    class="inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-left text-[11px] leading-tight transition
      border-[var(--color-border)] bg-[var(--color-surface)]
      {selected === ct.id ? 'outline outline-2 outline-[var(--color-accent)]' : ''}
      hover:bg-[var(--color-surface-muted)]"
    data-testid="conveyor-chip"
    data-card-type={ct.id}
    data-placed={placed ? 'true' : 'false'}
    data-unplaced-reason={reason ?? undefined}
    aria-pressed={selected === ct.id}
    aria-label={unknown ? `${pretty(ct.id)} (${unknown}: ${unknown === 'unknown phase' ? ct.phase : ct.capability ?? 'none'})` : undefined}
    title={`${ct.id}${ct.group ? ` · ${ct.group}` : ''}${unknown ? ` · ${unknown}` : ''}`}
    onclick={() => select(ct.id)}
  >
    <CardTypeBadge cardType={ct.id} cardGroup={ct.group} />
    <span class="break-words">{pretty(ct.id)}</span>
    {#if unknown}
      <span
        class="rounded bg-[var(--color-warning-bg)] px-1 text-[10px] font-medium text-[var(--color-warning-text)]"
        data-testid="conveyor-unknown-marker"
      >{unknown}</span>
    {/if}
  </button>
{/snippet}

<section class="flex flex-col gap-3" data-testid="conveyor-map">
  <!-- Only the grid scrolls sideways on narrow screens; the page does not. -->
  <div class="overflow-x-auto rounded border border-[var(--color-border)]" data-testid="conveyor-grid-scroll">
    <table class="min-w-[1100px] border-collapse text-xs">
      <thead>
        <tr>
          <th scope="col" class="sticky left-0 z-10 w-40 bg-[var(--color-surface)] px-2 py-2 text-left font-semibold">
            Capability
          </th>
          {#each taxonomy.phases as p (p.id)}
            <th
              scope="col"
              class="min-w-[84px] border-l border-[var(--color-border)] px-1.5 py-2 text-left align-bottom font-semibold
                {p.off_spine ? 'bg-[var(--color-surface-muted)]' : ''}"
              data-testid="conveyor-map-column"
              data-phase={p.id}
              data-gate={p.gate ? 'true' : 'false'}
            >
              <span class="block">{p.label}</span>
              {#if p.gate}
                <span
                  class="mt-0.5 inline-block rounded bg-[var(--color-warning-bg)] px-1 text-[10px] font-medium text-[var(--color-warning-text)]"
                  title="Human approval gate"
                  data-testid="conveyor-gate-marker"
                >gate</span>
              {/if}
              {#if p.off_spine}
                <span class="mt-0.5 block text-[10px] font-normal text-[var(--color-text-muted)]">off-spine</span>
              {/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each levelGroups as g (g.level)}
          <tr>
            <th
              scope="rowgroup"
              colspan={taxonomy.phases.length + 1}
              class="border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-1 text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]"
              data-testid="conveyor-level"
              data-level={g.level}
            >{g.label}</th>
          </tr>
          {#each g.capabilities as cap (cap.name)}
            <tr data-testid="conveyor-map-row" data-capability={cap.name}>
              <th
                scope="row"
                class="sticky left-0 z-10 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-left align-top font-medium"
                title={cap.name}
              >{cap.title}</th>
              {#each taxonomy.phases as p (p.id)}
                <td
                  class="border-l border-t border-[var(--color-border)] px-1 py-1 align-top
                    {p.off_spine ? 'bg-[var(--color-surface-muted)]' : ''}"
                  data-testid="conveyor-cell"
                >
                  <div class="flex flex-col gap-1">
                    {#each cells.get(`${cap.name}\u0000${p.id}`) ?? [] as ct (ct.id)}
                      {@render chip(ct, true)}
                    {/each}
                  </div>
                </td>
              {/each}
            </tr>
          {/each}
        {/each}
      </tbody>
    </table>
  </div>

  <div class="rounded border border-dashed border-[var(--color-border)] p-3" data-testid="conveyor-tray">
    <h3 class="mb-1 text-xs font-semibold">Not placed ({tray.length})</h3>
    <p class="mb-2 text-[11px] text-[var(--color-text-muted)]" data-testid="conveyor-tray-caption">
      {openCount} type{openCount === 1 ? '' : 's'} no project type composes in any phase.{#if unknownCount > 0}
        {' '}{unknownCount} marked type{unknownCount === 1 ? ' names' : 's name'} a phase or capability
        this map has no column or row for.{/if}
    </p>
    <div class="flex flex-wrap gap-1">
      {#each tray as ct (ct.id)}
        {@render chip(ct, false)}
      {/each}
    </div>
  </div>

  {#if selectedType}
    <div class="rounded border border-[var(--color-border)] p-3" data-testid="conveyor-selected">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <CardTypeBadge cardType={selectedType.id} cardGroup={selectedType.group} />
        <h3 class="font-mono text-sm font-semibold">{selectedType.id}</h3>
        <span class="text-xs text-[var(--color-text-muted)]">
          {selectedType.capability ?? 'no capability'} · {selectedType.phase ?? 'not placed'}{selectedType.group
            ? ` · ${selectedType.group}`
            : ''}
        </span>
        <button
          type="button"
          class="ml-auto text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          aria-label="Close card-type details"
          onclick={() => (selected = null)}
        >×</button>
      </div>
      {#key selectedType.id}
        <CardTypeProtocol card_type={selectedType.id} />
      {/key}
    </div>
  {/if}
</section>
