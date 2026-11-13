<!--
  /library/[type] — generic asset-list view per AssetType.

  Spec: docs/archive/2026-04-27-foundation-design.md §6.4
  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 14.

  Renders the four-button ScopeFilter at the top, a row per asset with a
  ScopePill marking its source scope, and a PromoteOverrideBlockMenu per
  row. Multi-select header lets the user bulk-promote selected items to
  Workspace or to a department.

  The page is intentionally driven by the existing /api/assets/* list
  endpoints.

  ⚠️ CORRECTED — this said "Until Wave 3 lands `?project_id=` filtering on those
  routes, the param is forwarded but ignored — the unfiltered list comes back".
  It is HONOURED today: every list route runs `applyEffectiveFilter`
  (`backend/src/routes/assets/_lib/effective-query.ts`), which resolves the
  project and applies override/block resolution. It also distinguishes an ABSENT
  `project_id` (do not scope) from an UNKNOWN one (empty set plus an explicit
  `X-Project-Resolved: false` header) — so a filtered list that comes back empty
  is a real answer, not the unfiltered fallback this comment used to promise.

  ⚠️ CORRECTED — this said "Once asset_assignments lands (Wave 3) the inference
  can move there". It landed: `backend/src/routes/assets/assignments.ts`, served
  at `GET /api/assets/_assignments`, and THIS PAGE ALREADY CALLS IT — see
  `loadAssignments` below, which builds the asset_id → link_kind map that drives
  the "Overrides only" and "Blocked" filters.

  What has NOT moved is the per-row Scope CHIP. `inferScope` below still reads
  the row's own `project_id` / `dept_id`, because `_assignments` answers for ONE
  scope at a time (the caller's current one) and the chip has to name the scope
  a row is defined at, which may be a different one. That is a real remaining
  gap, not a pending dependency:
    • a non-null `project_id` → 'project'
    • a non-null `dept_id`    → 'department'
    • otherwise               → 'workspace'
-->
<script lang="ts">
  import CockpitBackLink from '$lib/components/library/CockpitBackLink.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { goto } from '$app/navigation';
  import {
    ScopePill,
    ScopeFilter,
    PromoteOverrideBlockMenu,
  } from '$lib/components/library';
  import AssetEmptyState from '$lib/components/library/AssetEmptyState.svelte';
  import { ASSET_EXPLAINERS } from '$lib/components/library/AssetTypeExplainers';
  import { scopeContext } from '$lib/stores/scopeContext.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    workspaceAdminCapability,
    deptManagerArm,
    anyOf,
    type Capability,
  } from '$lib/rbac/assetScopeCapability';
  import * as tenancy from '$lib/api/tenancy';
  import type { AssetType, PromoteTarget } from '$lib/api/tenancy';
  import { assetFetch } from '$lib/api/assets';
  import { readFailureReason, scopeRefState } from '$lib/asset-workspace/scopeRefs';

  type Scope = 'workspace' | 'department' | 'project';
  type FilterKind = 'all_inherited' | 'defined_here' | 'overrides' | 'blocked';

  // ---------------------------------------------------------------------------
  // AssetType validation + plural mapping → /api/assets/* path segment.
  // ---------------------------------------------------------------------------

  // Note: 'artifact' is deliberately omitted from VALID_TYPES + the slug/label
  // maps below. The user-facing "Artifacts" surface (project-scoped n8n/card
  // outputs with review workflow) lives at /library/artifacts and is not part
  // of the 4D-asset tenancy/promotion system. Keeping 'artifact' in AssetType
  // (so tenancy.ts API contracts stay intact) but routing it to the dedicated
  // page instead of this generic [type] view.
  const VALID_TYPES: ReadonlyArray<AssetType> = [
    'requirement',
    'principle',
    'decision',
    'kag_document',
    'workflow',
    'trigger',
    'channel',
  ];

  // Backend list-route plural slug per AssetType. Matches the existing
  // manifests in $lib/manifests/*.ts.
  const TYPE_TO_SLUG: Partial<Record<AssetType, string>> = {
    requirement: 'requirements',
    principle: 'principles',
    decision: 'decisions',
    kag_document: 'kag-documents',
    workflow: 'workflows',
    trigger: 'triggers',
    channel: 'channels',
  };

  // Inverse map: plural URL slug → singular AssetType. The top-level
  // /requirements, /principles, /decisions routes 308 to
  // /library/<plural>, so we have to accept the plural form here.
  const SLUG_TO_TYPE: Record<string, AssetType> = Object.fromEntries(
    (Object.entries(TYPE_TO_SLUG) as [AssetType, string][]).map(
      ([t, s]) => [s, t],
    ),
  );

  // Pretty-print AssetType for headers / empty-state text.
  const TYPE_LABEL_PLURAL: Partial<Record<AssetType, string>> = {
    requirement: 'Requirements',
    principle: 'Principles',
    decision: 'Decisions',
    kag_document: 'Knowledge documents',
    workflow: 'Workflows',
    trigger: 'Triggers',
    channel: 'Channels',
  };

  // ---------------------------------------------------------------------------
  // Row shape we render.
  // ---------------------------------------------------------------------------

  interface AssetRow {
    id: string;
    title: string;
    scope: Scope;
    project_id?: string | null;
    dept_id?: string | null;
  }

  // ---------------------------------------------------------------------------
  // Component state.
  // ---------------------------------------------------------------------------

  const rawType = $derived($page.params.type ?? '');
  const assetType = $derived(
    SLUG_TO_TYPE[rawType] ??
      (VALID_TYPES.includes(rawType as AssetType)
        ? (rawType as AssetType)
        : null),
  );

  let rows = $state<AssetRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let selected = $state<Set<string>>(new Set());
  let filterKind = $state<FilterKind>('all_inherited');
  let departments = $state<tenancy.Department[]>([]);
  /**
   * The department read FAILED — distinct from a tenant that has none.
   *
   * ⚠️ `canPromoteDept = departments.length > 0` gates every "Promote to
   * Department" control on this page, and the row menu passes
   * `onPromoteDept={departments.length > 0 ? … : undefined}`. So a failed read
   * silently removed the capability and told the user nothing: the page looked
   * exactly like a workspace with no departments. Departments are ENRICHMENT
   * here — the asset rows come from `/api/assets/<slug>` and still render — so
   * name the lost input rather than blanking anything.
   */
  let departmentsUnreadable = $state<string | null>(null);
  // Three states, not two — `empty` is the only one the promotion row's absence
  // is honest in, and only a SUCCESSFUL read reaches it.
  const departmentsState = $derived(
    scopeRefState(departments.length, departmentsUnreadable),
  );
  let actionError = $state<string | null>(null);
  let actionPending = $state(false);
  // Map of asset_id → link_kind for the current scope. Populated by
  // loadAssignments() for the "Overrides only" / "Blocked" filters via
  // /api/assets/_assignments. Empty Map for filters that don't need it.
  let assignmentLinkKind = $state<Map<string, 'owns' | 'override' | 'block'>>(
    new Map(),
  );

  // Filtered rows = client-side pre-filter applied on top of the fetched
  // list. "Defined here only" hides items whose source ≠ current scope.
  // "Overrides only" / "Blocked" intersect the row id set with the
  // assignmentLinkKind map populated from
  // /api/assets/_assignments (backend reads asset_assignments).
  function rowsForFilter(kind: FilterKind): AssetRow[] {
    const ctx = scopeContext.current;
    if (kind === 'defined_here') {
      if (ctx.kind === 'workspace') {
        return rows.filter((r) => r.scope === 'workspace');
      }
      if (ctx.kind === 'department') {
        return rows.filter(
          (r) => r.scope === 'department' && r.dept_id === ctx.dept_id,
        );
      }
      return rows.filter(
        (r) => r.scope === 'project' && r.project_id === ctx.project_id,
      );
    }
    if (kind === 'overrides') {
      return rows.filter((r) => assignmentLinkKind.get(r.id) === 'override');
    }
    if (kind === 'blocked') {
      return rows.filter((r) => assignmentLinkKind.get(r.id) === 'block');
    }
    return rows;
  }

  const filteredRows = $derived(rowsForFilter(filterKind));

  // Per-chip counts for the ScopeFilter badge UI. `overrides` and `blocked`
  // depend on assignmentLinkKind, which is loaded lazily — counts will be
  // 0 until the user clicks one of those chips and the assignments fetch
  // completes (then this re-derives).
  const filterCounts = $derived<Partial<Record<FilterKind, number>>>({
    all_inherited: rowsForFilter('all_inherited').length,
    defined_here: rowsForFilter('defined_here').length,
    overrides: rowsForFilter('overrides').length,
    blocked: rowsForFilter('blocked').length,
  });

  // ---------------------------------------------------------------------------
  // Loaders.
  // ---------------------------------------------------------------------------

  function inferScope(item: Record<string, unknown>): Scope {
    if (item.project_id != null && item.project_id !== '') return 'project';
    if (item.dept_id != null && item.dept_id !== '') return 'department';
    return 'workspace';
  }

  function rowOf(item: Record<string, unknown>): AssetRow {
    const id = String(item.id ?? item.name ?? '');
    const title = String(item.title ?? item.name ?? id);
    return {
      id,
      title,
      scope: inferScope(item),
      project_id: (item.project_id as string | null | undefined) ?? null,
      dept_id: (item.dept_id as string | null | undefined) ?? null,
    };
  }

  // Binding-aware origin filter — orthogonal to the 4D-asset ScopeFilter
  // above. Picks which origin_kind rows the upstream list should return.
  // 'all' = no filter (server default); 'tenant'|'project'|'workflow' =
  // ?origin=<value> forwarded to upstream.
  type OriginFilter = 'all' | 'tenant' | 'project' | 'workflow';
  let originFilter = $state<OriginFilter>('all');

  // ---------------------------------------------------------------------------
  // Which types can actually be filtered by origin.
  //
  // This control used to render for all 8 types in TYPE_TO_SLUG, while
  // /api/assets/channels was the only route that applied `?origin=` at all. On
  // the other 7 the buttons were inert: the param was dropped somewhere on the
  // way down and the response was a 200 carrying the whole unfiltered list, so
  // clicking Tenant/Project/Automation changed nothing and nothing said so.
  //
  // Three of those were fixed in the backend rather than hidden, because
  // their upstream has a real origin_kind column that is declared and applied:
  // requirement / principle / decision. The remaining
  // three cannot be fixed that way:
  //
  //   * workflow — `WorkflowRow` (routes/assets/workflows.ts) is {id, title};
  //     the handler never reads `origin`, and n8n has no origin_kind concept to
  //     shape in. Plumbing it is real work, not a parse fix.
  //   * trigger  — `TriggerRow` (routes/assets/triggers.ts) is {id, title,
  //     project_id, dept_id}; same story.
  //   * kag_document — dropped TWICE: the route never reads `origin`, and
  //     `buildListKagDocumentsUrl` (integrations/kag.ts) is an explicit
  //     allowlist that emits only limit/offset/project_id, so the key could not
  //     reach the wire even if it were parsed.
  //
  // Hiding a control the user can see today is deliberate. A button that
  // silently lies about having filtered is worse than one that is not offered:
  // the inert version is indistinguishable from "this tenant has no such rows".
  // Re-add a type here only once its backend genuinely applies the filter.
  const ORIGIN_FILTER_TYPES: ReadonlySet<AssetType> = new Set<AssetType>([
    'requirement',
    'principle',
    'decision',
    'channel',
  ]);

  // Channels are never project-scoped: `CHANNEL_ORIGINS` in
  // routes/assets/channels.ts is ['tenant', 'workflow'], and the route answers
  // a hard 400 for ?origin=project. Offering the button guaranteed a red error
  // banner for anyone who clicked it, so the option is not offered.
  const ORIGIN_VALUES: ReadonlyArray<[OriginFilter, string]> = [
    ['all', 'All'],
    ['tenant', 'Tenant'],
    ['project', 'Project'],
    ['workflow', 'Automation'],
  ];
  const originValuesFor = (
    t: AssetType | null,
  ): ReadonlyArray<[OriginFilter, string]> =>
    !t || !ORIGIN_FILTER_TYPES.has(t)
      ? []
      : t === 'channel'
        ? ORIGIN_VALUES.filter(([v]) => v !== 'project')
        : ORIGIN_VALUES;

  async function loadList(t: AssetType): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const slug = TYPE_TO_SLUG[t];
      const params = new URLSearchParams();
      const ctx = scopeContext.current;
      if (ctx.kind === 'project') params.set('project_id', ctx.project_id);
      if (ctx.kind === 'department') params.set('dept_id', ctx.dept_id);
      if (originFilter !== 'all') params.set('origin', originFilter);
      const qs = params.toString();
      const items = await assetFetch<Record<string, unknown>[]>(
        `/api/assets/${slug}${qs ? `?${qs}` : ''}`,
      );
      rows = (items ?? []).map(rowOf);
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
      rows = [];
    } finally {
      loading = false;
    }
  }

  async function loadDepartments(): Promise<void> {
    try {
      departments = await tenancy.listDepartments();
      departmentsUnreadable = null;
    } catch (err) {
      // Still non-fatal for the asset list — but no longer silent, and the
      // REASON is kept: without the flag, "no promotion targets" and "could not
      // ask for promotion targets" painted identical pixels; without the reason,
      // the retry advice beside it is a guess.
      departments = [];
      departmentsUnreadable = readFailureReason(err, 'department list read failed');
    }
  }

  async function loadAssignments(t: AssetType): Promise<void> {
    const ctx = scopeContext.current;
    const params = new URLSearchParams({ type: t });
    if (ctx.kind === 'department') {
      params.set('scope_kind', 'department');
      params.set('scope_id', ctx.dept_id);
    } else if (ctx.kind === 'project') {
      params.set('scope_kind', 'project');
      params.set('scope_id', ctx.project_id);
    } else {
      params.set('scope_kind', 'workspace');
    }
    try {
      const resp = await assetFetch<{
        data: { asset_id: string; link_kind: 'owns' | 'override' | 'block' }[];
      }>(`/api/assets/_assignments?${params.toString()}`);
      const m = new Map<string, 'owns' | 'override' | 'block'>();
      for (const r of resp?.data ?? []) {
        m.set(r.asset_id, r.link_kind);
      }
      assignmentLinkKind = m;
    } catch {
      assignmentLinkKind = new Map();
    }
  }

  // Clamp the origin filter to what the CURRENT type can honour.
  //
  // SvelteKit reuses this component across /library/<slug> navigations, so
  // `originFilter` survives a type change while the buttons re-render. Hiding
  // a control does not stop it filtering: `loadList` still reads the stale
  // value at :287. Without this, going from Requirements (Project selected) to
  // Channels would send ?origin=project — which channels answer with a 400 —
  // and the Project button is not rendered there, so the user would have no
  // way to clear the filter that is breaking the page. Same shape on the three
  // gated types, where a stale value would keep riding on requests that are
  // meant to carry none.
  //
  // Only ever writes 'all', and only when the current value is not 'all', so
  // it cannot feed itself.
  $effect(() => {
    const allowed = originValuesFor(assetType);
    if (originFilter !== 'all' && !allowed.some(([v]) => v === originFilter)) {
      originFilter = 'all';
    }
  });

  // Re-run on type change OR origin-filter change. originFilter is
  // forwarded as a query param to the upstream list, so a change has to
  // refetch — not just re-filter the client-side rows array.
  $effect(() => {
    void originFilter; // register reactivity
    if (assetType) {
      void loadList(assetType);
    }
  });

  onMount(() => {
    if (!assetType) {
      // Invalid type segment — surface explicitly instead of silently
      // bouncing to /library (which previously masked typos and dead
      // redirects landing here). The template branches on `assetType` so
      // the unknown-slug fallback renders directly.
      return;
    }
    void loadDepartments();
  });

  // ---------------------------------------------------------------------------
  // Selection helpers.
  // ---------------------------------------------------------------------------

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleAll(): void {
    if (selected.size === filteredRows.length) {
      selected = new Set();
      return;
    }
    selected = new Set(filteredRows.map((r) => r.id));
  }

  // ---------------------------------------------------------------------------
  // Action handlers.
  // ---------------------------------------------------------------------------

  async function bulkPromote(target: PromoteTarget): Promise<void> {
    if (!assetType || selected.size === 0) return;
    actionError = null;
    actionPending = true;
    const ids = Array.from(selected);
    try {
      await Promise.all(
        ids.map((id) => tenancy.promoteAsset(assetType, id, target)),
      );
      selected = new Set();
      // Refresh rows so source-scope chips reflect the promotion.
      await loadList(assetType);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionPending = false;
    }
  }

  async function promoteRow(
    row: AssetRow,
    target: PromoteTarget,
  ): Promise<void> {
    if (!assetType) return;
    actionError = null;
    actionPending = true;
    try {
      await tenancy.promoteAsset(assetType, row.id, target);
      await loadList(assetType);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionPending = false;
    }
  }

  async function overrideRow(row: AssetRow): Promise<void> {
    if (!assetType) return;
    const ctx = scopeContext.current;
    const sel: tenancy.ScopeSelector = {};
    if (ctx.kind === 'project') sel.project_id = ctx.project_id;
    else if (ctx.kind === 'department') sel.dept_id = ctx.dept_id;
    else return; // can't override at workspace scope.
    actionError = null;
    actionPending = true;
    try {
      // BY DESIGN: "Override here" with the same asset id for both
      // parent and candidate creates a scope-local shadow of the parent
      // asset (operators most commonly want this). Picking a different
      // candidate is a two-step flow today: promote the candidate to the
      // target scope, then override-with-it via the AG-UI action surface.
      await tenancy.overrideAsset(assetType, row.id, row.id, sel);
      await loadList(assetType);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionPending = false;
    }
  }

  async function blockRow(row: AssetRow): Promise<void> {
    if (!assetType) return;
    const ctx = scopeContext.current;
    const sel: tenancy.ScopeSelector = {};
    if (ctx.kind === 'project') sel.project_id = ctx.project_id;
    else if (ctx.kind === 'department') sel.dept_id = ctx.dept_id;
    else return;
    actionError = null;
    actionPending = true;
    try {
      await tenancy.blockAsset(assetType, row.id, sel);
      await loadList(assetType);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionPending = false;
    }
  }

  // ---------------------------------------------------------------------------
  // RBAC — three states, measured, never asserted.
  //
  // ⚠️ This block used to read `canPromoteWorkspace = $derived(true) //
  // backend authz validates`. It offered the button to everyone and let the
  // API hand back the 403; the UI asserted a capability it had never measured.
  // `canOverrideOrBlock` was derived from the SCOPE SHAPE alone, which answers
  // a different question ("is an override meaningful here?") than the one the
  // button implies ("may you?").
  //
  // What the backend actually gates on, per action (all four short-circuit on
  // workspace-admin first, then OR in one further arm):
  //   promote → workspace  : workspace-admin ONLY — routes/asset-scope/promote.ts:155.
  //                          No second arm, so the client's inputs are COMPLETE
  //                          and this capability is exact in both directions.
  //   promote → dept D     : ... OR dept-manager/admin of D — promote.ts:98-114 (`canPromoteToDept`).
  //   override|block @dept : ... OR dept-manager/admin of D — block.ts:100-101
  //                          (override.ts:224-225 is the same pair).
  //   override|block @proj : ... OR project membership, via
  //                          `getProjectMembershipProvider().getRole()` with a
  //                          `projects.owner_id` fallback — block.ts:52-67, called at :109-110
  //                          (override.ts:174 / :234-235).
  //
  // ⛔ That last arm has NO client-visible surface anywhere in the API — there
  // is no endpoint that tells this user their role in a project. So at project
  // scope a non-admin is `unknown`, NEVER `denied`: the control stays offered
  // and says so, rather than being hidden from a project member who may
  // legitimately use it. Fixing that needs a backend capability field; it is
  // reported, not invented here.
  // ---------------------------------------------------------------------------

  const ctxKind = $derived(scopeContext.current.kind);

  /**
   * Workspace-admin of the ACTIVE workspace, read from the same `user_roles`
   * grant the backend gate reads (`/api/me/workspaces` → `workspaces.active.role`),
   * plus the Keycloak-claim arm `isWorkspaceAdminVia` checks first.
   * `unknown` while the workspace list is cold or its read failed.
   */
  const workspaceAdmin = $derived(
    workspaceAdminCapability({
      loaded: workspaces.loaded,
      error: workspaces.error,
      activeRole: workspaces.active?.role,
      claimRoles: auth.user?.roles,
    }),
  );

  /** The dept arm, for the dept the current scope points at. */
  const deptArm = $derived(
    ctxKind === 'department'
      ? deptManagerArm(auth.deptRoles[scopeContext.deptId() ?? ''])
      : ('unknown' as Capability),
  );

  // Exact: promote.ts:155 has no arm other than isWorkspaceAdmin.
  const canPromoteWorkspace = $derived<Capability>(workspaceAdmin);

  // Promotion targets the FIRST department (row menu) / each department (bulk
  // bar), so the arm is keyed on that dept, not on the current scope.
  const canPromoteDept = $derived<Capability>(
    departments.length === 0
      ? // STRUCTURAL, not an authz verdict: there is no target to promote INTO,
        // so no permission question arises. When the list is empty because the
        // READ failed, that is a different fact — and it is already named by
        // the `departments-unreadable` notice below rather than folded in here,
        // because a permission caveat would point at the wrong cause.
        'denied'
      : anyOf(workspaceAdmin, deptManagerArm(auth.deptRoles[departments[0]!.id])),
  );

  const canOverrideOrBlock = $derived<Capability>(
    ctxKind === 'workspace'
      ? // Structural, not authz: overrideRow()/blockRow() return early at
        // workspace scope because an override needs a narrower scope to live
        // in. The backend would 400 on a body carrying neither selector.
        'denied'
      : anyOf(workspaceAdmin, deptArm),
  );

  /**
   * At least one control is offered on a capability we could not confirm.
   * Offered ≠ promised: the banner is what keeps `unknown` from rendering as
   * `permitted`. `denied` controls are disabled instead and get no banner.
   */
  const capabilityUnverified = $derived(
    canPromoteWorkspace === 'unknown' ||
      canPromoteDept === 'unknown' ||
      canOverrideOrBlock === 'unknown',
  );

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle($page.url.pathname, assetType ? TYPE_LABEL_PLURAL[assetType] : null);
  });
