<!--
  /reports — the reporting surface index.

  Two distinct things live on this page, and conflating them was the risk:

   1. Parameterised live reports — two of the four COMPOSED reports
      (backend/src/routes/reports/index.ts) need an id the caller must supply,
      so this page's job is to take that id and route to the detail view.
      Approval backlog takes no id and asset changes takes one of four fixed
      asset types: both are sidebar rows (Govern), not forms here.

   2. "Stored reports" — rows in `project_reports`, pushed into FR by n8n
      (handleN8nReport). These are documents, not computations.

-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { listReports, type ProjectReport } from '$lib/api/reports';
  import ReportPanel from '$lib/components/reports/ReportPanel.svelte';

  let rows = $state<ProjectReport[]>([]);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);

  // Parameterised-report launchers. There is no backend endpoint that lists
  // reportable project/worker ids, so these are free-text rather than pickers —
  // inventing a picker would mean inventing its data source.
  let projectId = $state('');
  let workerId = $state('');

  async function refresh(): Promise<void> {
    loading = true;
    error = undefined;
    try {
      rows = await listReports();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  function openProjectStatus(e: SubmitEvent): void {
    e.preventDefault();
    const id = projectId.trim();
    if (id) void goto(`/reports/project-status/${encodeURIComponent(id)}`);
  }
  function openWorkerActivity(e: SubmitEvent): void {
    e.preventDefault();
    const id = workerId.trim();
    if (id) void goto(`/reports/worker-activity/${encodeURIComponent(id)}`);
  }

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  const inputCls =
    'h-9 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]';
  const goCls =
    'h-9 shrink-0 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent-fg)] hover:opacity-90';
  const cardCls =
    'rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4';
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-6">
    <h1 class="text-2xl font-semibold text-[var(--color-text)]">Reports</h1>
    <p class="mt-1 text-sm text-[var(--color-text-muted)]">
      Read-only views over approvals, project execution, worker activity and asset history.
      Everything here is computed when you open it — nothing is scheduled or sent.
    </p>
  </header>

  <!--
    Nav standard (fr#1331, 2026-10-03): no launcher links here. The approval
    backlog is a fixed page, so it is a sidebar row (Govern → "Approval
    backlog") and its link card is gone. Asset changes had a <select> over a
    FIXED list of four asset types — a dropdown menu — so each type is now a
    row in the rail's "Asset changes" sub-group and that card is gone too.
    What remains are INPUT forms, not a menu: the two parameterised reports
    need an id the rail cannot know (there is no endpoint that lists
    reportable project/worker ids), and these forms are their only entry
    point — removing them would delete the feature.
  -->
  <section class="mb-8">
    <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
      Open a parameterised report
    </h2>
    <div class="grid gap-3 sm:grid-cols-2">
      <div class={cardCls}>
        <h3 class="text-sm font-medium text-[var(--color-text)]">Project status</h3>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">
          Open approvals, recent decisions and board progress for one project.
        </p>
        <form class="mt-3 flex gap-2" onsubmit={openProjectStatus}>
          <input
            class={inputCls}
            bind:value={projectId}
            placeholder="Project id (UUID)"
            aria-label="Project id"
          />
          <button type="submit" class={goCls}>Go</button>
        </form>
      </div>

      <div class={cardCls}>
        <h3 class="text-sm font-medium text-[var(--color-text)]">Worker activity</h3>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">
          A worker's state transitions projected as an activity stream.
        </p>
        <form class="mt-3 flex gap-2" onsubmit={openWorkerActivity}>
          <input
            class={inputCls}
            bind:value={workerId}
            placeholder="Worker id or name"
            aria-label="Worker id"
          />
          <button type="submit" class={goCls}>Go</button>
        </form>
      </div>
    </div>
  </section>

  <section>
    <div class="mb-3 flex items-center justify-between gap-4">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Stored reports
      </h2>
      <button
        type="button"
        onclick={() => void refresh()}
        class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
      >
        Refresh
      </button>
    </div>

    <ReportPanel
      label="stored reports"
      {loading}
      {error}
      empty={rows.length === 0}
      emptyMessage="No stored reports for this workspace yet. Reports appear here once a workflow pushes one into fr."
      onRetry={() => void refresh()}
    >
      <table class="w-full table-auto border-collapse text-sm">
        <thead>
          <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <th class="py-2 pr-4">Type</th>
            <th class="py-2 pr-4">Title</th>
            <th class="py-2 pr-4">Summary</th>
            <th class="py-2 pr-4">Created</th>
            <th class="py-2 pr-4"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.id)}
            <tr class="border-b border-[var(--color-border)] align-top">
              <td class="py-2 pr-4">
                <span class="rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
                  {r.report_type}
                </span>
              </td>
              <td class="py-2 pr-4 font-medium text-[var(--color-text)]">{r.title}</td>
              <td class="py-2 pr-4 text-[var(--color-text-muted)]">{r.summary}</td>
              <td class="py-2 pr-4 whitespace-nowrap text-[var(--color-text-muted)]">
                {fmtDate(r.created_at)}
              </td>
              <td class="py-2 pr-4">
                <a
                  href={`/reports/${encodeURIComponent(r.id)}`}
                  class="text-xs text-[var(--color-accent)] hover:underline">View</a
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </ReportPanel>
  </section>
</div>
