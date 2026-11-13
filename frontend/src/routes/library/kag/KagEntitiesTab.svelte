<!--
  KAG "Entities" tab — a read-only directory of the tenant's knowledge-graph
  entities. Until now these entities were only reachable by hunting the graph
  canvas; this surfaces the already-proxied (but previously unconsumed)
  `GET /api/assets/kag/entities` read as a plain, searchable list.

  Three jobs, all on proven read endpoints:
    List    entities load on open (bounded), each rendered as a card
            (name · type · id + a short metadata line, all resolved defensively).
    Filter  a node-type facet (from `kagGraphApi.nodeTypes`) filters SERVER-side
            (maps to the proxy's `label` param); a free-text box filters the
            loaded set CLIENT-side (name/type/id) because the proxy strips text
            search. Both are honest about what they do.
    Inspect clicking a card opens the EXISTING `KagNodeDetailPanel` — the same
            right-pane drawer the Explore-graph tab uses — so provenance,
            similar concepts, and metadata all work unchanged.

  READ-ONLY: no writes, no mutations. The panel's graph-only actions (expand /
  set-path) are inert here (no canvas to grow) — "Find similar" still navigates
  within the panel via onselectNode.

  follow-up: a "similar entities" affordance over `/api/assets/kag/batch-similarity`
  was scoped out to keep this PR small; the per-entity "Find similar" already
  lives inside KagNodeDetailPanel.
-->
<script lang="ts">
  import { kagGraphApi, type KagRecord } from '$lib/api/kag';
  import { describeCount, type ListCount } from '$lib/api/list-count';
  import { AssetError } from '$lib/api/assets';
  import { nodeIdOf, nodeLabelOf, nodeTypeOf } from '$lib/components/kag/graph-normalise';
  import KagNodeDetailPanel from '$lib/components/kag/KagNodeDetailPanel.svelte';
  import { assetItemHref } from '$lib/asset-workspace/manifest';
  import { kagManifest } from '$lib/manifests/kag';

  /**
   * The entity's own page, /kag/entities/<id> — or null when the record carries
   * no real id. `nodeIdOf` falls back to the NAME and then to `idx-<n>` so the
   * list can key its rows; neither is something /kag/entities/[id] can fetch,
   * so neither may become a link. Same id keys as nodeIdOf, minus the fallbacks.
   * (Validator N3, 2026-10-03: the detail route had no entry point at all, and
   * the manifest's default row link built /kag/<id>, which is no route.)
   */
  function entityHref(r: KagRecord): string | null {
    const props = r.properties && typeof r.properties === 'object' ? (r.properties as KagRecord) : null;
    for (const [bag, keys] of [
      [r, ['id', 'entity_id', 'node_id', 'element_id', 'uuid']],
      [props, ['id', 'entity_id', 'uuid']],
    ] as const) {
      if (!bag) continue;
      for (const k of keys) {
        const v = bag[k];
        if ((typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v))) {
          return assetItemHref(kagManifest, String(v));
        }
      }
    }
    return null;
  }

  // Cap the rendered set so an unbounded graph can't flood the DOM (the proxy
  // ignores a server-side limit; see kagGraphApi.entities).
  const MAX_ENTITIES = 300;

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  // First non-empty string/number among the given keys — for the metadata line.
  function pick(r: KagRecord, keys: string[]): string {
    const bag =
      r.properties && typeof r.properties === 'object' ? (r.properties as KagRecord) : r;
    for (const k of keys) {
      const v = bag[k] ?? r[k];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return '';
  }
  const META_KEYS = ['description', 'summary', 'definition', 'category', 'source', 'created_at'];
  const metaLine = (r: KagRecord) => pick(r, META_KEYS);

  // --- Node-type facet --------------------------------------------------------
  interface NodeType {
    name: string;
    count?: number;
  }
  // Upstream returns either a bare list of label strings or a list of
  // `{ label|type|name, count }` objects (or an envelope around either).
  function normaliseTypes(raw: unknown): NodeType[] {
    let list: unknown[] = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === 'object') {
      const obj = raw as KagRecord;
      for (const k of ['types', 'node_types', 'labels', 'items', 'data']) {
        if (Array.isArray(obj[k])) {
          list = obj[k] as unknown[];
          break;
        }
      }
    }
    const out: NodeType[] = [];
    for (const it of list) {
      if (typeof it === 'string') {
        if (it.length > 0) out.push({ name: it });
      } else if (it && typeof it === 'object') {
        const o = it as KagRecord;
        const name = [o.label, o.type, o.name, o.node_type].find(
          (v) => typeof v === 'string' && v.length > 0,
        ) as string | undefined;
        if (name) {
          const count = typeof o.count === 'number' ? o.count : undefined;
          out.push({ name, count });
        }
      }
    }
    return out;
  }

  let types = $state<NodeType[]>([]);
  let typesError = $state('');

  async function loadTypes(): Promise<void> {
    typesError = '';
    try {
      types = normaliseTypes(await kagGraphApi.nodeTypes());
    } catch (e) {
      typesError = errMsg(e);
      types = [];
    }
  }

  // --- Entities ---------------------------------------------------------------
  let entities = $state<KagRecord[]>([]);
  // What the source says about the FULL set. ⚠️ `unknown` is a real answer and
  // must stay distinguishable from `exact 0` — the header renders "total
  // unknown" for it, never a number. See $lib/api/list-count.
  let count = $state<ListCount>({ kind: 'unknown' });
  let clientCapped = $state(false);
  let loading = $state(false);
  let error = $state('');
  let loaded = $state(false);

  let selectedType = $state(''); // '' = all types (server-side label filter)
  let query = $state(''); // free-text (client-side filter)

  async function loadEntities(): Promise<void> {
    loading = true;
    error = '';
    try {
      const page = await kagGraphApi.entities({
        node_type: selectedType || undefined,
        limit: MAX_ENTITIES,
      });
      entities = page.items;
      count = page.count;
      clientCapped = page.clientCapped;
      loaded = true;
    } catch (e) {
      error = errMsg(e);
    } finally {
      loading = false;
    }
  }

  // Client-side free-text filter over the loaded set (name / type / id).
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entities;
    return entities.filter((e) => {
      return (
        nodeLabelOf(e).toLowerCase().includes(q) ||
        nodeTypeOf(e).toLowerCase().includes(q) ||
        nodeIdOf(e).toLowerCase().includes(q)
      );
    });
  });

  // --- Detail panel (reuses the Explore-graph drawer) -------------------------
  let selectedNode = $state<KagRecord | null>(null);
  function selectNode(record: KagRecord | null) {
    selectedNode = record;
  }

  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    void loadTypes();
    void loadEntities();
  });