</script>

<section class="p-6 space-y-4" data-testid="library-type-page">
  <header class="mb-6 space-y-1">
    <CockpitBackLink />
    <h1 class="text-2xl font-semibold tracking-tight" data-testid="library-type-title">
      {assetType ? TYPE_LABEL_PLURAL[assetType] : 'Unknown library section'}
    </h1>
    {#if assetType}
      <p class="text-sm text-[var(--color-text-muted)] max-w-2xl">
        {ASSET_EXPLAINERS[assetType].what}
      </p>
    {:else}
      <p
        class="text-sm text-[var(--color-text-muted)] max-w-2xl"
        data-testid="library-unknown-slug"
      >
        "{rawType}" is not a known library section. Every asset type has its
        own row in the sidebar's Knowledge section.
      </p>
    {/if}
  </header>

  {#if !loading && rows.length > 0}
    <ScopeFilter
      selected={filterKind}
      counts={filterCounts}
      onChange={(v) => {
        filterKind = v;
        if ((v === 'overrides' || v === 'blocked') && assetType) {
          void loadAssignments(assetType);
        }
      }}
    />
  {/if}

  <!-- Binding-aware Origin filter. Orthogonal to the 4D-asset ScopeFilter
       above — this picks the row's origin_kind (where it was created)
       and forwards as ?origin=<value> to upstream. 'All' = no filter.

       Rendered ONLY for the types whose backend actually applies the filter
       (see ORIGIN_FILTER_TYPES above). On workflows / triggers / knowledge
       documents these buttons were inert and said nothing about it. -->
  {#if assetType && ORIGIN_FILTER_TYPES.has(assetType)}
    <div
      class="flex items-center gap-2 my-2 text-xs"
      data-testid="origin-filter"
    >
      <span class="text-[var(--color-text-muted)]">Origin:</span>
      {#each originValuesFor(assetType) as [v, label]}
        <button
          type="button"
          onclick={() => (originFilter = v)}
          class={originFilter === v
            ? 'px-2 py-0.5 rounded bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] font-medium'
            : 'px-2 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'}
          data-testid="origin-filter-{v}"
          aria-pressed={originFilter === v}
        >{label}</button>
      {/each}
    </div>
  {/if}

  {#if selected.size > 0}
    <div
      class="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface)] p-2"
      data-testid="bulk-action-bar"
    >
      <span class="text-sm text-[var(--color-text-muted)]">
        {selected.size} selected
      </span>
      <button
        type="button"
        class="h-8 px-3 text-sm font-medium rounded-[var(--radius-sm)] bg-[var(--color-accent)] text-[var(--color-on-primary)] disabled:opacity-50"
        data-testid="bulk-promote-workspace"
        disabled={actionPending || canPromoteWorkspace === 'denied'}
        title={canPromoteWorkspace === 'denied'
          ? 'Requires the workspace-admin role in this workspace.'
          : canPromoteWorkspace === 'unknown'
            ? 'Your role in this workspace could not be read — this may be rejected.'
            : undefined}
        onclick={() => bulkPromote('workspace')}
      >
        Promote selected to Workspace
      </button>
      {#if departmentsState === 'unreadable'}
        <span
          class="self-center text-xs text-[var(--color-warning-text)]"
          data-testid="departments-unreadable"
          title={`Department list read failed — ${departmentsUnreadable}`}
        >
          Department list unreadable — this workspace is NOT known to have no
          departments. Promotion targets are missing because the read failed, not
          because there are none. Retry before concluding anything.
          <span class="font-mono text-[var(--color-text-muted)]">({departmentsUnreadable})</span>
        </span>
      {/if}
      {#each departments as dept (dept.id)}
        <button
          type="button"
          class="h-8 px-3 text-sm font-medium rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] text-[var(--color-text)] disabled:opacity-50"
          data-testid={`bulk-promote-dept-${dept.id}`}
          disabled={actionPending ||
            anyOf(workspaceAdmin, deptManagerArm(auth.deptRoles[dept.id])) ===
              'denied'}
          onclick={() => bulkPromote({ dept_id: dept.id })}
        >
          Promote to Department: {dept.name}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Three states, three renderings. `permitted` gets a plain enabled
       button; `denied` gets a disabled one with no handler; `unknown` gets an
       enabled button AND this banner, so the control is still reachable for
       whoever may legitimately use it without the page implying it will work.
       Silently rendering `unknown` as either of the other two is the defect
       this page was carrying. -->
  {#if capabilityUnverified && !loading && filteredRows.length > 0}
    <div
      class="rounded-[var(--radius-sm)] bg-[var(--color-warning-bg)] border border-[var(--color-warning-border)] px-3 py-2 text-xs text-[var(--color-warning-text)]"
      data-testid="capability-unverified"
      role="status"
    >
      Your permission for one or more of these actions could not be confirmed —
      they are offered, but the server may still reject them.
      {#if ctxKind === 'project'}
        Project membership is not readable from this page, so Override / Block
        cannot be checked here.
      {/if}
    </div>
  {/if}

  {#if actionError}
    <div
      class="rounded-[var(--radius-sm)] bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-3 py-2 text-sm text-[var(--color-danger)]"
      data-testid="library-action-error"
      role="alert"
    >
      {actionError}
    </div>
  {/if}

  {#if loading}
    <ul class="space-y-2" data-testid="library-loading">
      {#each Array.from({ length: 4 }, (_, i) => i) as i (i)}
        <li
          class="h-12 rounded-[var(--radius-sm)] bg-[var(--color-surface)] animate-pulse"
        ></li>
      {/each}
    </ul>
  {:else if loadError}
    <div
      class="rounded-[var(--radius-sm)] bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-3 py-2 text-sm text-[var(--color-danger)]"
      data-testid="library-load-error"
    >
      {loadError}
    </div>
  {:else if filteredRows.length === 0}
    {#if assetType}
      <AssetEmptyState type={assetType} />
    {:else}
      <div
        class="text-sm text-[var(--color-text-muted)]"
        data-testid="library-empty"
      >
        No items in scope.
      </div>
    {/if}
  {:else}
    <table
      class="w-full text-sm border-separate border-spacing-y-1"
      data-testid="library-table"
    >
      <thead>
        <tr class="text-left text-xs uppercase text-[var(--color-text-muted)]">
          <th class="w-8 px-2">
            <input
              type="checkbox"
              data-testid="library-select-all"
              aria-label="Select all"
              checked={selected.size === filteredRows.length &&
                filteredRows.length > 0}
              onchange={toggleAll}
            />
          </th>
          <th class="w-8 px-2">Scope</th>
          <th class="px-2">Title</th>
          <th class="px-2">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each filteredRows as row (row.id)}
          <tr
            class="bg-[var(--color-surface)] hover:bg-[var(--color-surface-strong)]"
            data-testid={`library-row-${row.id}`}
          >
            <td class="px-2 py-2 align-middle">
              <input
                type="checkbox"
                data-testid={`library-select-${row.id}`}
                aria-label={`Select ${row.title}`}
                checked={selected.has(row.id)}
                onchange={() => toggle(row.id)}
              />
            </td>
            <td class="px-2 py-2 align-middle">
              <ScopePill scope={row.scope} />
            </td>
            <td class="px-2 py-2 align-middle font-medium">
              {#if assetType === 'workflow'}
                <a
                  href="/workflows/{row.id}"
                  class="hover:text-[var(--color-accent)] hover:underline"
                  data-testid={`library-row-link-${row.id}`}
                >{row.title}</a>
              {:else}
                {row.title}
              {/if}
            </td>
            <td class="px-2 py-2 align-middle">
              <!-- `cap !== 'denied'` is the offer test, not `cap ===
                   'permitted'`: `unknown` must stay reachable (the banner
                   above carries the caveat), while `denied` loses both the
                   flag AND the handler so the button is inert, not merely
                   styled. `row.scope` / `departments.length` remain
                   STRUCTURAL gates — an asset already at workspace scope has
                   nowhere to be promoted to, which is not a permission fact
                   and must not be mistaken for one. -->
              <PromoteOverrideBlockMenu
                canPromoteWorkspace={canPromoteWorkspace !== 'denied' &&
                  row.scope !== 'workspace'}
                canPromoteDept={canPromoteDept !== 'denied' &&
                  row.scope === 'project'}
                canOverride={canOverrideOrBlock !== 'denied'}
                canBlock={canOverrideOrBlock !== 'denied'}
                onPromoteWorkspace={canPromoteWorkspace !== 'denied'
                  ? () => promoteRow(row, 'workspace')
                  : undefined}
                onPromoteDept={departments.length > 0 &&
                canPromoteDept !== 'denied'
                  ? () =>
                      promoteRow(row, { dept_id: departments[0]!.id })
                  : undefined}
                onOverride={canOverrideOrBlock !== 'denied'
                  ? () => overrideRow(row)
                  : undefined}
                onBlock={canOverrideOrBlock !== 'denied'
                  ? () => blockRow(row)
                  : undefined}
              />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>
