<!--
  RelatedAssets.svelte

  Generic compact panel that fetches `manifest.api.list(filter)` and renders
  each item as a link to `/<manifest.name>/<id>`. Used for cross-linking from
  bespoke detail surfaces (project page, kanban card modal) into the
  manifest-driven asset routes.

  Plan: docs/superpowers/plans/...woolly-harp Wave 6 Task 6.10 (Steps 3 + 4).

  Note: backend filter pass-through for these manifests currently strips
  unknown query params (see backend/src/integrations/{decisions,requirements,
  principles,procedures}.ts — all use `.strip()`). The `filter` prop is wired
  end-to-end so this panel will correctly narrow as soon as the upstream
  services accept project_id / card_id; for now, supplying a filter still
  renders the global list.
-->
<script lang="ts" generics="T">
  import { assetItemHref, resolveRowTitle, type AssetManifest } from './manifest';

  let {
    manifest,
    filter,
    label,
  }: {
    manifest: AssetManifest<T>;
    filter?: Record<string, string>;
    label?: string;
  } = $props();

  let items = $state<T[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    // Re-run whenever the filter object identity changes.
    const f = filter ?? {};
    loading = true;
    error = null;
    manifest.api
      .list(f)
      .then((r) => {
        items = r.items;
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        loading = false;
      });
  });

  const idField = $derived(manifest.idField ?? ('id' as keyof T & string));

  function rowHref(row: T): string {
    const id = (row as Record<string, unknown>)[idField];
    return assetItemHref(manifest, String(id));
  }

  // The link TEXT, through the manifest's declared fallback chain
  // (`titleField` → `titleFallbackField` → id). This read `row[titleField]`
  // raw, so a manifest whose human label is nullable — KAG entities are the
  // declared case — rendered an `<a>` with no text: present, focusable,
  // navigable and invisible. A link a mouse cannot find is not a link.
  function rowTitle(row: T): string {
    // `|| '—'` is the last resort this surface has — there is no route param
    // here, and `resolveRowTitle` has already tried the id — so the anchor is
    // never empty even for a row carrying no identity at all.
    return resolveRowTitle(row, manifest) || '—';
  }

  function rowKey(row: T): string {
    return String((row as Record<string, unknown>)[idField] ?? '');
  }
</script>

<section class="bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] p-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">
  <h3 class="text-sm font-semibold text-[var(--color-text)] mb-2 dark:text-[var(--color-text)]">
    {label ?? `Linked ${manifest.plural}`}
  </h3>
  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <p class="text-xs text-[var(--color-danger)]">Error: {error}</p>
  {:else if items.length === 0}
    <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      No linked {manifest.plural.toLowerCase()}.
    </p>
  {:else}
    <ul class="space-y-1 text-sm">
      {#each items as row (rowKey(row))}
        <li>
          <a
            class="text-[var(--color-accent)] hover:underline"
            href={rowHref(row)}
            data-testid="related-asset-link"
          >
            {rowTitle(row)}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>
