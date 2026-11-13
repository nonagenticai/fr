<!--
  /projects/[id]/knowledge — effective-set view per project.

  Spec: docs/archive/2026-04-27-foundation-design.md §6.4
  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 15.

  Renders the *effective* asset set for the project — i.e. what the project
  actually sees once inheritance from Workspace + the project's owning
  department is applied, with overrides and blocks resolved.

  At the top: counter chips per asset type with W/D/P sub-counts (e.g.
  "12 reqs (3W·5D·4P)") and an InheritanceBreadcrumb showing where the
  project sits in the hierarchy.

  Per row: ScopePill marking the source of the asset, the title, plus inline
  Override/Block buttons (RBAC-gated; until license-authz exposes actor
  caps, "can*" follows the rule "scope must be project" — which is always
  true on this surface, so they're enabled).

  The page sets `scopeContext` to the project on mount so any onward links
  to /library/[type] inherit the project scope automatically.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    ScopePill,
    InheritanceBreadcrumb,
  } from '$lib/components/library';
  import { scopeContext } from '$lib/stores/scopeContext.svelte';
  import * as tenancy from '$lib/api/tenancy';
  import type { AssetType } from '$lib/api/tenancy';
  import { assetFetchPage } from '$lib/api/assets';
  import { groupDuplicates, titleKey, type DuplicateGroup } from '$lib/utils/groupDuplicates';

  type Scope = 'workspace' | 'department' | 'project';

  // Asset types we surface in the project knowledge tab. Keep this list
  // tight — workflows + KAG documents are part of the effective set, but
  // triggers/artifacts/channels are surfaced through their own tabs.
  const TYPES: ReadonlyArray<{
    id: AssetType;
    slug: string;
    label: string;
    short: string;
  }> = [
    {
      id: 'requirement',
      slug: 'requirements',
      label: 'Requirements',
      short: 'reqs',
    },
    { id: 'principle', slug: 'principles', label: 'Principles', short: 'principles' },
    {
      id: 'kag_document',
      slug: 'kag-documents',
      label: 'Knowledge documents',
      short: 'docs',
    },
    { id: 'workflow', slug: 'workflows', label: 'Workflows', short: 'workflows' },
  ];

  interface AssetRow {
    id: string;
    title: string;
    scope: Scope;
  }

  interface TypeBucket {
    id: AssetType;
    label: string;
    short: string;
    rows: AssetRow[];
    counts: { workspace: number; department: number; project: number };
    // The route said at least one upstream frame came back full, so `rows` is a
    // PAGE, not a count. False on the read-failure path — a failed read tells us
    // nothing about upstream size.
    truncated: boolean;
    // PRE-filter rows-per-frame cap. Never pair it with rows.length: that is a
    // POST-filter number, so "N of M" would describe neither.
    appliedLimit: number | null;
    // Did the `?project_id=` we sent resolve to a real project? `false` means
    // this bucket is empty because the PROJECT does not exist, not because it
    // holds nothing. `null` = this route does not say (see below).
    projectResolved: boolean | null;
  }

  const projectId = $derived(page.params.id ?? '');

  let buckets = $state<TypeBucket[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  // Asset types whose read FAILED this load. A bucket is empty for two very
  // different reasons and only this list separates them.
  let unreadableTypes = $state<string[]>([]);
  let actionError = $state<string | null>(null);
  let actionPending = $state(false);

  // Chip-strip vs section render is driven by row count: empty buckets
  // collapse into the chip strip, populated ones get a full section.
  const populated = $derived(buckets.filter((b) => b.rows.length > 0));

  /**
   * The `project_id` in the address bar does not name a real project.
   *
   * ⚠️ `=== false`, NOT truthiness and NOT `!b.projectResolved`. `null` is the
   * majority value here — only `requirements` of the five types emits
   * `X-Project-Resolved` at all (`backend/src/routes/assets/requirements.ts`
   * and `decisions.ts` are the only emitters), so four buckets say nothing on
   * every single load. A truthiness test would read that silence as "did not
   * resolve" and fire this banner on EVERY healthy project.
   *
   * `.some(...)`, not `.every(...)`: resolution is a fact about the PROJECT,
   * not about a type. One route that looked and found no such project has
   * settled it, and the four that never looked cannot outvote it.
   *
   * ⚠️ This is deliberately NOT folded into the empty state. `principles`
   * does not call `applyEffectiveFilter` at all, so it ignores
   * `project_id` and can still return rows against a project that does not
   * exist — `populated.length > 0` and "unresolved" are simultaneously true,
   * and a banner nested inside the empty branch would never render in exactly
   * the case a user is most likely to be misled by.
   */
  const projectUnresolved = $derived(
    buckets.some((b) => b.projectResolved === false),
  );

  // Map AssetType.id → /library/[type] slug for chip links.
  const SLUG_BY_ID: Record<AssetType, string> = {
    requirement: 'requirements',
    principle: 'principles',
    decision: 'decisions',
    kag_document: 'kag-documents',
    workflow: 'workflows',
    trigger: 'triggers',
    artifact: 'artifacts',
    channel: 'channels',
  };

  function inferScope(item: Record<string, unknown>): Scope {
    if (item.project_id != null && item.project_id !== '') return 'project';
    if (item.dept_id != null && item.dept_id !== '') return 'department';
    return 'workspace';
  }

  function rowOf(item: Record<string, unknown>): AssetRow {
    const id = String(item.id ?? item.name ?? '');
    const title = String(item.title ?? item.name ?? id);
    return { id, title, scope: inferScope(item) };
  }

  function bucketFrom(
    typ: { id: AssetType; label: string; short: string },
    items: Record<string, unknown>[],
    cap: {
      truncated: boolean;
      appliedLimit: number | null;
      projectResolved: boolean | null;
    },
  ): TypeBucket {
    const rows = items.map(rowOf);
    const counts = { workspace: 0, department: 0, project: 0 };
    for (const r of rows) counts[r.scope] += 1;
    return {
      id: typ.id,
      label: typ.label,
      short: typ.short,
      rows,
      counts,
      truncated: cap.truncated,
      appliedLimit: cap.appliedLimit,
      projectResolved: cap.projectResolved,
    };
  }

  // ⚠️ WHICH OF THE TYPES CAN ACTUALLY SAY — measured, not assumed.
  // `truncated` degrades to false when a route sends no page-cap headers:
  //
  //   requirements, principles  — page-capped, headers sent. A `+` appears.
  //   kag_document              — deliberately uncapped, and correct: its
  //                               upstream returns the whole tenant set, so a
  //                               bare count is the truth.
  //   workflows                 — uncapped, upstream unpaginated. Same as above.
  //
  // Only ever rendered on the truncated path — see the chip below.
  function capTitle(b: TypeBucket): string | undefined {
    if (!b.truncated) return undefined;
    return b.appliedLimit === null
      ? 'This page is capped — more exist upstream than are shown.'
      : `This page is capped at ${b.appliedLimit} rows — more exist upstream.`;
  }

  async function loadAll(): Promise<void> {
    loading = true;
    loadError = null;
    unreadableTypes = [];
    try {
      const params = new URLSearchParams();
      params.set('project_id', projectId);
      const qs = `?${params.toString()}`;
      // ⚠️ The per-type catch below is RIGHT — one asset type's failure must not
      // blank the page — but it used to be silent, so an empty bucket meant both
      // "this type has none" and "this type could not be read". With every type
      // failing, the page rendered "No knowledge attached to this project yet."
      // as a confident fact, and each chip showed a 0 nobody had counted.
      const failed: string[] = [];
      const responses = await Promise.all(
        TYPES.map(async (t) => {
          try {
            // Not named `page`: that identifier is the imported /state
            // page store at module scope.
            const res = await assetFetchPage<Record<string, unknown>[]>(
              `/api/assets/${t.slug}${qs}`,
            );
            return bucketFrom(t, res.items ?? [], {
              truncated: res.truncated,
              appliedLimit: res.appliedLimit,
              projectResolved: res.projectResolved,
            });
          } catch {
            failed.push(t.label ?? t.slug);
            // A read that FAILED learned nothing about the project either, so
            // `null` — not `false`. Inventing an unresolved verdict from a 502
            // would point the user at the project id when the fault is the
            // route, which is the same misdirection `unreadableTypes` exists
            // to prevent.
            return bucketFrom(t, [], {
              truncated: false,
              appliedLimit: null,
              projectResolved: null,
            });
          }
        }),
      );
      buckets = responses;
      unreadableTypes = failed;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      buckets = [];
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (projectId) {
      scopeContext.set({ kind: 'project', project_id: projectId });
      void loadAll();
    } else {
      loadError = 'Missing project id.';
      loading = false;
    }
  });

  // ---------------------------------------------------------------------------
  // Action handlers — Override / Block at project scope.
  // ---------------------------------------------------------------------------

  async function overrideRow(typ: AssetType, row: AssetRow): Promise<void> {
    if (!projectId) return;
    actionError = null;
    actionPending = true;
    try {
      // At this surface the override "candidate" is the row itself; finer-
      // grained candidate selection lands in a follow-up.
      await tenancy.overrideAsset(typ, row.id, row.id, {
        project_id: projectId,
      });
      await loadAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionPending = false;
    }
  }

  async function blockRow(typ: AssetType, row: AssetRow): Promise<void> {
    if (!projectId) return;
    actionError = null;
    actionPending = true;
    try {
      await tenancy.blockAsset(typ, row.id, { project_id: projectId });
      await loadAll();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionPending = false;
    }
  }

  // ---------------------------------------------------------------------------
  // UI review 2026-10-07: the effective set is every workspace + project asset,
  // which on a real workspace is 1000+ rows with many same-title duplicates.
  // Client-side search / type filter, same type+title collapsed into one "×N"
  // row (expandable, so every id stays actionable), and at most PAGE_STEP groups
  // rendered per type with "Show more". The FETCH is unchanged — a capped
  // response still says so ("first N shown").
  // ---------------------------------------------------------------------------
  const PAGE_STEP = 100;
  let search = $state('');
  let typeFilter = $state<AssetType | ''>('');
  let shownByType = $state<Record<string, number>>({});
  let expandedGroups = $state<Record<string, boolean>>({});

  interface ViewBucket {
    bucket: TypeBucket;
    groups: DuplicateGroup<AssetRow>[];
    matchedRows: number;
  }

  const viewBuckets = $derived.by((): ViewBucket[] => {
    const q = search.trim().toLowerCase();
    return populated
      .filter((b) => typeFilter === '' || b.id === typeFilter)
      .map((b) => {
        const rows = q ? b.rows.filter((r) => r.title.toLowerCase().includes(q)) : b.rows;
        return {
          bucket: b,
          groups: groupDuplicates(rows, (r) => titleKey(r.title, b.id)),
          matchedRows: rows.length,
        };
      })
      .filter((v) => v.matchedRows > 0);
  });

  const filtering = $derived(search.trim() !== '' || typeFilter !== '');

  function shownFor(typ: AssetType): number {
    return shownByType[typ] ?? PAGE_STEP;
  }

  function showMore(typ: AssetType): void {
    shownByType = { ...shownByType, [typ]: shownFor(typ) + PAGE_STEP };
  }

  function toggleGroup(key: string): void {
    expandedGroups = { ...expandedGroups, [key]: !expandedGroups[key] };
  }

  // RBAC: until license-authz surfaces actor caps, allow the actions —
  // backend authz is the source of truth.
  const canOverride = true;
  const canBlock = true;
</script>

<section class="p-6 space-y-4" data-testid="project-knowledge-page">
  <header class="flex flex-col gap-2">
    <a
      href={`/projects/${projectId}`}
      class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
      data-testid="project-knowledge-back-link"
    >
      ← Cockpit
    </a>
    <h1 class="text-xl font-semibold" data-testid="project-knowledge-title">
      Effective assets
    </h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Everything this project sees after inheritance + overrides — requirements, principles,
      decisions, workflows and KAG documents. For the knowledge graph itself
      (documents, search, ingestion) go to
      <a class="underline" href="/library/kag/documents">KAG → KAG documents</a>.
    </p>
    <!-- UI review 2026-10-07: the project's library tabs list only EXPLICIT
         bindings, so they read near-empty beside this page; say which is which. -->
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="project-knowledge-scope-note">
      This page lists what is available to the project through the workspace as well as the
      project itself. The project's library tabs show only assets explicitly bound to it.
    </p>
    <InheritanceBreadcrumb
      defined_at="project"
      inherited_by_depts={0}
      inherited_by_projects={0}
      override_count={0}
      block_count={0}
    />
  </header>

  {#if loading}
    <div class="text-sm text-[var(--color-text-muted)]" data-testid="project-knowledge-loading">
      Loading effective knowledge…
    </div>
  {:else if loadError}
    <div
      class="rounded-[var(--radius-sm)] bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-3 py-2 text-sm text-[var(--color-danger)]"
      data-testid="project-knowledge-load-error"
    >
      {loadError}
    </div>
  {:else}
    {#if projectUnresolved}
      <!--
        The honest reading of an empty project-scoped list. The route told us
        out of band (`X-Project-Resolved: false`) that it filtered to a project
        that does not exist, which is a DIFFERENT fact from "this project holds
        nothing" — so it gets its own testid and its own sentence, and the
        empty state below is suppressed rather than reworded.
      -->
      <div
        class="rounded-[var(--radius-sm)] border border-[var(--color-warning-bg)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
        data-testid="project-knowledge-unresolved-project"
        role="alert"
      >
        This project id does not resolve to a project. Project-scoped lists came
        back empty because the project could not be found — not because it has
        no knowledge attached. Check the id in the address bar.
      </div>
    {/if}

    <div
      class="flex flex-wrap gap-2"
      data-testid="project-knowledge-counters"
    >
      {#each buckets as b (b.id)}
        {@const total = b.rows.length}
        {@const totalLabel = b.truncated ? `${total}+` : String(total)}
        <a
          data-testid={`counter-${b.id}`}
          data-truncated={b.truncated}
          href={`/library/${SLUG_BY_ID[b.id]}?project_id=${projectId}`}
          class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-3 py-1 text-sm hover:bg-[var(--color-surface-strong)]"
          class:bg-[var(--color-surface)]={total > 0}
          title={capTitle(b)}
        >
          <span class="font-semibold">{totalLabel}</span>
          <span class="text-[var(--color-text-muted)]">{b.short}</span>
          {#if total > 0}
            <span class="text-xs text-[var(--color-text-muted)]">
              ({b.counts.workspace}W·{b.counts.department}D·{b.counts.project}P)
            </span>
          {/if}
        </a>
      {/each}
    </div>

    {#if actionError}
      <div
        class="rounded-[var(--radius-sm)] bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-3 py-2 text-sm text-[var(--color-danger)]"
        data-testid="project-knowledge-action-error"
        role="alert"
      >
        {actionError}
      </div>
    {/if}

    {#if populated.length > 0}
      <h2 class="text-sm font-semibold text-[var(--color-text)]" data-testid="project-knowledge-available-heading">
        Available to this project (workspace + project scope)
      </h2>
      <div class="flex flex-wrap items-center gap-2" data-testid="project-knowledge-filters">
        <input
          type="search"
          bind:value={search}
          placeholder="Filter by title…"
          aria-label="Filter assets by title"
          data-testid="project-knowledge-search"
          class="h-8 w-64 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-sm text-[var(--color-text)]"
        />
        {#if populated.length > 1}
          <select
            bind:value={typeFilter}
            aria-label="Filter assets by type"
            data-testid="project-knowledge-type-filter"
            class="h-8 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-sm text-[var(--color-text)]"
          >
            <option value="">All types</option>
            {#each populated as b (b.id)}
              <option value={b.id}>{b.label}</option>
            {/each}
          </select>
        {/if}
      </div>
      {#if filtering && viewBuckets.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="project-knowledge-no-match">
          No loaded asset matches this filter.
        </p>
      {/if}
    {/if}

    {#each viewBuckets as v (v.bucket.id)}
      {@const b = v.bucket}
      {@const headingCount = b.truncated ? `${b.rows.length}+` : String(b.rows.length)}
      {@const limit = shownFor(b.id)}
      <section
        data-testid={`bucket-${b.id}`}
        class="space-y-2"
      >
        <h2 class="text-sm font-semibold text-[var(--color-text)]">
          {b.label} <span class="text-[var(--color-text-muted)]" title={capTitle(b)}>·
            {headingCount}</span>
          {#if b.truncated}
            <!-- The server capped this read: never present it as the whole set. -->
            <span class="text-xs font-normal text-[var(--color-warning-text)]" data-testid={`bucket-${b.id}-capped`}>
              (first {b.rows.length} shown — more exist)
            </span>
          {/if}
          {#if v.groups.length !== v.matchedRows || filtering}
            <span class="text-xs font-normal text-[var(--color-text-muted)]">
              — {v.groups.length} distinct{filtering ? ` of ${v.matchedRows} matching` : ''}
            </span>
          {/if}
        </h2>
          <ul class="space-y-1">
            {#each v.groups.slice(0, limit) as g (g.key)}
              {@const row = g.first}
              {#if g.count === 1 || !expandedGroups[`${b.id}:${g.key}`]}
                <li
                  data-testid={`bucket-${b.id}-row-${row.id}`}
                  class="flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <ScopePill scope={row.scope} />
                  <span class="flex-1 text-sm font-medium">{row.title}</span>
                  {#if g.count > 1}
                    <!-- ×N: same type + title. Expand to act on one specific id. -->
                    <button
                      type="button"
                      data-testid={`dup-${b.id}-${row.id}`}
                      onclick={() => toggleGroup(`${b.id}:${g.key}`)}
                      title="Show each of these {g.count} rows"
                      class="h-7 rounded-full bg-[var(--color-surface-strong)] px-2 text-xs font-semibold text-[var(--color-text)]"
                    >
                      ×{g.count}
                    </button>
                  {:else}
                    <button
                      type="button"
                      data-testid={`override-${b.id}-${row.id}`}
                      disabled={!canOverride || actionPending}
                      onclick={() => overrideRow(b.id, row)}
                      class="h-7 px-2 text-xs font-medium rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] text-[var(--color-text)] disabled:opacity-50"
                    >
                      Override
                    </button>
                    <button
                      type="button"
                      data-testid={`block-${b.id}-${row.id}`}
                      disabled={!canBlock || actionPending}
                      onclick={() => blockRow(b.id, row)}
                      class="h-7 px-2 text-xs font-medium rounded-[var(--radius-sm)] bg-[var(--color-danger)] text-[var(--color-on-primary)] disabled:opacity-50"
                    >
                      Block
                    </button>
                  {/if}
                </li>
              {:else}
                <li class="space-y-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-1">
                  <button
                    type="button"
                    onclick={() => toggleGroup(`${b.id}:${g.key}`)}
                    class="px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                  >
                    Collapse {g.count} rows titled “{row.title}”
                  </button>
                  {#each g.items as member, i (`${member.id}:${i}`)}
                    <div
                      data-testid={`bucket-${b.id}-row-${member.id}`}
                      class="flex items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-surface)] px-3 py-2"
                    >
                      <ScopePill scope={member.scope} />
                      <span class="flex-1 text-sm font-medium">
                        {member.title}
                        <span class="font-mono text-xs text-[var(--color-text-muted)]">{member.id}</span>
                      </span>
                      <button
                        type="button"
                        data-testid={`override-${b.id}-${member.id}`}
                        disabled={!canOverride || actionPending}
                        onclick={() => overrideRow(b.id, member)}
                        class="h-7 px-2 text-xs font-medium rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] text-[var(--color-text)] disabled:opacity-50"
                      >
                        Override
                      </button>
                      <button
                        type="button"
                        data-testid={`block-${b.id}-${member.id}`}
                        disabled={!canBlock || actionPending}
                        onclick={() => blockRow(b.id, member)}
                        class="h-7 px-2 text-xs font-medium rounded-[var(--radius-sm)] bg-[var(--color-danger)] text-[var(--color-on-primary)] disabled:opacity-50"
                      >
                        Block
                      </button>
                    </div>
                  {/each}
                </li>
              {/if}
            {/each}
          </ul>
          {#if v.groups.length > limit}
            <button
              type="button"
              onclick={() => showMore(b.id)}
              data-testid={`bucket-${b.id}-show-more`}
              class="text-xs text-[var(--color-accent)] hover:underline"
            >
              Show more ({limit} of {v.groups.length} shown)
            </button>
          {/if}
      </section>
    {/each}

    <!--
      `&& !projectUnresolved`: "no knowledge attached to this project yet" is a
      claim about a project that EXISTS. When the id did not resolve, the banner
      above is the whole truth and this sentence is simply false, so it is
      suppressed rather than shown alongside. The two states never co-render and
      never share a testid.
    -->
    {#if populated.length === 0 && !projectUnresolved}
      <div
        class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
        data-testid="project-knowledge-empty"
      >
        {#if unreadableTypes.length > 0}
          <span data-testid="knowledge-unreadable" class="text-[var(--color-warning-text)]">
            {unreadableTypes.join(', ')} could not be read, so this project is NOT known to have no
            knowledge attached. Retry before concluding anything from this page.
          </span>
        {:else}
        No knowledge attached to this project yet. Click a chip above to view
        the workspace catalog, or use the agent to author new assets.
              {/if}
      </div>
    {/if}
  {/if}
</section>
