<!--
  /reports/project-status/[projectId] — GET /api/reports/project-status/:projectId

  Backend: backend/src/routes/reports/index.ts:38 -> { data: ProjectStatus }
  (domain/reporting/index.ts:71). Four independent sections come back together:
  the project row, its open approvals, recent decisions, and per-list card counts.

  `boardProgress: null` is NOT an empty board — the domain returns null when the
  project has no planka_board_id, so the kanban half was never attempted. Those
  two are rendered differently on purpose; collapsing them would report "0 cards"
  for a project that simply has no board.

  A cross-tenant or unknown projectId 404s identically (no existence leak), so
  the error state says exactly that rather than guessing which one it was.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { getProjectStatus, type ProjectStatus } from '$lib/api/reports';
  import ReportPanel from '$lib/components/reports/ReportPanel.svelte';
  import EntityRef from '$lib/components/ui/EntityRef.svelte';
  import { humanizeEnum } from '$lib/utils/humanizeEnum';

  const projectId = $derived($page.params.projectId ?? '');

  let data = $state<ProjectStatus | undefined>(undefined);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);

  async function load(id: string): Promise<void> {
    loading = true;
    error = undefined;
    try {
      data = await getProjectStatus(id);
    } catch (e) {
      data = undefined;
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // Re-runs when the route param changes, so navigating between two project
  // reports refetches instead of showing the previous project's numbers.
  $effect(() => {
    if (projectId) void load(projectId);
  });

  function projectName(p: Record<string, unknown> | null | undefined): string {
    const n = p?.name ?? p?.title;
    return typeof n === 'string' && n.length > 0 ? n : projectId;
  }

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  // Populated iff at least one of the four sections has something to show. A
  // project that exists but has no approvals, no decisions and no board is a
  // real, reportable EMPTY result — not an error.
  // Null-safe section views. `data` is reset to undefined when a reload fails,
  // and Svelte 5 can re-run the expressions inside `{#if data}` with that value
  // before the block tears down — so the markup reads these, never `data.x`.
  const openApprovals = $derived(data?.openApprovals ?? []);
  const recentDecisions = $derived(data?.recentDecisions ?? []);
  const boardProgress = $derived(data?.boardProgress ?? null);

  const isEmpty = $derived(
    !data ||
      (!data.project &&
        data.openApprovals.length === 0 &&
        data.recentDecisions.length === 0 &&
        data.boardProgress === null),
  );

  const h2 = 'mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]';
  const th =
    'border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]';

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle($page.url.pathname, data ? projectName(data.project) : null);
  });
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-4">
    <nav aria-label="Breadcrumb" class="text-xs text-[var(--color-text-muted)]">
      <a href="/reports" class="hover:underline">Reports</a>
      <span class="mx-1">/</span>
      <span>Project status</span>
    </nav>
    <div class="mt-1 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-[var(--color-text)]">
          {data ? projectName(data.project) : 'Project status'}
        </h1>
        <p class="mt-1 font-mono text-xs text-[var(--color-text-muted)]">{projectId}</p>
      </div>
      <button
        type="button"
        onclick={() => void load(projectId)}
        class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
      >
        Refresh
      </button>
    </div>
  </header>

  <ReportPanel
    label="this project's status"
    {loading}
    {error}
    empty={isEmpty}
    emptyMessage="This project has no open approvals, no recorded decisions and no linked board, so there is nothing to report yet."
    onRetry={() => void load(projectId)}
  >
    {#if data}
      <section class="mb-6">
        <h2 class={h2}>Open approvals ({openApprovals.length})</h2>
        {#if openApprovals.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]">No approvals are open on this project.</p>
        {:else}
          <table class="w-full table-auto border-collapse text-sm">
            <thead>
              <tr class={th}>
                <th class="py-2 pr-4">Description</th>
                <th class="py-2 pr-4">Role</th>
                <th class="py-2 pr-4">Status</th>
                <th class="py-2 pr-4">Expires</th>
              </tr>
            </thead>
            <tbody>
              {#each openApprovals as a (a.id)}
                <tr class="border-b border-[var(--color-border)] align-top">
                  <td class="py-2 pr-4 font-medium text-[var(--color-text)]">{a.description}</td>
                  <td class="py-2 pr-4 text-[var(--color-text-muted)]">{a.role ?? '—'}</td>
                  <td class="py-2 pr-4 text-[var(--color-text-muted)]">{a.status}</td>
                  <td class="py-2 pr-4 whitespace-nowrap text-[var(--color-text-muted)]">
                    {fmtDate(a.expires_at)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>

      <section class="mb-6">
        <h2 class={h2}>Recent decisions ({recentDecisions.length})</h2>
        {#if recentDecisions.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]">
            Nothing has been decided on this project yet.
          </p>
        {:else}
          <table class="w-full table-auto border-collapse text-sm">
            <thead>
              <tr class={th}>
                <th class="py-2 pr-4">Decision</th>
                <th class="py-2 pr-4">Approver</th>
                <th class="py-2 pr-4">When</th>
                <th class="py-2 pr-4">Comment</th>
              </tr>
            </thead>
            <tbody>
              {#each recentDecisions as d (d.approval_id)}
                <tr class="border-b border-[var(--color-border)] align-top">
                  <td class="py-2 pr-4 font-medium text-[var(--color-text)]">{humanizeEnum(d.decision)}</td>
                  <td class="py-2 pr-4 text-xs text-[var(--color-text-muted)]" data-testid="decision-approver">
                    <EntityRef id={d.approver_id} name={d.approver_name ?? null} kind="user" />
                  </td>
                  <td class="py-2 pr-4 whitespace-nowrap text-[var(--color-text-muted)]">
                    {fmtDate(d.decided_at)}
                  </td>
                  <td class="py-2 pr-4 text-[var(--color-text-muted)]">{d.comment ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>

      <section>
        <!-- ⚠️ "Cards per board list", NOT "Board progress". A per-list card
             count has no done/total: the board's lists are Readying · Doing ·
             Inspecting · Publishing and nothing here says how many cards the
             project is SUPPOSED to have, so no fraction and no percentage is
             derivable. Calling it progress invited the reader to compute one.
             ⚠️ CORRECTED: this used to say "the counts themselves are now
             sound — domain/reporting/index.ts reads `board.included.lists` and
             `cards.items`". `cards.items` was the problem. `GET
             /api/lists/:id/cards` is CURSOR-paginated at 50 (measured on the
             running Planka 2.1.0 pod: `Card.js:9` `const LIMIT = 50`, no
             `total` and no `hasMore` in the response), so `items.length` was a
             PAGE SIZE rendered as a list total. Eleven live lists exceed 50;
             the largest holds 2,842. The domain now walks the cursor and
             reports THREE states, rendered distinctly below. The rethrow-on-
             total-failure is still right and is not what changed. -->
        <h2 class={h2}>Cards per board list</h2>
        {#if boardProgress === null}
          <p data-testid="no-board" class="text-sm text-[var(--color-text-muted)]">
            This project has no linked Kanban board, so no card counts were read.
          </p>
        {:else if boardProgress.lists.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]">
            The linked board has no lists yet.
          </p>
        {:else}
          <ul class="flex flex-wrap gap-2">
            {#each boardProgress.lists as l (l.id)}
              <li
                class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              >
                <span class="text-[var(--color-text-muted)]">{l.name}</span>
                <!-- ⛔ THREE STATES, THREE RENDERS. `cardCount: null` means the
                     list could not be read — it must NOT reach a number slot.
                     A bare `{l.cardCount}` prints nothing for null, which reads
                     as a rendering glitch rather than as "unknown"; printing 0
                     would be worse still, since 0 is a real answer this read
                     never obtained. `complete:false` is the separate fact that
                     the list is LONGER than we counted — "N+", not "N". -->
                {#if l.cardCount === null || l.cardCount === undefined}
                  <span
                    class="ml-2 font-semibold text-[var(--color-text-muted)]"
                    data-testid="board-count-unread"
                    title="This list could not be read. Its card count is unknown — this is not a count of zero."
                    >— not readable</span
                  >
                {:else}
                  <span
                    class="ml-2 font-semibold text-[var(--color-text)]"
                    data-testid="board-count"
                    title={l.cardCountComplete === false
                      ? 'At least this many — the count walk did not reach the end of the list'
                      : undefined}
                    >{l.cardCount}{l.cardCountComplete === false ? '+' : ''}</span
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </ReportPanel>
</div>
