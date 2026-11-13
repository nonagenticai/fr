<!--
  ProjectLibraryTab.svelte

  Renders the bound-assets list for ONE asset kind on a project. Used by
  every /projects/[id]/library/<kind>/+page.svelte route to keep tab
  pages 3 lines each.

  Behaviour:
    - Fetches /api/assets/<plural>?bound_to=<project_id>
    - Renders rows with AssetScopeBadge (origin: tenant / project / workflow)
    - Empty state offers a "Bind more" CTA opening ProjectBindMore
    - "+ Bind more" button in the header opens ProjectBindMore unconditionally
    - kind="decision" ONLY: a second, independent, read-only section
      ("Linked in requirements management") lists the decisions any writer of
      rm decisions.project_id links to this project
      (/api/assets/decisions?project_id=<id>), minus any already bound here

  Links out to /library/<kind>/<id> by default; the two exceptions
  (kag_document → /library/kag/<id>, artifact → /library/artifacts) are
  handled by the linkBuilder prop.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { AssetScopeBadge } from '$lib/components/library';
  import ProjectBindMore from './ProjectBindMore.svelte';
  import RequestPromotionButton from './RequestPromotionButton.svelte';
  import { isPromotableCopy, type PromotableKind } from './promotionRequest';
  import { assetFetchPage } from '$lib/api/assets';
  import { projectNavHref } from '$lib/layout/navConfig';
  import type { AssetKind } from '$lib/api/bindings';

  interface Props {
    kind: AssetKind;
    pluralLabel: string;
    /** Override default link `/library/<plural>/<id>` (kag + artifact). */
    linkBuilder?: (id: string) => string;
  }

  let { kind, pluralLabel, linkBuilder }: Props = $props();

  interface Row {
    id: string;
    title?: string;
    name?: string;
    slug?: string;
    description?: string;
    origin_kind?: 'tenant' | 'project' | 'workflow';
    origin_project_id?: string | null;
    origin_workflow_run_id?: string | null;
    status?: string;
    /** G8: the workspace original's slug when this row is a project copy. */
    supersedes?: string | null;
    version_status?: string | null;
  }

  const PLURAL: Record<AssetKind, string> = {
    requirement: 'requirements',
    principle: 'principles',
    decision: 'decisions',
    kag_document: 'kag-documents',
    workflow: 'workflows',
    trigger: 'triggers',
    channel: 'channels',
    artifact: 'artifacts',
  };

  let projectId = $derived($page.params.id ?? '');
  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let showBindMore = $state(false);

  // Parity with the tenant-wide AssetWorkspace lists (AssetList.svelte): a
  // bound list can grow long, so offer the same client-side search + title
  // sort the global `/library/<kind>` routes have. `rows` is already
  // client-side, so this is a pure in-component filter — no extra fetch.
  let queryText = $state('');
  let sortDir = $state<'none' | 'asc' | 'desc'>('none');

  function displayTitle(r: Row): string {
    return r.title || r.name || r.slug || r.id;
  }

  let filtered = $derived.by<Row[]>(() => {
    const q = queryText.trim().toLowerCase();
    let out = q
      ? rows.filter((r) =>
          [r.title, r.name, r.slug, r.description].some(
            (v) => typeof v === 'string' && v.toLowerCase().includes(q),
          ),
        )
      : rows;
    if (sortDir !== 'none') {
      const dir = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort(
        (a, b) => displayTitle(a).localeCompare(displayTitle(b)) * dir,
      );
    }
    return out;
  });

  // Governance assets live canonically at the top-level `/{plural}/{id}`
  // AssetWorkspace detail (the /library/<plural> lens for them is removed).
  // Other kinds still resolve through the library lens / their own surfaces.
  const GOVERNANCE_KINDS: ReadonlySet<AssetKind> = new Set([
    'requirement',
    'principle',
    'decision',
  ]);

  function defaultLink(id: string): string {
    if (GOVERNANCE_KINDS.has(kind)) return `/${PLURAL[kind]}/${id}`;
    return `/library/${PLURAL[kind]}/${id}`;
  }

  function toRows(data: unknown): Row[] {
    const list: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { items?: unknown[] })?.items)
        ? ((data as { items: unknown[] }).items)
        : [];
    return list.filter((r): r is Row => typeof r === 'object' && r !== null);
  }

  // The backend caps the bound list too (bound-by-id.ts): `X-Truncated` there
  // means MORE ids are bound to this project than were returned. Same pattern
  // as linkedTruncated below — a notice, and the count shown as "N+".
  let boundTruncated = $state(false);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const pg = await assetFetchPage<unknown>(
        `/api/assets/${PLURAL[kind]}?bound_to=${encodeURIComponent(projectId)}`,
      );
      boundTruncated = pg.truncated;
      rows = toRows(pg.items);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Decisions only: what requirements management links to this project via
  // decisions.project_id. Bound in fr ≠ linked in rm — a project can have
  // thousands of linked decisions and zero bound ones, which read as "No
  // decisions bound yet" before this section existed. Fetched independently
  // of load() so a failure in one never blanks the other.
  let linkedAll = $state<Row[]>([]);
  let linkedLoading = $state(false);
  // True only once the LATEST loadLinked() succeeded. Starts false so the
  // first render (SSR / pre-onMount) never shows a count it has not measured.
  let linkedLoaded = $state(false);
  let linkedError = $state<string | null>(null);
  // Tri-state, as assetFetchPage reports it. `false` means the backend could
  // NOT resolve the project; it returns [] for an unknown project
  // (effective-query.ts `if (!(await projectExists(...))) return [];`), so an
  // empty list there is not "zero linked". Render none and say the answer is
  // unknown rather than showing a count (requirements.ts:357).
  let linkedResolved = $state<boolean | null>(null);
  let linkedTruncated = $state(false);
  let showInactiveLinked = $state(false);

  const INACTIVE_STATUSES: ReadonlySet<string> = new Set(['superseded', 'closed']);

  // Request token: a slow earlier response (e.g. the mount fetch) must not
  // overwrite a newer one started after a bind. Only the latest call writes.
  let linkedRequestSeq = 0;

  async function loadLinked(): Promise<void> {
    if (kind !== 'decision') return;
    const seq = ++linkedRequestSeq;
    linkedLoading = true;
    linkedLoaded = false;
    linkedError = null;
    try {
      const pg = await assetFetchPage<unknown>(
        `/api/assets/decisions?project_id=${encodeURIComponent(projectId)}`,
      );
      if (seq !== linkedRequestSeq) return;
      linkedResolved = pg.projectResolved;
      linkedTruncated = pg.truncated;
      linkedAll = pg.projectResolved === false ? [] : toRows(pg.items);
      linkedLoaded = true;
    } catch (err) {
      if (seq !== linkedRequestSeq) return;
      linkedError = err instanceof Error ? err.message : String(err);
      linkedAll = [];
    } finally {
      if (seq === linkedRequestSeq) linkedLoading = false;
    }
  }

  // Linked minus anything already bound — a bound decision shows once, above.
  let linkedRows = $derived.by<Row[]>(() => {
    const bound = new Set(rows.map((r) => r.id));
    return linkedAll.filter((r) => !bound.has(r.id));
  });
  let linkedInactiveCount = $derived(
    linkedRows.filter((r) => INACTIVE_STATUSES.has(String(r.status ?? '').toLowerCase()))
      .length,
  );
  let linkedVisible = $derived(
    showInactiveLinked
      ? linkedRows
      : linkedRows.filter(
          (r) => !INACTIVE_STATUSES.has(String(r.status ?? '').toLowerCase()),
        ),
  );

  // A linked count is only known once BOTH reads succeeded: linkedRows is
  // linked MINUS bound, so a pending or failed bound read leaves the deduped
  // count unknown (rows may still render). An unresolved project has no
  // count either. The backend caps the page (page-cap.ts, X-Truncated), so a
  // truncated count is a lower bound and is shown as "N+".
  let linkedCountKnown = $derived(
    linkedLoaded && !linkedError && linkedResolved !== false && !loading && !error,
  );
  // The ONLY place a linked count is formatted (heading, empty-state hint and
  // the superseded/closed toggle all render through it).
  function formatLinkedCount(n: number): string | null {
    if (!linkedCountKnown) return null;
    return linkedTruncated ? `${n}+` : String(n);
  }
  let linkedCountLabel = $derived<string | null>(formatLinkedCount(linkedRows.length));
  let linkedVisibleLabel = $derived<string | null>(formatLinkedCount(linkedVisible.length));
  let linkedInactiveLabel = $derived<string | null>(formatLinkedCount(linkedInactiveCount));

  onMount(() => {
    void load();
    void loadLinked();
  });

  function onBindMoreClose(didBind: boolean): void {
    showBindMore = false;
    if (didBind) {
      void load();
      void loadLinked();
    }
  }
