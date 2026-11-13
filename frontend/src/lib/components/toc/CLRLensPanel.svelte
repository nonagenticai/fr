<!--
  CLRLensPanel.svelte — the CLR (Categories of Legitimate Reservation) reasoning
  lens for an asset or TOC tree. Renders the 8 CLR categories grouped, each with
  its pass/reservation state, plus the goal-tree-relevance bar. Decoupled from
  the API (mirrors the RelatedAssets shell): takes a `ClrQuality` report + an
  optional goal-tree-relevance number as props, so it mounts against mock data
  in tests.

  IMPORTANT (ground truth 2026-05-31): requirements_management's RequirementOut
  / DecisionOut carry NO per-asset `clr_assessment` / `goal_tree_relevance`
  fields, and `/toc` exposes no synchronous lens-read endpoint. The real
  synchronous CLR surface is the structural 8-CLR scorer at
  `POST /toc/{id}/quality` (→ `ClrQuality`) plus an asset's own `quality_*`
  fields. This panel renders THAT. The richer per-statement lens booleans are
  authored asynchronously by the n8n AA subroutine and are not fetched here.

  Props:
   - quality: ClrQuality | null — the 8-CLR report (categories + passes/issues).
   - goalTreeRelevance: number | null — 0..1 relevance to the goal tree.
   - loading / error — optional async states (panel owns no fetch).
-->
<script lang="ts">
  import type { ClrQuality } from '$lib/api/toc';
  import { CLR_CATEGORIES, clrCategoryLabel } from '$lib/api/toc';
  import { CLR_CATEGORY_CODES } from './palette';
  import CLRScoreBadge from './CLRScoreBadge.svelte';

  let {
    quality = null,
    goalTreeRelevance = null,
    loading = false,
    error = null,
    title = 'CLR Reasoning Lenses',
    showCategories = true,
    issues = null,
    suggestions = null,
    emptyText = 'No CLR evaluation yet. The structural 8-CLR scorer runs against a linked TOC reasoning tree.',
  }: {
    quality?: ClrQuality | null;
    goalTreeRelevance?: number | null;
    loading?: boolean;
    error?: string | null;
    title?: string;
    // The 8-category grid only has data for a scored TOC TREE. For an ASSET
    // (requirement / decision) we have an aggregate score + reservation/
    // suggestion text but no per-category breakdown, so the detail page passes
    // showCategories={false} and feeds `issues` / `suggestions` instead.
    showCategories?: boolean;
    issues?: string[] | null;
    suggestions?: string[] | null;
    emptyText?: string;
  } = $props();

  // Normalise the upstream `categories` map into a per-category status. The
  // scorer's category detail shape is open; we read a `pass`/`ok`/`passed`
  // boolean when present, else treat a listed issue for the category as a
  // reservation, else "unknown".
  type Status = 'pass' | 'reservation' | 'unknown';
  function categoryStatus(key: string): Status {
    const cat = quality?.categories?.[key];
    if (cat && typeof cat === 'object') {
      const o = cat as Record<string, unknown>;
      const passVal = o.pass ?? o.ok ?? o.passed;
      if (typeof passVal === 'boolean') return passVal ? 'pass' : 'reservation';
      if (Array.isArray(o.issues) && o.issues.length > 0) return 'reservation';
      if (typeof passVal === 'undefined' && Object.keys(o).length === 0)
        return 'unknown';
      return 'pass';
    }
    if (typeof cat === 'boolean') return cat ? 'pass' : 'reservation';
    return 'unknown';
  }

  const rows = $derived(
    CLR_CATEGORIES.map((key) => ({
      key,
      label: clrCategoryLabel(key),
      code: CLR_CATEGORY_CODES[key],
      status: categoryStatus(key),
    })),
  );

  const relevancePct = $derived(
    goalTreeRelevance == null ? null : Math.round(goalTreeRelevance * 100),
  );

  function statusTone(s: Status): string {
    if (s === 'pass') return 'var(--color-success)';
    if (s === 'reservation') return 'var(--color-danger)';
    return 'var(--color-text-muted)';
  }
  function statusGlyph(s: Status): string {
    if (s === 'pass') return '✓';
    if (s === 'reservation') return '!';
    return '·';
  }
</script>

<section
  class="bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] p-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
  data-testid="clr-lens-panel"
>
  <div class="flex items-center justify-between mb-3">
    <h3 class="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
    <CLRScoreBadge score={quality?.score ?? null} />
  </div>

  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)]">Evaluating reasoning lenses…</p>
  {:else if error}
    <p class="text-xs text-[var(--color-danger)]">Error: {error}</p>
  {:else if !quality}
    <p class="text-xs text-[var(--color-text-muted)]">{emptyText}</p>
  {:else}
    {#if relevancePct != null}
      <div class="mb-3" data-testid="clr-relevance">
        <div class="flex items-center justify-between text-xs text-[var(--color-text-muted)] mb-1">
          <span>Goal-tree relevance</span>
          <span class="font-medium text-[var(--color-text)]">{relevancePct}%</span>
        </div>
        <div class="h-1.5 w-full rounded-full bg-[var(--color-surface-strong)] overflow-hidden">
          <div
            class="h-full rounded-full"
            style={`width: ${relevancePct}%; background-color: var(--color-accent);`}
          ></div>
        </div>
      </div>
    {/if}

    {#if showCategories}
      <ul class="grid grid-cols-1 sm:grid-cols-2 gap-1.5" data-testid="clr-categories">
        {#each rows as row (row.key)}
          <li class="flex items-center gap-2 text-xs">
            <span
              class="inline-flex items-center justify-center w-5 h-5 rounded font-bold text-[10px] shrink-0"
              style={`color: ${statusTone(row.status)}; border: 1px solid ${statusTone(row.status)};`}
              title={row.status}
            >
              {statusGlyph(row.status)}
            </span>
            <span class="font-mono text-[10px] text-[var(--color-text-muted)] w-6 shrink-0">{row.code}</span>
            <span class="text-[var(--color-text)] truncate" title={row.label}>{row.label}</span>
          </li>
        {/each}
      </ul>

      {#if Array.isArray(quality.issues) && quality.issues.length > 0}
        <p class="mt-3 text-xs text-[var(--color-text-muted)]" data-testid="clr-issue-count">
          {quality.issues.length} open reservation{quality.issues.length === 1 ? '' : 's'}.
        </p>
      {/if}
    {/if}

    {#if issues && issues.length > 0}
      <div class="mt-3" data-testid="clr-reservations">
        <h4 class="text-xs font-semibold text-[var(--color-text)] mb-1">
          Reservations ({issues.length})
        </h4>
        <ul class="space-y-1">
          {#each issues as issue, i (i)}
            <li class="flex items-start gap-1.5 text-xs text-[var(--color-text-muted)]">
              <span class="text-[var(--color-danger)] shrink-0">!</span>
              <span>{issue}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if suggestions && suggestions.length > 0}
      <div class="mt-3" data-testid="clr-suggestions">
        <h4 class="text-xs font-semibold text-[var(--color-text)] mb-1">
          Suggestions ({suggestions.length})
        </h4>
        <ul class="space-y-1">
          {#each suggestions as suggestion, i (i)}
            <li class="flex items-start gap-1.5 text-xs text-[var(--color-text-muted)]">
              <span class="text-[var(--color-accent)] shrink-0">→</span>
              <span>{suggestion}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if !showCategories && (!issues || issues.length === 0) && (!suggestions || suggestions.length === 0)}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="clr-no-reservations">
        No open reservations — this asset passes the CLR scorer.
      </p>
    {/if}
  {/if}
</section>
