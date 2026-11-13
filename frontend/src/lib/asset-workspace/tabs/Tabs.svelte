<!--
  Tabs — presentational tab bar + panel slot. Stateless: the parent owns the
  active id and the panel content. Token styling is copied verbatim from the
  projects-page tabs (the one bespoke tabbed surface this primitive replaces)
  so it stays pixel-identical and uses design tokens.

  Two layouts, chosen by whether `groups` is passed:
    - absent  → a single flat row (the default; every non-grouped consumer);
    - present → tabs folded into labelled clusters (grouped by `TabDef.group`),
                each section a caption + its own row of buttons. The per-tab
                <button> markup is identical in both, so ids / data-testids /
                deep-links are unaffected.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { TabDef, TabGroup } from './types';

  interface Props {
    tabs: readonly TabDef[];
    /** Currently-active tab id (owned by the parent). */
    active: string;
    /** Called with the chosen tab id when a tab is clicked. */
    onSelect: (id: string) => void;
    /**
     * Optional section grouping. When provided (and non-empty), the bar renders
     * labelled clusters instead of a flat row. Purely a layout concern.
     */
    groups?: readonly TabGroup[];
    /** Panel area rendered beneath the bar. */
    children?: Snippet;
  }

  const { tabs, active, onSelect, groups, children }: Props = $props();

  function isBadgeVisible(badge: TabDef['badge']): boolean {
    return badge !== undefined && badge !== '' && badge !== 0;
  }

  interface Section {
    id: string;
    label: string;
    items: readonly TabDef[];
  }

  // Fold tabs into labelled sections (navConfig idiom): sections in the order
  // given by `groups`, each collecting its member tabs; empty sections dropped.
  // Any tab whose `group` matches no section is appended as a trailing,
  // unlabelled cluster so nothing silently disappears. Returns null when no
  // grouping was requested → the flat row renders.
  const sections = $derived.by<Section[] | null>(() => {
    if (!groups || groups.length === 0) return null;
    const known = new Set(groups.map((g) => g.id));
    const built: Section[] = groups
      .map((g) => ({ id: g.id, label: g.label, items: tabs.filter((t) => t.group === g.id) }))
      .filter((s) => s.items.length > 0);
    const orphans = tabs.filter((t) => t.group === undefined || !known.has(t.group));
    if (orphans.length > 0) built.push({ id: '', label: '', items: orphans });
    return built;
  });
</script>

{#snippet tabButton(tab: TabDef)}
  <button
    type="button"
    role="tab"
    id="asset-tab-{tab.id}"
    aria-selected={active === tab.id}
    aria-controls="asset-panel-{tab.id}"
    data-testid="asset-tab-{tab.id}"
    onclick={() => onSelect(tab.id)}
    class="pb-3 px-1 border-b-2 font-medium transition-colors {active === tab.id
      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
      : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:text-[var(--color-text-muted)] dark:hover:border-[var(--color-border-strong)]'} dark:text-[var(--color-text-muted)] dark:hover:text-[var(--color-text-muted)]"
  >
    {tab.label}
    {#if isBadgeVisible(tab.badge)}
      <span
        class="ml-1.5 rounded-full bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)]"
        data-testid="asset-tab-badge-{tab.id}"
      >
        {tab.badge}
      </span>
    {/if}
  </button>
{/snippet}

<div class="flex flex-col gap-6">
  <div class="border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
    {#if sections}
      <div class="flex flex-wrap items-end gap-x-8 gap-y-3" role="tablist">
        {#each sections as section (section.id)}
          <div class="flex flex-col gap-1" data-testid="asset-tab-section-{section.id}">
            {#if section.label}
              <span
                aria-hidden="true"
                class="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
              >
                {section.label}
              </span>
            {/if}
            <div class="flex gap-6">
              {#each section.items as tab (tab.id)}
                {@render tabButton(tab)}
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="flex gap-6" role="tablist">
        {#each tabs as tab (tab.id)}
          {@render tabButton(tab)}
        {/each}
      </div>
    {/if}
  </div>
  {@render children?.()}
</div>