</script>

<div class="flex flex-col gap-4" data-testid="kag-entities-tab">
  <!-- Intro -->
  <div>
    <h2 class="text-lg font-semibold text-[var(--color-text)]">Browse your entities</h2>
    <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
      Every concept extracted from your documents lives here as an entity. Search
      by name, narrow by type, and select any entity to see its metadata — and
      the exact source passages it came from. Read-only.
    </p>
  </div>

  <!-- Toolbar: search + type facet -->
  <div
    class="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
  >
    <input
      type="search"
      bind:value={query}
      placeholder="Search entities by name, type or id…"
      data-testid="kag-entities-search"
      class="min-w-[14rem] flex-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm dark:bg-[var(--color-surface)]"
    />

    <label
      class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
      for="kag-entities-type">Type</label
    >
    <select
      id="kag-entities-type"
      bind:value={selectedType}
      onchange={() => void loadEntities()}
      disabled={loading}
      data-testid="kag-entities-type"
      class="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
    >
      <option value="">All types</option>
      {#each types as t (t.name)}
        <option value={t.name}>{t.name}{t.count !== undefined ? ` (${t.count})` : ''}</option>
      {/each}
    </select>

    <button
      type="button"
      data-testid="kag-entities-refresh"
      disabled={loading}
      onclick={() => void loadEntities()}
      class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
      >{loading ? 'Loading…' : 'Refresh'}</button
    >
  </div>

  {#if typesError}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-entities-types-error">
      Couldn't load types ({typesError}) — showing all entities.
    </p>
  {/if}

  <!-- List + detail -->
  <div class="flex flex-col gap-4 lg:flex-row">
    <div class="min-w-0 flex-1">
      {#if error}
        <div
          class="rounded border border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger-text)]"
          data-testid="kag-entities-error"
        >
          {error}
        </div>
      {:else if loading && !loaded}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="kag-entities-loading">
          Loading entities…
        </p>
      {:else if loaded}
        {#if entities.length === 0}
          <div
            class="flex flex-col items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center dark:bg-[var(--color-bg)]"
            data-testid="kag-entities-empty"
          >
            <p class="text-sm font-medium text-[var(--color-text)]">No entities yet</p>
            <p class="mt-1 max-w-sm text-sm text-[var(--color-text-muted)]">
              {#if selectedType}
                No entities of type “{selectedType}”. Try another type or clear the filter.
              {:else}
                Add documents in <a href="/library/kag/documents" class="font-medium text-[var(--color-accent)] hover:underline">KAG documents</a> — your entities are built from what you ingest.
              {/if}
            </p>
          </div>
        {:else}
          <!--
            ⛔ This used to read `{filtered.length} of {entities.length}` with a
            parenthetical whenever `entities.length >= MAX_ENTITIES` — two
            separate untruths. `entities.length` is the size of the PAGE we were
            handed, not of the set, so "40 of 300" described nothing upstream;
            and the cap note fired on a set that was EXACTLY 300, claiming a
            truncation that had not happened.

            Now: the first number is what is on screen after the local text
            filter, the second is what the SOURCE actually claims about the whole
            set — and when the source claims nothing, this says "total unknown"
            rather than substituting the page size for it.
          -->
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <span class="text-xs text-[var(--color-text-muted)]" data-testid="kag-entities-count">
              {describeCount(count, filtered.length, filtered.length === 1 ? 'entity' : 'entities')}
            </span>
            {#if clientCapped}
              <span
                class="rounded bg-[var(--color-warning-bg)] px-1.5 py-0.5 text-[11px] text-[var(--color-warning-text)]"
                data-testid="kag-entities-capped"
                title={`This view renders at most ${MAX_ENTITIES} entities so an unbounded graph cannot flood the page. Rows beyond that were received and dropped here — narrow by type to see them.`}
              >
                capped at {MAX_ENTITIES} — more were returned than are shown
              </span>
            {/if}
          </div>
          {#if filtered.length === 0}
            <p
              class="text-sm text-[var(--color-text-muted)]"
              data-testid="kag-entities-no-match"
            >
              No entities match “{query}”.
            </p>
          {:else}
            <ul
              class="grid grid-cols-1 gap-2 sm:grid-cols-2"
              data-testid="kag-entities-list"
            >
              {#each filtered as e, i (nodeIdOf(e, i))}
                {@const active = selectedNode !== null && nodeIdOf(selectedNode) === nodeIdOf(e, i)}
                {@const href = entityHref(e)}
                <li>
                  <button
                    type="button"
                    onclick={() => selectNode(e)}
                    data-testid="kag-entity-card"
                    class="flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-[var(--color-surface-strong)] {active
                      ? 'border-[var(--color-accent)] bg-[var(--color-surface-strong)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)]'}"
                  >
                    <div class="flex items-start justify-between gap-2">
                      <span class="min-w-0 break-words text-sm font-semibold text-[var(--color-text)]"
                        >{nodeLabelOf(e)}</span
                      >
                      <span
                        class="shrink-0 rounded-full bg-[var(--color-accent-bg,var(--color-surface-strong))] px-2 py-0.5 text-[10px] font-medium text-[var(--color-accent)]"
                        >{nodeTypeOf(e)}</span
                      >
                    </div>
                    {#if metaLine(e)}
                      <span class="line-clamp-2 text-xs text-[var(--color-text-muted)]">{metaLine(e)}</span>
                    {/if}
                    <span
                      class="truncate font-mono text-[10px] text-[var(--color-text-muted)]"
                      title={nodeIdOf(e, i)}>{nodeIdOf(e, i)}</span
                    >
                  </button>
                  {#if href}
                    <a
                      {href}
                      class="mt-1 inline-block text-xs text-[var(--color-accent)] hover:underline"
                      data-testid="kag-entity-link"
                    >
                      Open entity page →
                    </a>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      {/if}
    </div>

    {#if selectedNode}
      <div class="w-full shrink-0 lg:w-96">
        <div class="lg:sticky lg:top-4 lg:h-[600px]">
          <KagNodeDetailPanel
            node={selectedNode}
            onselectNode={(n) => selectNode(n)}
            onclose={() => (selectedNode = null)}
          />
        </div>
      </div>
    {/if}
  </div>
</div>
