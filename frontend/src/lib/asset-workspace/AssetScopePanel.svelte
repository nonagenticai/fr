<!--
  AssetScopePanel.svelte

  The unified "Scope & Projects" surface for a single asset, rendered on the
  AssetDetail page when the manifest declares `scope`. Replaces the old
  /library/[type] tenancy lens (cramped per-row PromoteOverrideBlockMenu) with
  a per-asset panel:

    • Used in projects  — asset_bindings (assign-to-project). The authoritative
      project-scope signal n8n reads. Tenant-wide when empty.
    • Promote           — asset_assignments `owns` at workspace / department.
    • Advanced          — override / block this asset at a department/project.

  All mutations reuse the existing typed clients:
    $lib/api/bindings.ts  (bindAsset / unbindAsset / listAssetBindings)
    $lib/api/tenancy.ts   (promoteAsset / overrideAsset / blockAsset / listDepartments)

  `assetId` is the manifest's idField value (the route id) — for procedures
  that is the slug `name`, matching how create-time binding already keys.
-->
<script lang="ts">
  import {
    listAssetBindings,
    bindAsset,
    unbindAsset,
    type AssetKind,
    type AssetBinding,
  } from '$lib/api/bindings';
  import * as tenancy from '$lib/api/tenancy';
  import { authFetch } from '$lib/api/auth-fetch';
  import { rowFieldText } from './manifest';

  interface Props {
    assetKind: AssetKind;
    assetId: string;
    bindable?: boolean;
    promotable?: boolean;
    overridable?: boolean;
  }

  let {
    assetKind,
    assetId,
    bindable = true,
    promotable = true,
    overridable = true,
  }: Props = $props();

  interface ProjectRow {
    id: string;
    name: string;
  }

  let bindings = $state<AssetBinding[]>([]);
  let projects = $state<ProjectRow[]>([]);
  let departments = $state<tenancy.Department[]>([]);
  /**
   * The department read FAILED — distinct from a tenant that has none.
   *
   * ⚠️ The `.catch(() => [])` in `load()` existed so one dead upstream could not
   * blank the whole panel (bindings + projects are read from different
   * endpoints, and the outer catch sets `loadError` for those). That intent is
   * right and is kept. What was wrong is that it was SILENT: both promote and
   * override gate on `departments.length > 0`, so a failed read deleted the
   * department controls and the panel presented itself as complete. Per-input
   * flag, not a blank — the same shape as `projectsUnreadable` in
   * `AssetCreateScopePicker`.
   */
  let departmentsUnreadable = $state(false);

  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let actionPending = $state(false);
  let actionError = $state<string | null>(null);
  let actionMsg = $state<string | null>(null);

  // Add-project select + advanced override/block scope selectors.
  let addProjectId = $state('');
  let promoteDeptId = $state('');
  let overrideScopeKind = $state<'department' | 'project'>('department');
  let overrideDeptId = $state('');
  let overrideProjectId = $state('');

  /**
   * A project's display name, falling back to its id.
   *
   * ⛔ THE SAME DEFECT CLASS AS `relatedItemTitle` in AssetDetail.svelte, and
   * the worst-placed instance of it: this one renders DIRECTLY into an `<li>`.
   * This was `p?.name ?? id`, and `??` only skips `null`/`undefined`, so a
   * project whose `name` is `'   '` WINS the chain — the "Used in projects"
   * chip becomes a bare × button with no label, its `aria-label` becomes
   * `Remove from    `, and the assign/remove flash messages go blank too. A
   * binding that exists, presented as nothing, with the id it could have shown
   * sitting one rung down. Hence the remedy already proven in this PR: the
   * shared `rowFieldText` primitive, which counts a rung only if it is
   * non-empty AFTER trimming.
   *
   * ⚠️ REACHABLE, NOT OBSERVED — this closes a reachable state, it does not
   * fix a bug anyone has seen. Nothing PREVENTS a blank name: `name` is
   * validated `z.string().min(1)` on create, on PATCH and in the agui project
   * action with ZERO `.trim()` in that chain, and zod 3's `min(1)` counts
   * characters, so `'   '` passes; the column is plain `text NOT NULL` with no
   * CHECK on `name`; and `/api/projects` identity-maps the value through here.
   * Nothing has TRIGGERED it: 0 of 263 live projects have
   * `name <> btrim(name) OR btrim(name) = ''`.
   *
   * ⭐ The codebase already treats this as possible — `relationDirectory.ts`
   * trims `name`/`title` and DROPS rows whose label comes out blank.
   */
  const projectName = $derived((id: string): string => {
    const p = projects.find((x) => x.id === id);
    return rowFieldText({ name: p?.name }, 'name') || id;
  });

  /**
   * A department's display name, falling back to its id.
   *
   * ⛔ THE SAME DEFECT CLASS as `projectName` above, and the same remedy: the
   * shared `rowFieldText` primitive, which counts a rung only if it is
   * non-empty AFTER trimming, so `null`, `undefined`, `''` AND `'   '` all fall
   * through to the id. ⛔ `?? id` would NOT do this — `''` is not nullish and
   * would WIN the chain, which is exactly how `projectName` was wrong before.
   * Three consumers render this: the promote `<select>`, the override
   * `<select>`, and the promote flash (`Promoted to department: ….`).
   *
   * ⚠️ UNREACHABLE AGAINST LIVE DATA TODAY, which is why its test must SEED
   * departments instead of relying on a fixture: `fr.departments` has 0 rows,
   * and `departments.length > 0` is the only branch that renders either
   * `<select>`, so a test that stubs `listDepartments` to `[]` asserts
   * NOTHING here and cannot fail.
   */
  const departmentName = $derived((id: string): string => {
    const d = departments.find((x) => x.id === id);
    return rowFieldText({ name: d?.name }, 'name') || id;
  });

  const boundProjectIds = $derived(new Set(bindings.map((b) => b.project_id)));
  const unboundProjects = $derived(
    projects.filter((p) => !boundProjectIds.has(p.id)),
  );

  async function fetchProjects(): Promise<ProjectRow[]> {
    const res = await authFetch('/api/projects');
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: ProjectRow[] } | ProjectRow[];
    return Array.isArray(body) ? body : (body.items ?? []);
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    departmentsUnreadable = false;
    try {
      const [b, p, d] = await Promise.all([
        bindable
          ? listAssetBindings(assetKind, assetId)
          : Promise.resolve<AssetBinding[]>([]),
        fetchProjects(),
        promotable || overridable
          ? tenancy.listDepartments().then(
              (rows) => ({ rows, ok: true }),
              () => ({ rows: [] as tenancy.Department[], ok: false }),
            )
          : Promise.resolve({ rows: [] as tenancy.Department[], ok: true }),
      ]);
      bindings = b;
      projects = p;
      departments = d.rows;
      departmentsUnreadable = !d.ok;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Re-load when the asset identity changes (detail page navigated to a
  // sibling without a full remount, e.g. /decisions/A -> /decisions/B).
  //
  // ⚠️ Without this, the panel keeps showing the PREVIOUS asset's bindings,
  // projects and departments under the new asset's page — silently wrong,
  // not visibly broken, because `load()` never re-runs on a same-route nav.
  //
  // `lastLoadedKey` is a plain (non-$state) local, compared and reassigned
  // INSIDE the effect — same "last loaded key" guard shape as
  // `lastLoadedContainer` in ArchitectureView.svelte (plain local) and
  // `lastKind` in AssetPicker.svelte ($state local; not needed here since
  // nothing outside this effect reads the key). Do not read/write
  // bindings/projects/departments (state this effect's own `load()` call
  // writes) as a guard condition here — the effect must only react to the
  // assetKind/assetId props, or a self-write loop is possible. That shape
  // caused a real ~1,100 req/s poll storm in this codebase before.
  let lastLoadedKey = '';
  $effect(() => {
    const key = `${assetKind}:${assetId}`;
    if (key !== lastLoadedKey) {
      lastLoadedKey = key;
      void load();
    }
  });

  function flash(msg: string): void {
    actionMsg = msg;
    setTimeout(() => {
      if (actionMsg === msg) actionMsg = null;
    }, 4000);
  }

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    actionPending = true;
    actionError = null;
    actionMsg = null;
    try {
      await fn();
      flash(label);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      actionPending = false;
    }
  }

  async function addProject(): Promise<void> {
    const pid = addProjectId;
    if (!pid) return;
    await run(`Assigned to ${projectName(pid)}.`, async () => {
      await bindAsset(assetKind, assetId, [pid]);
      bindings = await listAssetBindings(assetKind, assetId);
      addProjectId = '';
    });
  }

  async function removeProject(projectId: string): Promise<void> {
    await run(`Removed from ${projectName(projectId)}.`, async () => {
      await unbindAsset(assetKind, assetId, projectId);
      bindings = await listAssetBindings(assetKind, assetId);
    });
  }

  async function promoteWorkspace(): Promise<void> {
    await run('Promoted to workspace (tenant-wide).', () =>
      tenancy.promoteAsset(assetKind, assetId, 'workspace'),
    );
  }

  async function promoteToDept(): Promise<void> {
    const dept = departments.find((d) => d.id === promoteDeptId);
    if (!dept) return;
    await run(`Promoted to department: ${departmentName(dept.id)}.`, () =>
      tenancy.promoteAsset(assetKind, assetId, { dept_id: dept.id }),
    );
  }

  function overrideSelector(): tenancy.ScopeSelector | null {
    if (overrideScopeKind === 'department') {
      return overrideDeptId ? { dept_id: overrideDeptId } : null;
    }
    return overrideProjectId ? { project_id: overrideProjectId } : null;
  }

  async function doOverride(): Promise<void> {
    const sel = overrideSelector();
    if (!sel) return;
    // Same id for parent + candidate creates a scope-local shadow of this
    // asset — the common "fork this here" case (mirrors the old lens).
    await run('Override created at the selected scope.', () =>
      tenancy.overrideAsset(assetKind, assetId, assetId, sel),
    );
  }

  async function doBlock(): Promise<void> {
    const sel = overrideSelector();
    if (!sel) return;
    await run('Asset blocked at the selected scope.', () =>
      tenancy.blockAsset(assetKind, assetId, sel),
    );
  }
</script>

<section
  class="mt-8 border border-[var(--color-border)] rounded-lg dark:border-[var(--color-border)]"
  data-testid="asset-scope-panel"
  data-asset-kind={assetKind}
>
  <header
    class="px-4 py-2 bg-[var(--color-surface)] text-sm font-semibold dark:bg-[var(--color-bg)]"
  >
    Scope &amp; Projects
  </header>

  <div class="p-4 space-y-5">
    {#if loading}
      <p class="text-sm text-[var(--color-text-muted)]">Loading scope…</p>
    {:else if loadError}
      <div
        class="rounded bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-3 py-2 text-sm text-[var(--color-danger)]"
        data-testid="scope-load-error"
      >
        {loadError}
      </div>
    {:else}
      {#if actionMsg}
        <div
          class="rounded bg-[var(--color-success-bg)] border border-[var(--color-success-border)] px-3 py-2 text-sm text-[var(--color-success-text)]"
          data-testid="scope-action-msg"
          role="status"
        >
          {actionMsg}
        </div>
      {/if}
      {#if actionError}
        <div
          class="rounded bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] px-3 py-2 text-sm text-[var(--color-danger)]"
          data-testid="scope-action-error"
          role="alert"
        >
          {actionError}
        </div>
      {/if}

      {#if bindable}
        <div data-testid="scope-projects">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
            Used in projects
          </h3>
          {#if bindings.length === 0}
            <p class="text-sm text-[var(--color-text-muted)]" data-testid="scope-tenant-wide">
              Tenant-wide — not pinned to a project. Any project can use it; n8n
              sees it everywhere.
            </p>
          {:else}
            <ul class="flex flex-wrap gap-2 mb-2">
              {#each bindings as b (b.project_id)}
                <li
                  class="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-success-bg)] text-[var(--color-success-text)] border border-[var(--color-success-border)] pl-3 pr-1.5 py-1 text-sm"
                  data-testid="scope-project-chip-{b.project_id}"
                >
                  {projectName(b.project_id)}
                  <button
                    type="button"
                    onclick={() => removeProject(b.project_id)}
                    disabled={actionPending}
                    aria-label={`Remove from ${projectName(b.project_id)}`}
                    title="Remove from this project"
                    class="rounded-full w-5 h-5 leading-none hover:bg-[var(--color-success-border)] disabled:opacity-50"
                    data-testid="scope-unbind-{b.project_id}"
                  >×</button>
                </li>
              {/each}
            </ul>
          {/if}

          {#if unboundProjects.length > 0}
            <div class="flex items-center gap-2">
              <select
                bind:value={addProjectId}
                disabled={actionPending}
                data-testid="scope-add-project-select"
                class="px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
              >
                <option value="">+ Add project…</option>
                {#each unboundProjects as p (p.id)}
                  <option value={p.id}>{projectName(p.id)}</option>
                {/each}
              </select>
              <button
                type="button"
                onclick={addProject}
                disabled={actionPending || !addProjectId}
                data-testid="scope-add-project-btn"
                class="px-3 py-1 text-sm rounded bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
              >Assign</button>
            </div>
          {:else if projects.length > 0}
            <p class="text-xs text-[var(--color-text-muted)]">
              Assigned to every project.
            </p>
          {/if}
        </div>
      {/if}

      {#if promotable}
        <div data-testid="scope-promote">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
            Promote
          </h3>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onclick={promoteWorkspace}
              disabled={actionPending}
              data-testid="scope-promote-workspace"
              class="px-3 py-1.5 text-sm rounded bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
            >Promote to workspace</button>

            {#if departmentsUnreadable}
              <span
                class="text-xs text-[var(--color-warning-text)]"
                data-testid="scope-departments-unreadable"
              >
                Department list unreadable — promotion and override targets are
                unknown, not absent. Retry.
              </span>
            {/if}
            {#if departments.length > 0}
              <select
                bind:value={promoteDeptId}
                disabled={actionPending}
                data-testid="scope-promote-dept-select"
                class="px-2 py-1.5 text-sm border border-[var(--color-border-strong)] rounded focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
              >
                <option value="">Department…</option>
                {#each departments as d (d.id)}
                  <option value={d.id}>{departmentName(d.id)}</option>
                {/each}
              </select>
              <button
                type="button"
                onclick={promoteToDept}
                disabled={actionPending || !promoteDeptId}
                data-testid="scope-promote-dept-btn"
                class="px-3 py-1.5 text-sm rounded bg-[var(--color-surface-strong)] text-[var(--color-text)] hover:opacity-90 disabled:opacity-50"
              >Promote to department</button>
            {/if}
          </div>
          <p class="text-xs text-[var(--color-text-muted)] mt-1">
            Makes this asset owned (tenant-wide or department-wide) so it
            inherits down to all child scopes.
          </p>
        </div>
      {/if}

      {#if overridable}
        <details data-testid="scope-advanced">
          <summary class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)] cursor-pointer select-none">
            Advanced: overrides &amp; blocks
          </summary>
          <div class="mt-3 space-y-2">
            <p class="text-xs text-[var(--color-text-muted)]">
              Override (fork a scope-local copy) or block (hide) this asset for
              a specific department or project.
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <select
                bind:value={overrideScopeKind}
                disabled={actionPending}
                data-testid="scope-override-kind"
                class="px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded dark:border-[var(--color-border-strong)]"
              >
                <option value="department">Department</option>
                <option value="project">Project</option>
              </select>

              {#if overrideScopeKind === 'department'}
                <select
                  bind:value={overrideDeptId}
                  disabled={actionPending}
                  data-testid="scope-override-dept"
                  class="px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded dark:border-[var(--color-border-strong)]"
                >
                  <option value="">Pick a department…</option>
                  {#each departments as d (d.id)}
                    <option value={d.id}>{departmentName(d.id)}</option>
                  {/each}
                </select>
              {:else}
                <select
                  bind:value={overrideProjectId}
                  disabled={actionPending}
                  data-testid="scope-override-project"
                  class="px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded dark:border-[var(--color-border-strong)]"
                >
                  <option value="">Pick a project…</option>
                  {#each projects as p (p.id)}
                    <option value={p.id}>{projectName(p.id)}</option>
                  {/each}
                </select>
              {/if}

              <button
                type="button"
                onclick={doOverride}
                disabled={actionPending || !overrideSelector()}
                data-testid="scope-override-btn"
                class="px-3 py-1 text-sm rounded border border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] disabled:opacity-50"
              >Override here</button>
              <button
                type="button"
                onclick={doBlock}
                disabled={actionPending || !overrideSelector()}
                data-testid="scope-block-btn"
                class="px-3 py-1 text-sm rounded border border-[var(--color-danger-border)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] disabled:opacity-50"
              >Block here</button>
            </div>
          </div>
        </details>
      {/if}
    {/if}
  </div>
</section>
