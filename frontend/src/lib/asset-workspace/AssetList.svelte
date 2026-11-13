<!--
  AssetList.svelte

  Generic searchable + sortable list driven by an AssetManifest. Wave B
  added three concerns on top of the original generic list:

    1. `is_system` badge — every row from a system-union listFn (backend
       /api/assets/* under a non-system tenant) carries `is_system: bool`.
       The badge renders next to the title when true. No prop or manifest
       knob is needed; the field is purely additive on the response.
    2. Tag-filter sidebar — opt-in via `manifest.list.tagsField`. Builds
       the facet set from observed tag values on the loaded items; supports
       OR-within / AND-across selection (single facet here, so it's just
       OR). Mirrors the contract in $lib/workflows/facets.ts at a smaller
       scope (one facet, no URL roundtrip yet — list pages are still
       client-state for v1).

  Plan: ~/.claude/plans/plan-is-at-floating-patterson.md Wave B #1–#3.
-->
<script lang="ts" generics="T">
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import {
    resolveRowTitle,
    rowFieldText,
    type AssetManifest,
    type ColumnDef,
    assetItemHref,
    assetRouteBase,
  } from './manifest';
  import AssetScopeBadge from '$lib/components/library/AssetScopeBadge.svelte';
  import { bindAsset } from '$lib/api/bindings';
  import * as tenancy from '$lib/api/tenancy';
  import { authFetch } from '$lib/api/auth-fetch';
  import { readFailureReason, scopeRefState } from './scopeRefs';
  import {
    setSearchParams,
    parseCsvSet,
    csvSetToParam,
    parseStringParam,
    parseEnumParam,
  } from '$lib/nav/urlState';
  import { groupDuplicates, titleKey } from '$lib/utils/groupDuplicates';

  let {
    manifest,
    query,
  }: { manifest: AssetManifest<T>; query?: Record<string, string> } = $props();

  let items = $state<T[]>([]);
  // The route tells us when the page it served was capped. Before this, a
  // capped page was indistinguishable from a complete one: /decisions rendered
  // exactly 100 rows against a tenant holding 9,845 and said nothing.
  let truncated = $state(false);
  let appliedLimit = $state<number | null>(null);
  let showingAll = $state(false);
  let loading = $state(true);
  let loadError = $state('');

  // Scope features (assign-to-project / promote) — opt-in via manifest.scope.
  // Drives the leading checkbox + Scope columns and the bulk-action bar that
  // replace the old /library/[type] tenancy lens.
  interface ProjectRow {
    id: string;
    name: string;
  }
  let selected = $state<Set<string>>(new Set());
  let projects = $state<ProjectRow[]>([]);
  let departments = $state<tenancy.Department[]>([]);
  /**
   * The scope-reference reads FAILED, per input.
   *
   * ⚠️ `projects = []` / `departments = []` in a silent catch made a failed read
   * indistinguishable from an empty tenant — and because the bulk bar gates its
   * controls on `projects.length > 0` / `departments.length > 0`, the whole
   * "Assign to project" and "Promote to department" affordance simply VANISHED.
   * The user is not told the read failed; they are shown a UI in which the
   * capability does not exist, which reads as "this tenant has no projects".
   *
   * These are ENRICHMENT for a list that still renders from its own endpoint, so
   * the fix is the per-input flag this repo already uses (`kaizen_available`,
   * `AssetCreateScopePicker`'s `projectsUnreadable`) — name the input that was
   * lost, never blank the section.
   *
   * ⚠️ They carry the REASON, not a boolean. The flag alone renders "Retry." at
   * a user whose token just expired, which is advice that cannot work; the
   * reason is the only thing that separates that from a 502, where it will.
   * Same shape as `ActivityTray`'s `snapshotUnreadable`. null ⇒ the read
   * succeeded.
   */
  let projectsUnreadable = $state<string | null>(null);
  let departmentsUnreadable = $state<string | null>(null);
  // Three states, not two: `ready` (pick a target), `empty` (the tenant has
  // none — the only claim a SUCCESSFUL read earned) and `unreadable`.
  const projectsState = $derived(scopeRefState(projects.length, projectsUnreadable));
  const departmentsState = $derived(
    scopeRefState(departments.length, departmentsUnreadable),
  );
  let bulkProjectId = $state('');
  let bulkDeptId = $state('');
  let bulkPending = $state(false);
  let bulkError = $state<string | null>(null);
  let bulkMsg = $state<string | null>(null);

  // URL-as-truth: search / tag-filter / sort live in the querystring (params
  // q / tags / sort / dir) so the filtered view is shareable, reload-safe, and
  // restored on browser-back. Writers below funnel through setSearchParams
  // (one goto per change). Generalizes the /workflows facets pattern; see
  // $lib/nav/urlState. (`selected` stays local — bulk selection is ephemeral.)
  const columnKeys = $derived(
    manifest.list.columns.map((c) => c.key) as (keyof T & string)[],
  );
  const search = $derived(parseStringParam($page.url.searchParams, 'q'));
  const selectedTags = $derived(parseCsvSet($page.url.searchParams, 'tags'));
  const sortKey = $derived.by<(keyof T & string) | null>(() => {
    const raw = $page.url.searchParams.get('sort');
    if (raw && (columnKeys as string[]).includes(raw)) {
      return raw as keyof T & string;
    }
    return manifest.list.defaultSort?.key ?? null;
  });
  const sortDir = $derived(
    parseEnumParam(
      $page.url.searchParams,
      'dir',
      ['asc', 'desc'] as const,
      manifest.list.defaultSort?.dir ?? 'asc',
    ),
  );
  // Reset the ephemeral bulk-action selection if the manifest swaps under the
  // same component instance (tag/sort state is URL-scoped, so it resets for
  // free on the route change).
  $effect(() => {
    void manifest.name;
    selected = new Set();
  });

  const searchable = $derived<(keyof T & string)[]>(
    manifest.list.searchableFields ??
      ([manifest.list.titleField] as (keyof T & string)[]),
  );

  const tagsField = $derived<(keyof T & string) | undefined>(
    manifest.list.tagsField,
  );

  function readTags(row: T): string[] {
    if (!tagsField) return [];
    const raw = (row as Record<string, unknown>)[tagsField];
    return Array.isArray(raw) ? raw.map((t) => String(t)) : [];
  }

  // Collect the universe of tag values across the loaded set. Built once
  // per `items` change; counts are derived so the sidebar can show "(3)"
  // beside each tag.
  const tagCounts = $derived.by<Map<string, number>>(() => {
    const m = new Map<string, number>();
    if (!tagsField) return m;
    for (const row of items) {
      for (const t of readTags(row)) {
        m.set(t, (m.get(t) ?? 0) + 1);
      }
    }
    return m;
  });

  const sortedTags = $derived(
    [...tagCounts.entries()].sort((a, b) => {
      // Highest-count first, then alpha.
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    }),
  );

  function matchesTagFilter(row: T): boolean {
    if (selectedTags.size === 0) return true;
    const rowTags = readTags(row);
    for (const t of selectedTags) {
      if (rowTags.includes(t)) return true; // OR within the facet
    }
    return false;
  }

  function toggleTag(tag: string) {
    const next = new Set(selectedTags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    void setSearchParams($page.url, { tags: csvSetToParam(next) });
  }

  // ---- Status facet (opt-in, manifest.list.statusFilterField) ----
  // UI review 2026-10-07. Values offered are exactly those present in the
  // loaded rows, so the select can never offer a status that matches nothing.
  const statusField = $derived<(keyof T & string) | undefined>(
    manifest.list.statusFilterField,
  );
  const statusFilter = $derived(parseStringParam($page.url.searchParams, 'status'));
  const statusValues = $derived.by<string[]>(() => {
    if (!statusField) return [];
    const vals = new Set<string>();
    for (const row of items) {
      const v = (row as Record<string, unknown>)[statusField];
      if (v != null && String(v) !== '') vals.add(String(v));
    }
    return [...vals].sort((a, b) => a.localeCompare(b));
  });

  // ---- Server-side include switch (opt-in, manifest.list.includeToggle) ----
  // URL-as-truth like the facets above, but it changes what the SERVER returns,
  // so a change re-queries instead of narrowing the loaded rows.
  const includeToggle = $derived(manifest.list.includeToggle);
  const includeOn = $derived(
    includeToggle ? $page.url.searchParams.get(includeToggle.param) === 'true' : false,
  );
  // Plain (non-reactive) memory of the value the last load used, so the first
  // run of the effect below — onMount already loads — does not load twice.
  let loadedIncludeOn: boolean | undefined;
  $effect(() => {
    const on = includeOn;
    if (loadedIncludeOn === undefined || on === loadedIncludeOn) return;
    // untrack: loadItems reads other state (showingAll, query); only the
    // switch itself may re-trigger this load.
    untrack(() => void loadItems());
  });

  function matchesStatusFilter(row: T): boolean {
    if (!statusField || !statusFilter) return true;
    return String((row as Record<string, unknown>)[statusField] ?? '') === statusFilter;
  }

  const filtered = $derived.by<T[]>(() => {
    const q = search.trim().toLowerCase();
    let rows = items.filter(matchesTagFilter).filter(matchesStatusFilter);
    if (q) {
      rows = rows.filter((row) =>
        searchable.some((k) => {
          const v = row[k];
          return v != null && String(v).toLowerCase().includes(q);
        }),
      );
    }
    if (sortKey) {
      const key = sortKey;
      const dir = sortDir === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av == null && bv == null) return 0;
        if (av == null) return -1 * dir;
        if (bv == null) return 1 * dir;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return rows;
  });

  async function loadItems(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      // `showingAll` raises the cap to the upstream ceiling. Deliberately a
      // bigger page rather than offset paging: this list is a union of TWO
      // tenant frames that is then filtered locally, so a shared offset would
      // not map onto either frame's rows.
      let q = showingAll ? { ...(query ?? {}), limit: '1000' } : query;
      loadedIncludeOn = includeOn;
      if (includeToggle && includeOn) q = { ...(q ?? {}), [includeToggle.param]: 'true' };
      const res = await manifest.api.list(q);
      items = res.items;
      truncated = res.truncated ?? false;
      appliedLimit = res.appliedLimit ?? null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      items = [];
      truncated = false;
      appliedLimit = null;
    } finally {
      loading = false;
    }
  }

  async function loadAllRows(): Promise<void> {
    showingAll = true;
    await loadItems();
  }

  async function loadScopeRefs(): Promise<void> {
    projectsUnreadable = null;
    departmentsUnreadable = null;
    try {
      const res = await authFetch('/api/projects');
      if (res.ok) {
        const body = (await res.json()) as { items?: ProjectRow[] } | ProjectRow[];
        projects = Array.isArray(body) ? body : (body.items ?? []);
      } else {
        // A non-ok answer never reached the catch, so it left the previous
        // (or empty) list standing as if it had been read. Two paths, one
        // wrong claim — the same pair AssetCreateScopePicker records.
        projects = [];
        projectsUnreadable = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      }
    } catch (err) {
      projects = [];
      projectsUnreadable = readFailureReason(err, 'project list read failed');
    }
    try {
      departments = await tenancy.listDepartments();
    } catch (err) {
      departments = [];
      departmentsUnreadable = readFailureReason(err, 'department list read failed');
    }
  }

  onMount(async () => {
    await loadItems();
    if (manifest.scope) void loadScopeRefs();
  });

  function toggleSort(key: keyof T & string) {
    // Clicking the active column flips direction; a new column starts asc.
    const nextDir: 'asc' | 'desc' =
      sortKey === key ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
    void setSearchParams($page.url, { sort: key, dir: nextDir });
  }

  const idField = $derived<string>(manifest.idField ?? 'id');

  function rowHref(row: T): string {
    const id = (row as Record<string, unknown>)[idField];
    // Carry the list's filter querystring forward so the detail back-link can
    // restore the exact filtered view (the /workflows buildHref pattern).
    return `${assetItemHref(manifest, String(id))}${$page.url.search}`;
  }

  /**
   * The text of a row's LINK.
   *
   * ⚠️ This cell is not just a cell — it is the row's primary navigation
   * affordance, and `String(row[col.key] ?? '')` rendered `<a href="…"></a>`
   * for any manifest whose `titleField` is nullable (KAG entities are the
   * declared case). An anchor with no text is not a degraded link, it is an
   * invisible one: the row is still there, still navigable by keyboard, and
   * unreachable by the mouse looking for it.
   *
   * `manifest.list.titleFallbackField` existed for precisely this and was
   * honoured only by AssetDetail — so the heading it leads to had a fallback
   * while the link to it did not. Same chain, one implementation
   * (`resolveRowTitle`), so a new manifest gets it without opting in.
   *
   * ⚠️ The fallback applies AFTER a `formatter` too, not instead of it: a
   * formatter that returns `''` leaves exactly the same blank link, and no
   * formatter is ever asking for one.
   */
  function titleCellText(row: T, col: ColumnDef<T>): string {
    if (col.formatter) {
      const rendered = String(
        col.formatter((row as Record<string, unknown>)[col.key], row) ?? '',
      ).trim();
      if (rendered) return rendered;
    }
    return resolveRowTitle(row, manifest) || '—';
  }

  function onRowClick(row: T, ev: MouseEvent) {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
    ev.preventDefault();
    void goto(rowHref(row));
  }

  function newHref(): string {
    return `${assetRouteBase(manifest)}/new`;
  }

  function rowIsSystem(row: T): boolean {
    return (row as { is_system?: boolean }).is_system === true;
  }

  // ---- Scope column + bulk actions (manifest.scope opt-in) ----
  const scopeCfg = $derived(manifest.scope ?? null);

  function idOf(row: T): string {
    return String((row as Record<string, unknown>)[idField] ?? '');
  }

  /**
   * A project's display name, falling back to its id.
   *
   * ⛔ THE SAME DEFECT CLASS AS `relatedItemTitle` in AssetDetail.svelte.
   * This was `projects.find(…)?.name ?? id`, and `??` only skips
   * `null`/`undefined`: a project whose `name` is `'   '` WINS that chain, so
   * the Scope badge renders `Project:` with nothing after the colon and the id
   * it could have shown one rung down is discarded. The bulk-assign flash
   * (`Assigned N to ….`) is the same function's second caller and goes fully
   * blank. So the remedy is the one already proven in this PR — the shared
   * `rowFieldText` primitive, whose whole job is that a rung counts only if it
   * is non-empty AFTER trimming.
   *
   * ⚠️ REACHABLE, NOT OBSERVED — this closes a reachable state, it does not
   * fix a bug anyone has seen. Nothing PREVENTS a blank name: `name` is
   * validated `z.string().min(1)` on create (`types/api.ts`), on PATCH
   * (`routes/projects.ts`) and in the agui project action, with ZERO `.trim()`
   * anywhere in that chain, and zod 3's `min(1)` counts characters — so
   * `'   '` passes. The column is plain `text('name').notNull()` and the live
   * table's CHECK constraints do not cover `name`. Nothing has TRIGGERED it:
   * 0 of 263 live projects have `name <> btrim(name) OR btrim(name) = ''`.
   */
  function projectName(id: string): string {
    const p = projects.find((x) => x.id === id);
    return rowFieldText({ name: p?.name }, 'name') || id;
  }

  /**
   * A department's display name, falling back to its id.
   *
   * ⛔ THE SAME DEFECT CLASS as `projectName` above, and the same remedy: the
   * shared `rowFieldText` primitive, which counts a rung only if it is
   * non-empty AFTER trimming. So `null`, `undefined`, `''` AND `'   '` all fall
   * through to the id. `?? id` would NOT do this — `''` is not nullish and
   * would win the chain, which is exactly how `projectName` was wrong before.
   *
   * ⚠️ UNREACHABLE AGAINST LIVE DATA TODAY, which is why its test must SEED a
   * department instead of relying on the fixture: `fr.departments` has 0 rows,
   * so `departmentsState === 'ready'` — the only branch that renders the
   * `<select>` below — never opens in production. A test that does not seed one
   * asserts nothing here and cannot fail.
   */
  function departmentName(id: string): string {
    const d = departments.find((x) => x.id === id);
    return rowFieldText({ name: d?.name }, 'name') || id;
  }

  function rowOrigin(row: T): {
    origin_kind: 'tenant' | 'project' | 'workflow';
    project_id: string | null;
  } {
    const r = row as Record<string, unknown>;
    const ok = r.origin_kind;
    const pid =
      (r.origin_project_id as string | undefined) ??
      (r.project_id as string | undefined) ??
      null;
    if (ok === 'project' || ok === 'tenant' || ok === 'workflow') {
      return { origin_kind: ok, project_id: pid };
    }
    if (pid) return { origin_kind: 'project', project_id: pid };
    return { origin_kind: 'tenant', project_id: null };
  }

  const selectableIds = $derived(filtered.map((r) => idOf(r)));

  // ---- Row keys that survive a non-unique id from upstream ----
  //
  // `{#each … (key)}` is FATAL on a repeated key: Svelte throws
  // `each_key_duplicate` and the whole page dies mid-render. That is exactly
  // what /kag/entities did — it sat on "Loading kag entities…" with zero rows
  // while `GET /api/assets/kag/entities` was answering HTTP 200 with 9.3 MB.
  // Measured upstream (`GET /graph/nodes`, same tenant): 17,637 nodes,
  // 17,581 distinct ids, 56 ids present exactly twice, 0 null or empty. In all
  // 56 pairs the ONLY differing field is `properties.created_at`, by about one
  // millisecond — two graph nodes minted for one content-hashed entity id.
  //
  // ⚠️ THAT IS AN UPSTREAM DATA DEFECT, NOT A KEY-CHOICE MISTAKE. `id` is the
  // right key; the graph should not hold two nodes under one entity id, and
  // this local change does not repair it. The reason the fix is here anyway is
  // that the two obvious alternatives are both worse:
  //   * keying by array index would silently degrade EVERY manifest's list to
  //     an unkeyed each, losing row identity across sort and filter;
  //   * de-duplicating (here or in the BFF) would hide the defect — the second
  //     record would vanish from the only surface where anyone can see that it
  //     exists, and the graph would stay wrong with nothing left to notice it.
  // So: every record is rendered, the first occurrence of an id keeps that id
  // as its key (stable identity for the 99.7% that do not collide), later
  // occurrences get a disambiguating suffix, and the collision is REPORTED.
  const keyedRows = $derived.by<{ rows: { key: string; row: T }[]; dupes: string[] }>(
    () => {
      const seen = new Map<string, number>();
      const dupes: string[] = [];
      const rows = filtered.map((row) => {
        const id = idOf(row);
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        if (n === 2) dupes.push(id);
        // U+0000 cannot occur in an id that came out of JSON text the app
        // renders, so `${id}\u0000${n}` cannot collide with a real id.
        return { key: n === 1 ? id : `${id}\u0000${n}`, row };
      });
      return { rows, dupes };
    },
  );

  // ---- Same-title grouping (opt-in, manifest.list.groupDuplicateTitles) ----
  // UI review 2026-10-07: /decisions listed the same ADR title dozens of times
  // (re-imported rows, distinct ids). Collapse to one row with "×N"; the badge
  // expands the group so every member stays clickable. Grouping runs AFTER
  // sort/filter, so a group sits where its first sorted member sits.
  let expandedTitleGroups = $state<Set<string>>(new Set());
  const displayRows = $derived.by<
    { key: string; row: T; dupCount: number; groupKey: string | null; follower: boolean }[]
  >(() => {
    if (!manifest.list.groupDuplicateTitles) {
      return keyedRows.rows.map((r) => ({ ...r, dupCount: 1, groupKey: null, follower: false }));
    }
    const titleField = manifest.list.titleField;
    const groups = groupDuplicates(keyedRows.rows, (r) =>
      titleKey((r.row as Record<string, unknown>)[titleField] ?? r.key),
    );
    const out: { key: string; row: T; dupCount: number; groupKey: string | null; follower: boolean }[] =
      [];
    for (const g of groups) {
      out.push({ ...g.first, dupCount: g.count, groupKey: g.key, follower: false });
      if (g.count > 1 && expandedTitleGroups.has(g.key)) {
        for (const m of g.items.slice(1)) {
          out.push({ ...m, dupCount: 1, groupKey: g.key, follower: true });
        }
      }
    }
    return out;
  });

  function toggleTitleGroup(key: string): void {
    const next = new Set(expandedTitleGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedTitleGroups = next;
  }

  // Greppable, one line per settled render that saw a collision. `console` is
  // the transport the sibling `telemetry/shape-mismatch` module already uses
  // for "a 200 the client could not use"; this is the same class of event.
  const DUPLICATE_ROW_KEY_EVENT = 'fr.client.duplicate_row_key';
  $effect(() => {
    const dupes = keyedRows.dupes;
    if (dupes.length === 0) return;
    // eslint-disable-next-line no-console -- this IS the transport
    console.warn(
      DUPLICATE_ROW_KEY_EVENT,
      `${manifest.name}: upstream returned ${dupes.length} duplicate ` +
        `\`${idField}\` value(s). Every record is still listed, but these ids ` +
        `are NOT unique and the duplication is real data: ${dupes.join(', ')}`,
    );
  });

  function toggleRow(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleAllRows(): void {
    if (selected.size === selectableIds.length && selectableIds.length > 0) {
      selected = new Set();
    } else {
      selected = new Set(selectableIds);
    }
  }

  function flashBulk(msg: string): void {
    bulkMsg = msg;
    setTimeout(() => {
      if (bulkMsg === msg) bulkMsg = null;
    }, 4000);
  }

  async function runBulk(
    label: string,
    fn: (id: string) => Promise<unknown>,
  ): Promise<void> {
    if (!scopeCfg || selected.size === 0) return;
    bulkPending = true;
    bulkError = null;
    bulkMsg = null;
    const ids = Array.from(selected);
    try {
      await Promise.all(ids.map((id) => fn(id)));
      selected = new Set();
      await loadItems();
      flashBulk(label);
    } catch (e) {
      bulkError = e instanceof Error ? e.message : String(e);
    } finally {
      bulkPending = false;
    }
  }

  async function bulkAssign(): Promise<void> {
    if (!scopeCfg || !bulkProjectId) return;
    const pid = bulkProjectId;
    await runBulk(`Assigned ${selected.size} to ${projectName(pid)}.`, (id) =>
      bindAsset(scopeCfg.assetKind, id, [pid]),
    );
    bulkProjectId = '';
  }

  async function bulkPromoteWorkspace(): Promise<void> {
    if (!scopeCfg) return;
    await runBulk('Promoted selected to workspace.', (id) =>
      tenancy.promoteAsset(scopeCfg.assetKind, id, 'workspace'),
    );
  }

  async function bulkPromoteDept(): Promise<void> {
    if (!scopeCfg || !bulkDeptId) return;
    const dept = departments.find((d) => d.id === bulkDeptId);
    if (!dept) return;
    await runBulk(`Promoted selected to ${departmentName(dept.id)}.`, (id) =>
      tenancy.promoteAsset(scopeCfg.assetKind, id, { dept_id: dept.id }),
    );
    bulkDeptId = '';
  }
</script>

<div
  class="flex"
  data-testid="asset-list"
  data-manifest={manifest.name}
>
  {#if tagsField}
    <aside
      class="w-56 shrink-0 border-r border-[var(--color-border)] px-4 py-4 max-h-[calc(100vh-4rem)] overflow-y-auto"
      aria-label="Tag filter"
    >
      <div class="flex items-baseline justify-between mb-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Tags
        </h2>
        {#if selectedTags.size > 0}
          <button
            type="button"
            onclick={() => void setSearchParams($page.url, { tags: null })}
            class="text-xs text-[var(--color-accent)] hover:underline"
          >
            Clear
          </button>
        {/if}
      </div>
      {#if sortedTags.length === 0}
        <p class="text-xs text-[var(--color-text-muted)] italic">
          No tags on these {manifest.plural.toLowerCase()}.
        </p>
      {:else}
        <ul class="space-y-1">
          {#each sortedTags as [tag, count] (tag)}
            <li>
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedTags.has(tag)}
                  onchange={() => toggleTag(tag)}
                  class="cursor-pointer"
                />
                <span class="truncate text-[var(--color-text)]">{tag}</span>
                <span class="ml-auto text-xs text-[var(--color-text-muted)]">{count}</span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>
  {/if}

  <div class="flex-1 px-6 py-4">
    <div class="flex items-center justify-between mb-4 gap-4">
      <h1 class="text-2xl font-semibold">{manifest.plural}</h1>
      <div class="flex items-center gap-3">
        <input
          type="search"
          placeholder="Search…"
          value={search}
          oninput={(e) =>
            void setSearchParams($page.url, {
              q: (e.currentTarget as HTMLInputElement).value,
            })}
          class="border border-[var(--color-border-strong)] rounded px-3 py-1.5 text-sm w-64 dark:border-[var(--color-border-strong)]"
          data-testid="asset-list-search"
        />
        {#if statusField && statusValues.length > 0}
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onchange={(e) =>
              void setSearchParams($page.url, {
                status: (e.currentTarget as HTMLSelectElement).value,
              })}
            class="border border-[var(--color-border-strong)] rounded px-2 py-1.5 text-sm dark:border-[var(--color-border-strong)]"
            data-testid="asset-list-status-filter"
          >
            <option value="">All statuses</option>
            {#each statusValues as v (v)}
              <option value={v}>{v}</option>
            {/each}
          </select>
        {/if}
        {#if includeToggle}
          <label class="flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={includeOn}
              onchange={(e) =>
                void setSearchParams($page.url, {
                  [includeToggle.param]: (e.currentTarget as HTMLInputElement).checked
                    ? 'true'
                    : null,
                })}
              data-testid="asset-list-include-toggle"
            />
            {includeToggle.label}
          </label>
        {/if}
        {#if manifest.api.create}
          <a
            href={newHref()}
            class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] text-sm"
            data-testid="asset-list-new"
          >
            + New {manifest.singular.toLowerCase()}
          </a>
        {/if}
      </div>
    </div>

    {#if scopeCfg && (bulkMsg || bulkError)}
      <div
        class={bulkError
          ? 'mb-3 rounded bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-3 py-2 text-sm text-[var(--color-danger)]'
          : 'mb-3 rounded bg-[var(--color-success-bg)] border border-[var(--color-success-border)] px-3 py-2 text-sm text-[var(--color-success-text)]'}
        data-testid="bulk-feedback"
        role={bulkError ? 'alert' : 'status'}
      >
        {bulkError ?? bulkMsg}
      </div>
    {/if}

    {#if scopeCfg && selected.size > 0}
      <div
        class="mb-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface)] p-2"
        data-testid="asset-bulk-bar"
      >
        <span class="text-sm text-[var(--color-text-muted)]" data-testid="bulk-count">
          {selected.size} selected
        </span>

        {#if scopeCfg.bindable && projectsState === 'unreadable'}
          <span
            class="text-xs text-[var(--color-warning-text)]"
            data-testid="bulk-projects-unreadable"
            title={`Project list read failed — ${projectsUnreadable}. Assignment targets are UNKNOWN, not absent.`}
          >
            Project list unreadable — assignment targets are unknown, not absent. Retry.
            <span class="font-mono text-[var(--color-text-muted)]">({projectsUnreadable})</span>
          </span>
        {/if}
        {#if scopeCfg.bindable && projectsState === 'ready'}
          <select
            bind:value={bulkProjectId}
            disabled={bulkPending}
            data-testid="bulk-assign-select"
            class="px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded dark:border-[var(--color-border-strong)]"
          >
            <option value="">Assign to project…</option>
            {#each projects as p (p.id)}
              <option value={p.id}>{projectName(p.id)}</option>
            {/each}
          </select>
          <button
            type="button"
            onclick={bulkAssign}
            disabled={bulkPending || !bulkProjectId}
            data-testid="bulk-assign-btn"
            class="h-8 px-3 text-sm font-medium rounded bg-[var(--color-accent)] text-[var(--color-on-primary)] disabled:opacity-50"
          >Assign</button>
        {/if}

        {#if scopeCfg.promotable}
          <button
            type="button"
            onclick={bulkPromoteWorkspace}
            disabled={bulkPending}
            data-testid="bulk-promote-workspace"
            class="h-8 px-3 text-sm font-medium rounded bg-[var(--color-surface-strong)] text-[var(--color-text)] disabled:opacity-50"
          >Promote to workspace</button>

          {#if departmentsState === 'unreadable'}
            <span
              class="text-xs text-[var(--color-warning-text)]"
              data-testid="bulk-departments-unreadable"
              title={`Department list read failed — ${departmentsUnreadable}. Promotion targets are UNKNOWN, not absent.`}
            >
              Department list unreadable — promotion targets are unknown, not absent. Retry.
              <span class="font-mono text-[var(--color-text-muted)]">({departmentsUnreadable})</span>
            </span>
          {/if}
          {#if departmentsState === 'ready'}
            <select
              bind:value={bulkDeptId}
              disabled={bulkPending}
              data-testid="bulk-promote-dept-select"
              class="px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded dark:border-[var(--color-border-strong)]"
            >
              <option value="">Department…</option>
              {#each departments as d (d.id)}
                <option value={d.id}>{departmentName(d.id)}</option>
              {/each}
            </select>
            <button
              type="button"
              onclick={bulkPromoteDept}
              disabled={bulkPending || !bulkDeptId}
              data-testid="bulk-promote-dept-btn"
              class="h-8 px-3 text-sm font-medium rounded bg-[var(--color-surface-strong)] text-[var(--color-text)] disabled:opacity-50"
            >Promote to department</button>
          {/if}
        {/if}

        <button
          type="button"
          onclick={() => (selected = new Set())}
          class="ml-auto text-xs text-[var(--color-text-muted)] hover:underline"
          data-testid="bulk-clear"
        >Clear</button>
      </div>
    {/if}

    {#if truncated && !loading && !loadError}
      <!--
        The page was capped upstream. Say so — a capped list that looks complete
        is the defect this replaces. The count is deliberately "the first N",
        never "N of M": this list unions two tenant frames and then filters
        locally, so any upstream total would be larger than anything the table
        can ever show.
      -->
      <div
        class="mb-2 flex items-center justify-between gap-3 rounded border border-[var(--color-warning-bg)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
        data-testid="asset-list-truncated"
        title={appliedLimit === null
          ? 'The source returned a full page.'
          : `The source returned a full page of ${appliedLimit} rows.`}
      >
        <!--
          ⚠️ Deliberately NO "N of M". `items.length` is the POST-filter count
          and `appliedLimit` is the PRE-filter cap, so pairing them can read
          "showing 3 of at least 200" — a number that describes neither the
          list nor the truth. Naming only what is certain is the whole point of
          this banner.
        -->
        <span>
          This page is capped — more {manifest.plural.toLowerCase()} exist upstream than are shown.
        </span>
        {#if !showingAll}
          <button
            type="button"
            class="shrink-0 underline"
            onclick={loadAllRows}
            data-testid="asset-list-load-all"
          >Load more</button>
        {/if}
      </div>
    {/if}

    {#if loading}
      <p class="text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]">Loading {manifest.plural.toLowerCase()}…</p>
    {:else if loadError}
      <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm">
        {loadError}
      </div>
    {:else if filtered.length === 0}
      <p class="text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]">
        {items.length === 0
          ? `No ${manifest.plural.toLowerCase()} yet.`
          : 'No matches.'}
      </p>
    {:else}
      <div class="overflow-x-auto border border-[var(--color-border)] rounded dark:border-[var(--color-border)]">
        <table class="w-full text-sm">
          <thead class="bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
            <tr>
              {#if scopeCfg}
                <th class="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    data-testid="asset-select-all"
                    checked={selectableIds.length > 0 &&
                      selected.size === selectableIds.length}
                    onchange={toggleAllRows}
                  />
                </th>
              {/if}
              {#each manifest.list.columns as col (col.key)}
                <th
                  class="px-3 py-2 text-left font-semibold cursor-pointer select-none"
                  style={col.width ? `width: ${col.width}` : undefined}
                  onclick={() => toggleSort(col.key)}
                >
                  {col.label}
                  {#if sortKey === col.key}
                    <span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
                      >{sortDir === 'asc' ? '▲' : '▼'}</span
                    >
                  {/if}
                </th>
              {/each}
              {#if scopeCfg}
                <th class="px-3 py-2 text-left font-semibold select-none">
                  Scope
                </th>
              {/if}
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
            {#each displayRows as { key, row, dupCount, groupKey, follower } (key)}
              {@const badge = manifest.list.rowBadge?.(row) ?? null}
              <tr
                class="hover:bg-[var(--color-surface)] cursor-pointer dark:hover:bg-[var(--color-surface-strong)] {follower
                  ? 'bg-[var(--color-surface)]'
                  : ''} {badge ? 'opacity-60' : ''}"
                onclick={(ev) => onRowClick(row, ev)}
              >
                {#if scopeCfg}
                  <td
                    class="w-8 px-3 py-2 align-top"
                    onclick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${idOf(row)}`}
                      data-testid={`asset-select-${idOf(row)}`}
                      checked={selected.has(idOf(row))}
                      onchange={() => toggleRow(idOf(row))}
                    />
                  </td>
                {/if}
                {#each manifest.list.columns as col (col.key)}
                  <td class="px-3 py-2 align-top">
                    {#if col.key === manifest.list.titleField}
                      <a
                        href={rowHref(row)}
                        class="text-[var(--color-accent-strong)] hover:underline dark:text-[var(--color-accent)]"
                        data-testid="asset-row-title-link"
                      >
                        {titleCellText(row, col)}
                      </a>
                      {#if dupCount > 1 && groupKey}
                        <button
                          type="button"
                          class="ml-2 rounded-full bg-[var(--color-surface-strong)] px-1.5 py-0.5 align-middle text-[10px] font-semibold text-[var(--color-text)]"
                          title={expandedTitleGroups.has(groupKey)
                            ? 'Hide the other rows with this title'
                            : `${dupCount} rows share this title — show them all`}
                          data-testid="asset-row-dup-count"
                          onclick={(e) => {
                            e.stopPropagation();
                            toggleTitleGroup(groupKey);
                          }}
                        >
                          ×{dupCount}
                        </button>
                      {/if}
                      {#if badge}
                        <span
                          class="ml-2 inline-block rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                          data-testid="asset-row-badge"
                        >
                          {badge}
                        </span>
                      {/if}
                      {#if rowIsSystem(row)}
                        <span
                          class="ml-2 inline-block rounded bg-[var(--color-surface-strong)] px-1.5 py-0.5 align-middle font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                          title="Inherited from the system tenant — read-only under a non-system workspace."
                          data-testid="asset-row-system-badge"
                        >
                          system
                        </span>
                      {/if}
                    {:else}
                      {col.formatter
                        ? col.formatter(row[col.key], row)
                        : String(row[col.key] ?? '')}
                    {/if}
                  </td>
                {/each}
                {#if scopeCfg}
                  {@const o = rowOrigin(row)}
                  <td
                    class="px-3 py-2 align-top"
                    onclick={(e) => e.stopPropagation()}
                  >
                    <AssetScopeBadge
                      origin_kind={o.origin_kind}
                      origin_project_id={o.project_id}
                      project_name={o.project_id ? projectName(o.project_id) : null}
                    />
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