</script>

<header class="mb-4 flex items-start justify-between gap-4">
  <div>
    <!-- UI review 2026-10-08: the way back every other project sub-page has
         (PageHeader's inspect back link, via ProjectInspectHeader). -->
    <a
      href={projectNavHref(projectId, '')}
      class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
      data-testid="project-library-back-link"
    >
      ← Cockpit
    </a>
    <h1 class="text-2xl font-semibold">{pluralLabel} bound to this project</h1>
    <p class="text-sm text-[var(--color-text-muted)] mt-1 max-w-2xl">
      Items explicitly bound to this project — n8n only sees these on this
      project's workflows. Tenant-wide unbound items are out of scope here.
    </p>
  </div>
  <button
    type="button"
    class="px-3 py-1.5 text-sm border border-[var(--color-border-strong)] rounded hover:bg-[var(--color-surface)]"
    onclick={() => (showBindMore = true)}
    data-testid="bind-more-button"
  >+ Bind more</button>
</header>

{#if loading}
  <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
{:else if error}
  <p class="text-sm text-[var(--color-danger-text)]" data-testid="error">{error}</p>
{:else if rows.length === 0}
  <p
    data-testid="empty"
    class="text-sm text-[var(--color-text-muted)] border border-dashed rounded p-4"
  >
    {#if boundTruncated}
      <span data-testid="bound-truncated">None of the first bound {pluralLabel.toLowerCase()} could be shown — more are bound to this project.</span>
    {:else if kind === 'decision' && linkedVisibleLabel !== null && linkedVisible.length > 0}
      No decisions bound in fr yet — {linkedVisibleLabel} {linkedVisibleLabel === '1' ? 'is' : 'are'} linked below.
    {:else if kind === 'decision' && linkedInactiveLabel !== null && linkedRows.length > 0}
      No decisions bound in fr yet — {linkedInactiveLabel} superseded/closed {linkedInactiveLabel === '1' ? 'is' : 'are'} linked below.
    {:else}
      No {pluralLabel.toLowerCase()} bound yet. Use <strong>+ Bind more</strong> to attach items from the tenant library.
      <!-- UI review #10: "none bound HERE" is not "none apply" — tenant and
           workflow assets are inherited. Point at the resolved set. -->
      <a
        href={projectNavHref(projectId, 'knowledge')}
        class="text-[var(--color-accent)] hover:underline"
        data-testid="empty-effective-link"
      >See the effective assets this project inherits →</a>
    {/if}
  </p>
{:else}
  <div class="mb-3 flex items-center gap-3">
    <input
      type="search"
      placeholder="Search {pluralLabel.toLowerCase()}…"
      bind:value={queryText}
      class="border border-[var(--color-border-strong)] rounded px-3 py-1.5 text-sm w-64"
      aria-label="Search {pluralLabel.toLowerCase()}"
      data-testid="project-library-search"
    />
    <select
      bind:value={sortDir}
      class="border border-[var(--color-border-strong)] rounded px-2 py-1.5 text-sm"
      aria-label="Sort {pluralLabel.toLowerCase()}"
      data-testid="project-library-sort"
    >
      <option value="none">Sort: bound order</option>
      <option value="asc">Title A–Z</option>
      <option value="desc">Title Z–A</option>
    </select>
    <span class="text-xs text-[var(--color-text-muted)]" data-testid="project-library-count">
      {filtered.length} of {boundTruncated ? `${rows.length}+` : rows.length}
    </span>
  </div>
  {#if boundTruncated}
    <p class="text-xs text-[var(--color-text-muted)] mb-2" data-testid="bound-truncated">
      Only the first {rows.length} are shown — more {pluralLabel.toLowerCase()} are bound to this project.
    </p>
  {/if}
  {#if filtered.length === 0}
    <p
      data-testid="empty-filtered"
      class="text-sm text-[var(--color-text-muted)] border border-dashed rounded p-4"
    >
      No {pluralLabel.toLowerCase()} match “{queryText}”.
    </p>
  {:else}
    <ul class="divide-y border rounded">
      {#each filtered as r (r.id)}
        <li class="p-3 flex items-start gap-3">
          <div class="flex-1 min-w-0">
            <a
              href={(linkBuilder ?? defaultLink)(r.id)}
              class="text-sm font-medium hover:underline block truncate"
            >{displayTitle(r)}</a>
            {#if r.description}
              <p class="text-xs text-[var(--color-text-muted)] mt-0.5 line-clamp-2">{r.description}</p>
            {/if}
          </div>
          <AssetScopeBadge
            origin_kind={r.origin_kind ?? 'tenant'}
            origin_project_id={r.origin_project_id ?? null}
            origin_workflow_run_id={r.origin_workflow_run_id ?? null}
          />
          {#if isPromotableCopy(kind, r, projectId)}
            <RequestPromotionButton kind={kind as PromotableKind} assetId={r.id} />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/if}

{#if kind === 'decision'}
  <section class="mt-8" data-testid="project-linked-decisions">
    <!-- Count only once the answer is known: while loading, on error, or when
         the project is unresolved, "(0)" would assert an absence we never
         measured. Any writer of rm decisions.project_id lands here, not only
         the conveyor. -->
    <h2 class="text-lg font-semibold" data-testid="project-linked-decisions-heading">
      Linked in requirements management{#if linkedCountLabel !== null}{` (${linkedCountLabel})`}{/if}
    </h2>
    <p class="text-sm text-[var(--color-text-muted)] mt-1 mb-3 max-w-2xl">
      Decisions requirements management records against this project. Read-only
      here; bind one to make it visible to this project's workflows.
    </p>
    {#if linkedLoading || (!linkedLoaded && !linkedError)}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="linked-loading">Loading…</p>
    {:else if linkedError}
      <p class="text-sm text-[var(--color-danger-text)]" data-testid="linked-error">
        Couldn't load linked decisions: {linkedError}
      </p>
    {:else if linkedResolved === false}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="linked-unresolved">
        This project could not be resolved, so linked decisions are unknown.
      </p>
    {:else}
      {#if linkedTruncated}
        <p class="text-xs text-[var(--color-text-muted)] mb-2" data-testid="linked-truncated">
          Only the first page was loaded — more decisions are linked than shown here.
        </p>
      {/if}
      {#if linkedInactiveCount > 0}
        <button
          type="button"
          class="mb-2 text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
          onclick={() => (showInactiveLinked = !showInactiveLinked)}
          data-testid="linked-toggle-inactive"
        >
          {showInactiveLinked ? 'Hide' : 'Show'}{linkedInactiveLabel !== null ? ` ${linkedInactiveLabel}` : ''} superseded/closed
        </button>
      {/if}
      {#if linkedVisible.length > 0}
        <ul class="divide-y border rounded">
          {#each linkedVisible as r (r.id)}
            <li class="p-3 flex items-start gap-3" data-testid="linked-decision-row">
              <a
                href={defaultLink(r.id)}
                class="flex-1 min-w-0 text-sm font-medium hover:underline block truncate"
              >{displayTitle(r)}</a>
              {#if r.status}
                <span class="text-xs text-[var(--color-text-muted)]">{r.status}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
{/if}

{#if showBindMore}
  <ProjectBindMore
    {kind}
    projectId={projectId}
    pluralLabel={pluralLabel}
    excludeIds={rows.map((r) => r.id)}
    onClose={onBindMoreClose}
  />
{/if}
