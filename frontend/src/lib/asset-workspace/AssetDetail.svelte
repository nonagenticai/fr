<!--
  AssetDetail.svelte

  Read-only sectioned view of a single asset with optional Edit / Delete
  actions and a Related panel. Driven by the `manifest.detail.sections` and
  `manifest.related[]` declarations.

  Plan: docs/superpowers/plans/...woolly-harp Wave 6 Task 6.1 Step 3.
-->
<script lang="ts" generics="T">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import {
    resolveRowTitle,
    rowFieldText,
    type AssetManifest,
    type FieldDef,
    assetItemHref,
    assetListHref,
  } from './manifest';
  import { relationDirectoryFor } from './relationDirectory';
  import AssetScopePanel from './AssetScopePanel.svelte';
  import AssetQualityPanel from './AssetQualityPanel.svelte';
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { SYSTEM_ASSET_READ_ONLY_NOTICE, isSystemReadOnly } from './systemAsset';
  import { buildImprovePrompt } from './improvePrompt';

  let {
    manifest,
    id,
  }: { manifest: AssetManifest<T>; id: string } = $props();

  let item = $state<T | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let deleteError = $state('');
  let deleting = $state(false);

  type RelatedBlock = {
    label: string;
    manifest: string;
    items: unknown[];
    error: string;
    loading: boolean;
    /**
     * The `X-Project-Resolved` reading for this block's fetch — `false` only
     * when the route filtered on a project that does not exist. `null` is
     * "nobody said", which must render as today's behaviour, not as a new
     * claim. See `AssetManifest.related[].fetch`.
     */
    projectResolved: boolean | null;
  };
  let related = $state<RelatedBlock[]>([]);

  /**
   * `"<relationTo>\0<id>"` → human label, for `type: 'relation'` detail fields.
   *
   * ## Why this is not a formatter
   *
   * `FieldDef.formatter` is `(v) => string`: SYNCHRONOUS, one value, no row and
   * no await. A human label for a foreign key is behind a fetch, so no
   * formatter can ever produce one — which is why `relation` detail fields
   * printed the uuid the picker had just spared the user from typing.
   *
   * Resolution happens HERE, in the same async load the detail page already
   * has, and reads the SAME `relationDirectory` registry the picker writes
   * through, so the names offered and the names printed cannot diverge.
   *
   * ⚠️ Pure enrichment. An unregistered directory, an unreadable one, and an id
   * the directory does not contain each leave the field showing its raw id —
   * the pre-existing behaviour — and none of them may fail the page.
   */
  let relationLabels = $state<Map<string, string>>(new Map());

  function relationCacheKey(relationTo: string, id: string): string {
    return `${relationTo}\u0000${id}`;
  }

  /** The `relation` detail fields that name a directory. */
  function relationFields(): FieldDef<T>[] {
    const out: FieldDef<T>[] = [];
    for (const section of manifest.detail.sections) {
      for (const field of section.fields) {
        if (field.type === 'relation' && field.relationTo) out.push(field);
      }
    }
    return out;
  }

  async function resolveRelationLabels(): Promise<void> {
    const fields = relationFields();
    if (!fields.length || !item) {
      relationLabels = new Map();
      return;
    }
    const row = item as Record<string, unknown>;
    // Only the directories a NON-EMPTY field on this row actually needs, and
    // each of them once: two fields pointing at `projects` are one read.
    const needed = new Set<string>();
    for (const field of fields) {
      if (rowFieldText(row, field.key as string)) {
        needed.add(field.relationTo as string);
      }
    }
    if (!needed.size) {
      relationLabels = new Map();
      return;
    }
    const next = new Map<string, string>();
    await Promise.all(
      [...needed].map(async (relationTo) => {
        const loader = relationDirectoryFor(relationTo);
        // Unregistered is not an error — the field keeps its id, exactly as
        // documented on `FieldDef.relationTo`.
        if (!loader) return;
        try {
          const { options, unreadable } = await loader();
          // ⚠️ A failed read must not be mistaken for "this id has no label":
          // both leave the field on its id, but only silence is honest here.
          // Never cache anything from an unreadable directory.
          if (unreadable) return;
          for (const opt of options) {
            const id = String(opt?.id ?? '').trim();
            const label = String(opt?.label ?? '').trim();
            if (id && label) next.set(relationCacheKey(relationTo, id), label);
          }
        } catch {
          // Total, like `pm/dependencies.activityTitles`: a detail page that
          // cannot name its foreign keys is still a correct detail page, and
          // enrichment may never take the page down with it.
        }
      }),
    );
    relationLabels = next;
  }

  /** Did this relation field find a label, or is it showing its id? */
  function relationResolved(field: FieldDef<T>, value: unknown): boolean {
    if (field.type !== 'relation' || !field.relationTo) return false;
    const id = value == null ? '' : String(value).trim();
    if (!id) return false;
    return relationLabels.has(relationCacheKey(field.relationTo, id));
  }

  // The entity's own last-modified timestamp, used only for the quality stale
  // badge. Read through the manifest-declared field so no column name is
  // assumed; a manifest that omits it gets no badge rather than a wrong one.
  const qualityModifiedAt = $derived.by(() => {
    const field = manifest.quality?.modifiedField;
    if (!field || !item) return null;
    const value = (item as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : null;
  });

  onMount(async () => {
    await load();
  });

  async function load() {
    loading = true;
    loadError = '';
    try {
      item = await manifest.api.get(id);
      // Both are enrichment over the loaded item and neither throws, so they
      // run together and BEFORE `loading` clears — resolving after first paint
      // would flash the uuid the resolution exists to remove.
      //
      // ⚠️ That last sentence used to be prose only: the suite's `settle()`
      // loop cannot tell resolve-before-paint from resolve-after-paint, so
      // splitting this into `await loadRelated(); void resolveRelationLabels()`
      // stayed green.
      await Promise.all([loadRelated(), resolveRelationLabels()]);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      item = null;
    } finally {
      loading = false;
    }
  }

  async function loadRelated() {
    if (!item || !manifest.related?.length) {
      related = [];
      return;
    }
    const row = item;
    related = manifest.related.map((r) => ({
      label: r.label,
      manifest: r.manifest,
      items: [],
      error: '',
      loading: true,
      projectResolved: null,
    }));
    await Promise.all(
      manifest.related.map(async (r, idx) => {
        try {
          const res = await r.fetch(row);
          related[idx] = {
            ...related[idx],
            items: res.items,
            // ⚠️ `?? null`, never `?? true`. A `fetch` that omits the field has
            // asserted NOTHING about resolution, and promoting silence to
            // "resolved" is a claim no route made.
            projectResolved: res.projectResolved ?? null,
            loading: false,
          };
        } catch (e) {
          related[idx] = {
            ...related[idx],
            error: e instanceof Error ? e.message : String(e),
            loading: false,
          };
        }
      }),
    );
  }

  function renderField(field: FieldDef<T>, value: unknown): string {
    if (field.formatter) return field.formatter(value);
    if (value == null || value === '') return '—';
    // A relation renders its DIRECTORY LABEL, degrading to the raw id. The
    // `|| id` is the whole safety property: an unresolved id still renders, so
    // this can never blank a field that used to show something.
    if (field.type === 'relation' && field.relationTo) {
      const rawId = String(value).trim();
      return (
        relationLabels.get(relationCacheKey(field.relationTo, rawId)) ||
        rawId ||
        '—'
      );
    }
    if (Array.isArray(value)) return value.map(String).join(', ');
    if (field.type === 'boolean') return value ? 'Yes' : 'No';
    if (field.type === 'json') {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }
    if (field.type === 'select' && field.options) {
      const opt = field.options.find((o) => o.value === String(value));
      if (opt) return opt.label;
    }
    return String(value);
  }

  /**
   * A related row's label — the LAST untrimmed rung in this file.
   *
   * ⛔ THE DEFECT. This was `obj.name ?? obj.title ?? obj.label ?? obj.id`, and
   * `??` only skips `null`/`undefined`: a row whose `title` is `'   '` won the
   * chain and rendered a BLANK `<li>` in the Related panel — a row that exists,
   * presented as nothing, with the id it could have shown sitting one rung down.
   *
   * That is reachable, not theoretical: `title` is `minLength: 1` upstream
   * (tooling/openapi/specs/requirements.json), *"which permits `'   '`"*. The same
   * reasoning already produced `rowFieldText`, whose whole job is that each rung
   * is tested for non-empty AFTER trimming — and `resolveRowTitle` is built from
   * it. This function simply did not use either.
   *
   * ⚠️ WHY NOT `resolveRowTitle` ITSELF. It needs the row's OWN manifest
   * (`list.titleField`, `list.titleFallbackField`, `idField`), and this call site
   * does not have one: `AssetManifest.related[]` declares `manifest` as a
   * `string` NAME, not a manifest object, and the only manifest in scope here is
   * the CURRENT asset's — a different kind entirely. Passing that one would
   * resolve a decision row against a requirement's title field, which is worse
   * than the blank. So the shared trimming PRIMITIVE is what is reused, and the
   * rungs stay the generic `name → title → label → id` this panel needs for rows
   * it has no manifest for. Give `related[]` a manifest reference and this
   * collapses into `resolveRowTitle`.
   */
  function relatedItemTitle(it: unknown): string {
    if (it == null) return '';
    // `JSON.stringify` last on every path, not `''`: a row that reached the panel
    // exists, and rendering it as empty is the one outcome worse than rendering
    // it ugly. A whitespace-only string survives as `"   "` — visibly quoted.
    if (typeof it === 'string' || typeof it === 'number') {
      return String(it).trim() || JSON.stringify(it);
    }
    if (typeof it === 'object') {
      const obj = it as Record<string, unknown>;
      return (
        rowFieldText(obj, 'name') ||
        rowFieldText(obj, 'title') ||
        rowFieldText(obj, 'label') ||
        rowFieldText(obj, 'id') ||
        JSON.stringify(obj)
      );
    }
    return String(it).trim() || JSON.stringify(it);
  }

  // --- Structured (json) content rendering -------------------------------
  // A `json` field whose value is an array of objects (e.g. a procedure's
  // `steps`) or a plain object (e.g. `context_requirements`, trace `links`)
  // renders as readable key/value blocks instead of a raw JSON blob, so the
  // detail page shows the *actual content* of the artifact, not a summary.

  function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function isObjectArray(v: unknown): v is Record<string, unknown>[] {
    return Array.isArray(v) && v.length > 0 && v.every(isPlainObject);
  }

  function scalarize(v: unknown): string {
    if (v == null || v === '') return '—';
    if (Array.isArray(v)) {
      return v
        .map((x) => (isPlainObject(x) ? JSON.stringify(x) : String(x)))
        .join(', ');
    }
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v);
  }

  function prettyKey(k: string): string {
    return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function entryList(obj: Record<string, unknown>): [string, string][] {
    return Object.entries(obj).map(([k, v]) => [prettyKey(k), scalarize(v)]);
  }

  // Order an object-array by `step_number` when present (procedure steps),
  // otherwise keep the API order.
  function orderItems(arr: Record<string, unknown>[]): Record<string, unknown>[] {
    if (arr.some((x) => 'step_number' in x)) {
      return [...arr].sort(
        (a, b) => Number(a.step_number ?? 0) - Number(b.step_number ?? 0),
      );
    }
    return arr;
  }

  function itemHeading(it: Record<string, unknown>, idx: number): string {
    const n = it.step_number ?? idx + 1;
    const name = it.name ?? it.title ?? it.label ?? '';
    return name ? `${n}. ${String(name)}` : `${n}`;
  }

  // A system-tenant asset is read-only for everyone but a super-admin (the
  // backend answers 403 `system_asset_read_only`); hide Edit / Delete instead
  // of offering a button the server will refuse. See ./systemAsset.ts.
  const systemReadOnly = $derived(isSystemReadOnly(item, auth.isSuperAdmin));

  function editHref(): string {
    return `${assetItemHref(manifest, id)}/edit`;
  }

  async function onDelete() {
    if (!manifest.api.remove || !item) return;
    if (manifest.destructiveActionsRequireConfirm) {
      const label = String((item as Record<string, unknown>)[manifest.list.titleField] ?? id);
      if (!confirm(`Delete ${manifest.singular.toLowerCase()} "${label}"?`)) return;
    }
    deleting = true;
    deleteError = '';
    try {
      await manifest.api.remove(id);
      await goto(assetListHref(manifest));
    } catch (e) {
      deleteError = e instanceof Error ? e.message : String(e);
    } finally {
      deleting = false;
    }
  }

  // The page heading, resolved through a FALLBACK CHAIN rather than one field.
  //
  // A manifest whose human label is nullable (KAG entities: `label` is
  // `string | null`) used to dodge the blank heading by declaring the uuid as
  // `titleField` — which put a uuid in the heading of every row to protect the
  // few rows with no label. The chain gets both: the label where one exists,
  // and an identifier (never a blank <h1>) where none does.
  //
  // `?? ''` was not enough on its own: an id field present-but-empty-string is
  // as blank as a missing one, so each rung is tested for non-empty AFTER
  // stringifying, not for null.
  //
  // The chain itself now lives in `manifest.ts` as `resolveRowTitle`, shared
  // with AssetList and RelatedAssets — it was implemented here and nowhere
  // else, so a manifest's declared fallback reached the heading while the LINK
  // to that heading stayed blank. The route's `id` param is the one rung only
  // this surface has, so it stays here.
  const titleValue = $derived.by(() => {
    if (item == null) return '';
    return resolveRowTitle(item, manifest) || id;
  });

  // True when the heading is showing a fallback rather than the manifest's
  // declared human label — the detail markup marks it so the blank-heading
  // regression is observable, not merely absent.
  const titleIsFallback = $derived(
    item != null &&
      rowFieldText(item as Record<string, unknown>, manifest.list.titleField) ===
        '',
  );

  // --- Agent-assisted authoring -----------------------------------------
  // "Ask agent to improve this" — the assisted counterpart to the manual
  // Edit form. Reuses the same thread + rail seam as AssetEmptyState's
  // "Ask the agent" (the only place this affordance lived before), but feeds
  // the agent the asset's CURRENT content as context so it can propose a
  // concrete revision the user reviews (and saves via Edit, or — once the
  // change_*_development loop is wired end-to-end — persists upstream).
  let asking = $state(false);

  // Compact, bounded dump of the detail fields → context for the agent.
  function currentContent(): string {
    if (!item) return '';
    const row = item as Record<string, unknown>;
    const lines: string[] = [];
    for (const section of manifest.detail.sections) {
      for (const field of section.fields) {
        const v = renderField(field, row[field.key as string]);
        if (v && v !== '—') lines.push(`${field.label}: ${v}`);
      }
    }
    return lines.join('\n').slice(0, 1800);
  }

  async function askAgentImprove(): Promise<void> {
    if (asking || !item) return;
    // fr-agui §13 P1c (OQ-17 = c): outside a project there is no agent to ask —
    // open the side pane, which says "Open a project to use the agent" and offers
    // the project picker. Nothing is created or sent to the (doorway-only) agent.
    if (!agentRail.projectId) {
      agentRail.openAgentTab();
      return;
    }
    asking = true;
    try {
      const t = await threads.create({
        channel: 'web',
        projectId: agentRail.projectId,
      });
      agentRail.openThread(t.id);
      const singular = manifest.singular.toLowerCase();
      await threads.sendMessage(
        buildImprovePrompt({
          singular,
          collection: manifest.name,
          id,
          title: titleValue,
          content: currentContent(),
        }),
      );
    } finally {
      asking = false;
    }
  }
</script>

<div class="px-6 py-4 max-w-3xl" data-testid="asset-detail" data-manifest={manifest.name}>
  {#if loading}
    <p class="text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]">Loading {manifest.singular.toLowerCase()}…</p>
  {:else if loadError || !item}
    <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm">
      {loadError || `${manifest.singular} not found`}
    </div>
    <a href="{assetListHref(manifest)}{$page.url.search}" class="text-sm text-[var(--color-text)] hover:underline mt-4 inline-block dark:text-[var(--color-text-muted)]">
      ← Back to {manifest.plural.toLowerCase()}
    </a>
  {:else}
    <div class="flex items-center justify-between mb-4">
      <div>
        <h1
          class="text-2xl font-semibold font-mono"
          data-testid="asset-detail-title"
          data-title-fallback={titleIsFallback}
        >{titleValue}</h1>
        {#if manifest.list.subtitleField}
          <p
            class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
            data-testid="asset-detail-subtitle"
          >
            {String(
              (item as Record<string, unknown>)[manifest.list.subtitleField] ??
                '',
            )}
          </p>
        {/if}
      </div>
      <div class="flex items-center gap-3">
        <a href="{assetListHref(manifest)}{$page.url.search}" class="text-sm text-[var(--color-text)] hover:underline dark:text-[var(--color-text-muted)]">← Back</a>
        <button
          type="button"
          onclick={askAgentImprove}
          disabled={asking}
          class="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          data-testid="asset-detail-ask-agent"
          title="Open the agent to draft an improvement to this {manifest.singular.toLowerCase()}"
        >
          {asking ? 'Opening…' : '✨ Improve with agent'}
        </button>
        {#if manifest.api.update && !systemReadOnly}
          <a
            href={editHref()}
            class="px-3 py-1.5 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] text-sm"
            data-testid="asset-detail-edit"
          >
            Edit
          </a>
        {/if}
        {#if manifest.api.remove && !systemReadOnly}
          <button
            type="button"
            onclick={onDelete}
            disabled={deleting}
            class="px-3 py-1.5 text-sm text-[var(--color-danger)] hover:underline disabled:opacity-50"
            data-testid="asset-detail-delete"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        {/if}
      </div>
    </div>

    {#if systemReadOnly}
      <p
        class="text-sm text-[var(--color-text-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 mb-3"
        data-testid="asset-system-readonly-notice"
      >
        {SYSTEM_ASSET_READ_ONLY_NOTICE}
      </p>
    {/if}

    {#if deleteError}
      <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-3">
        {deleteError}
      </div>
    {/if}

    {#each manifest.detail.sections as section (section.title)}
      <section class="mt-6">
        <h2 class="text-lg font-semibold mb-2">{section.title}</h2>
        <dl class="border border-[var(--color-border)] rounded divide-y divide-[var(--color-border)] dark:border-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
          {#each section.fields as field (field.key)}
            {@const value = (item as Record<string, unknown>)[field.key as string]}
            <div class="px-4 py-2 grid grid-cols-3 gap-4">
              <dt class="text-xs font-semibold uppercase text-[var(--color-text)] col-span-1 dark:text-[var(--color-text-muted)]">
                {field.label}
              </dt>
              <dd class="col-span-2 text-sm">
                {#if field.type === 'json' && isObjectArray(value)}
                  <ol class="space-y-2" data-testid="detail-object-array-{field.key}">
                    {#each orderItems(value) as it, i (i)}
                      <li class="rounded border border-[var(--color-border)] p-2 dark:border-[var(--color-border)]">
                        <p class="font-medium mb-1">{itemHeading(it, i)}</p>
                        <dl class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
                          {#each entryList(it) as [k, v] (k)}
                            <div class="grid grid-cols-3 gap-2 py-0.5">
                              <dt class="text-xs uppercase text-[var(--color-text-muted)]">{k}</dt>
                              <dd class="col-span-2 whitespace-pre-wrap">{v}</dd>
                            </div>
                          {/each}
                        </dl>
                      </li>
                    {/each}
                  </ol>
                {:else if field.type === 'json' && isPlainObject(value) && Object.keys(value).length > 0}
                  <dl class="rounded border border-[var(--color-border)] divide-y divide-[var(--color-border)] dark:border-[var(--color-border)] dark:divide-[var(--color-border-strong)]" data-testid="detail-object-{field.key}">
                    {#each entryList(value) as [k, v] (k)}
                      <div class="grid grid-cols-3 gap-2 px-2 py-1">
                        <dt class="text-xs uppercase text-[var(--color-text-muted)]">{k}</dt>
                        <dd class="col-span-2 whitespace-pre-wrap">{v}</dd>
                      </div>
                    {/each}
                  </dl>
                {:else if field.type === 'relation' && field.relationTo}
                  {@const relRawId = value == null ? '' : String(value).trim()}
                  {@const relResolved = relationResolved(field, value)}
                  <!--
                    `data-relation-resolved` was already here, but a data
                    attribute is invisible to a human — production showed a
                    bare unresolved uuid with nothing on screen to say so. The
                    id itself must stay on screen (an operator debugging a
                    broken link needs it to paste into an API), so the fix is
                    an ADDITIONAL, visible badge next to it rather than
                    replacing or hiding the id.
                    Reuses this file's OWN existing "could not be resolved"
                    warning styling (the related-project banner a few lines
                    below, `text-[var(--color-warning-text,var(--color-danger))]`)
                    and the "unresolved" wording `RelationPicker.svelte` /
                    `ApproverPicker.svelte` already use for this exact
                    id-present-no-name state, rather than inventing a new
                    visual language for the same fact.
                  -->
                  <span class="inline-flex items-baseline gap-1.5">
                    <span
                      class="whitespace-pre-wrap"
                      data-testid="detail-relation-{field.key}"
                      data-relation-resolved={relResolved}
                    >{renderField(field, value)}</span>
                    {#if relRawId && !relResolved}
                      <span
                        class="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-warning-text,var(--color-danger))]"
                        data-testid="detail-relation-unresolved-{field.key}"
                        title="This id did not resolve to a {field.relationTo} name — it may be deleted, or the directory could not be read."
                      >Unresolved</span>
                    {/if}
                  </span>
                {:else}
                  <span class="whitespace-pre-wrap">{renderField(field, value)}</span>
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}

    {#if manifest.quality}
      <AssetQualityPanel
        kind={manifest.quality.kind}
        label={manifest.quality.label}
        {id}
        {item}
        modifiedAt={qualityModifiedAt}
        persistenceNote={manifest.quality.persistenceNote ?? ''}
      />
    {/if}

    {#if manifest.scope}
      <AssetScopePanel
        assetKind={manifest.scope.assetKind}
        assetId={id}
        bindable={manifest.scope.bindable}
        promotable={manifest.scope.promotable}
        overridable={manifest.scope.overridable}
      />
    {/if}

    {#if related.length > 0}
      <section class="mt-8">
        <h2 class="text-lg font-semibold mb-2">Related</h2>
        <div class="space-y-3">
          {#each related as block (block.manifest)}
            <div class="border border-[var(--color-border)] rounded dark:border-[var(--color-border)]">
              <div class="px-4 py-2 bg-[var(--color-surface)] text-xs font-semibold uppercase text-[var(--color-text)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
                {block.label}
              </div>
              <!--
                ⚠️ The unresolved-project banner is a SIBLING of the state
                chain, not a branch inside the empty one. `principles` and
                `procedures` return ROWS against a project that does not exist
                (they fall back to the workspace set and say so in the header),
                so a banner nested under `items.length === 0` would miss the
                case users hit most — and hiding the rows behind the banner
                would be a second wrong answer. The banner explains the rows; it
                does not replace them.
              -->
              {#if !block.loading && !block.error && block.projectResolved === false}
                <p
                  class="px-4 py-2 text-sm text-[var(--color-warning-text,var(--color-danger))]"
                  data-testid="related-unresolved-{block.manifest}"
                >
                  This {manifest.singular.toLowerCase()}'s project could not be
                  resolved, so this panel is not scoped to it.
                </p>
              {/if}
              {#if block.loading}
                <p class="px-4 py-2 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Loading…</p>
              {:else if block.error}
                <p class="px-4 py-2 text-sm text-[var(--color-danger)] dark:text-[var(--color-danger-text)]">{block.error}</p>
              {:else if block.items.length === 0 && block.projectResolved !== false}
                <!--
                  Guarded on `projectResolved !== false` so this and the banner
                  above CANNOT co-render. "None." is a claim about the project's
                  contents, and an unresolved project has no contents to report
                  — saying both would assert the thing the banner denies.
                -->
                <p
                  class="px-4 py-2 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
                  data-testid="related-empty-{block.manifest}"
                >None.</p>
              {:else if block.items.length > 0}
                <!--
                  The testid is on the LIST, not on each row: rows are keyed by
                  index, so a per-row testid would be either duplicated or a lie
                  about identity. A test reads `li` inside it, which is what makes
                  a blank row observable at all.
                -->
                <ul
                  class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]"
                  data-testid="related-items-{block.manifest}"
                >
                  {#each block.items as it, idx (idx)}
                    <li class="px-4 py-2 text-sm">{relatedItemTitle(it)}</li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}
  {/if}
</div>
