<!--
  /admin/assets/projects — list view for projects.

  Projects has no tenant_id column in the DB. Scope rule (enforced by
  the backend, surfaced for clarity):
    - active workspace = system + super-admin → fleet view (all projects)
    - any other workspace → scope by owner_id (your own projects)
  is_system is always false — projects aren't inherited.

  Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md §Frontend
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { listAdminProjects, type AdminProject } from '$lib/api/admin-assets';
  import AssetFormDrawer from '$lib/components/AssetFormDrawer.svelte';
  import EntityRef from '$lib/components/ui/EntityRef.svelte';
  // The shared three-state repository reader. See its header for why sharing is
  // correct here and what the `none` / `unknown` split is protecting.
  import { readProjectRepoView } from '$lib/projects/repo-view';

  let rows = $state<AdminProject[]>([]);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);
  let drawerMode = $state<'create' | 'edit' | 'view' | undefined>(undefined);
  let drawerRow = $state<AdminProject | undefined>(undefined);

  async function refresh(): Promise<void> {
    loading = true;
    error = undefined;
    try {
      rows = await listAdminProjects();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    if (!workspaces.loaded) await workspaces.load();
    await refresh();
  });

  let lastActiveId = $state<string | undefined>(undefined);
  $effect(() => {
    const cur = workspaces.activeId;
    if (cur && cur !== lastActiveId) {
      lastActiveId = cur;
      void refresh();
    }
  });

  function pickField(p: AdminProject, ...keys: string[]): string {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }
  function rowKey(p: AdminProject): string {
    return pickField(p, 'id');
  }

  // ── REPOSITORY COUNT: a project can have several (unit F2) ───────────────────
  //
  // ⭐ THE DEFECT. The Repository column printed `repository_url` alone — the
  // DENORMALISED PRIMARY cache of whichever `project_repositories` row is flagged
  // `is_primary` (migration 072). In an operator table that is worse than on a
  // customer card: a fleet view of projects showed one repository per row with no
  // hint that a row might stand for three, so nothing in the console could ever
  // reveal a multi-repo project.
  //
  // The three-state reading lives in `$lib/projects/repo-view.ts`, shared with
  // `/projects` and `/projects/[id]/settings`. What stays here is PRESENTATION,
  // because this column shows a NUMBER rather than a list:
  //
  //   listed                  → the total, plus the rows so the extras are reachable
  //   none                    → "none attached"
  //   unknown + a declared
  //     `repo_count`          → STILL A NUMBER. `AdminProject` is
  //                             `Record<string, unknown>` and this admin route is
  //                             not the endpoint the `repositories` contract was
  //                             added to, so a bare `repo_count` is the likely
  //                             case here, not an edge. "4 repositories" is what
  //                             the server said; it just did not enumerate them.
  //   unknown, anything else  → SAY SO. Printing "1" would be the original defect
  //                             restated as a number, and printing "0" would be
  //                             fr#1259's class — an absence rendered as a result.
  //
  // ⛔ A CONTRADICTION IS NOT THE COUNT-ONLY CASE. An empty array beside a
  // positive `repo_count` means the response disagrees with itself, so the number
  // is not trustworthy either and this column must fall through to "not reported".
  // That is why the branch below tests `reason`, not just `declaredCount`.
  type RepoCount =
    | { kind: 'counted'; total: number; named: string[] }
    | { kind: 'none' }
    | { kind: 'unknown' };

  function repoCount(p: AdminProject): RepoCount {
    const view = readProjectRepoView(p);
    if (view.kind === 'listed') {
      // Ordered primary-first by the reader, which is load-bearing here: the cell
      // reads "primary + N more" and the extras are `named.slice(1)`.
      return {
        kind: 'counted',
        total: view.total,
        named: view.rows.map((r) => r.url || r.name || '').filter((label) => label.length > 0),
      };
    }
    if (view.kind === 'none') return { kind: 'none' };
    if (view.reason === 'unreported' && view.declaredCount !== null && view.declaredCount > 0) {
      return { kind: 'counted', total: view.declaredCount, named: [] };
    }
    return { kind: 'unknown' };
  }
  function openRow(p: AdminProject): void {
    drawerRow = p;
    drawerMode = 'edit';
  }
  function closeDrawer(): void {
    drawerMode = undefined;
    drawerRow = undefined;
  }
  async function onSaved(): Promise<void> {
    closeDrawer();
    await refresh();
  }
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-4 flex items-start justify-between gap-4">
    <div>
      <nav aria-label="Breadcrumb" class="text-xs text-[var(--color-text-muted)]">
        <span>Administration</span>
        <span class="mx-1">/</span>
        <span>Platform projects</span>
      </nav>
      <h1 class="mt-1 text-2xl font-semibold text-[var(--color-text)]">Platform projects</h1>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        Active workspace:
        <span class="font-medium text-[var(--color-text)]">{workspaces.active?.name ?? '—'}</span>
        <span
          class="ml-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--color-text-muted)]"
          >{workspaces.active?.kind ?? '—'}</span
        >
        <span class="ml-2 text-xs italic">Create new projects from the <a class="text-[var(--color-accent)] hover:underline" href="/">workspace home</a>.</span>
      </p>
    </div>
    <button
      type="button"
      onclick={() => void refresh()}
      class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
    >
      Refresh
    </button>
  </header>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <p class="text-sm text-[var(--color-danger)]">Error: {error}</p>
  {:else if rows.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">No projects in this workspace.</p>
  {:else}
    <table class="w-full table-auto border-collapse text-sm">
      <thead>
        <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <th class="py-2 pr-4">Name</th>
          <th class="py-2 pr-4">Description</th>
          <th class="py-2 pr-4">Status</th>
          <th class="py-2 pr-4">Repository</th>
          <th class="py-2 pr-4">Owner</th>
          <th class="py-2 pr-4"></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as p (rowKey(p))}
          {@const repos = repoCount(p)}
          <tr class="border-b border-[var(--color-border)] align-top">
            <td class="py-2 pr-4 font-medium text-[var(--color-text)]">{pickField(p, 'name')}</td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">{pickField(p, 'description')}</td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">{pickField(p, 'status')}</td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)] text-xs">
              <!-- The primary, then HOW MANY there are. See `repoCount`. -->
              {#if pickField(p, 'repository_url')}
                <div class="break-all">{pickField(p, 'repository_url')}</div>
              {/if}
              {#if repos.kind === 'counted'}
                <div
                  class="mt-0.5 font-semibold text-[var(--color-text)]"
                  data-testid="admin-project-repo-count"
                  title={repos.named.join('\n')}
                >
                  {repos.total} {repos.total === 1 ? 'repository' : 'repositories'}{repos.total > 1
                    ? ` (primary + ${repos.total - 1} more)`
                    : ''}
                </div>
                {#if repos.named.length > 1}
                  <ul class="mt-0.5 space-y-0.5">
                    {#each repos.named.slice(1) as extra, i (`${extra}-${i}`)}
                      <li class="break-all text-[var(--color-text-muted)]" data-testid="admin-project-repo-extra">
                        {extra}
                      </li>
                    {/each}
                  </ul>
                {/if}
              {:else if repos.kind === 'none'}
                <div class="mt-0.5" data-testid="admin-project-repo-count">No repositories attached</div>
              {:else}
                <!-- Not reported. Neither "1" nor "0" has been earned. -->
                <div
                  class="mt-0.5 italic"
                  data-testid="admin-project-repo-count"
                  title="This response carried neither a repositories list nor a repo_count, so the number attached is unknown."
                >
                  Repository count not reported
                </div>
              {/if}
            </td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)] text-xs">
              <!--
                `pickField` returns '' when the key is absent, and EntityRef
                renders NOTHING for an empty id — same as the old `''.slice()`
                path, which printed a bare '…' and looked like a truncated value.
              -->
              <EntityRef id={pickField(p, 'owner_id')} kind="user" />
            </td>
            <td class="py-2 pr-4">
              <button
                type="button"
                onclick={() => openRow(p)}
                class="text-xs text-[var(--color-accent)] hover:underline"
              >
                Edit
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

{#if drawerMode}
  <AssetFormDrawer
    kind="projects"
    mode={drawerMode}
    record={drawerRow}
    onClose={closeDrawer}
    onSaved={onSaved}
  />
{/if}
