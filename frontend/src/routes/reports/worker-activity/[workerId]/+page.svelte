<!--
  /reports/worker-activity/[workerId] — GET /api/reports/worker-activity/:workerId?since=

  Backend: backend/src/routes/reports/index.ts:51 -> { data: WorkerActivity }
  (domain/reporting/index.ts:188). `events` are NOT a dedicated activity feed:
  the workers service exposes no /activity endpoint, so the adapter projects
  each row of /workers/{name}/states into an event (integrations/workers.ts:140).
  The page says so, because "activity" that is really "state transitions" would
  otherwise read as a gap in the data rather than a property of it.

  `since` is a real query param the backend honours, so it is a real control here.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { getWorkerActivity, type WorkerActivity } from '$lib/api/reports';
  import ReportPanel from '$lib/components/reports/ReportPanel.svelte';

  const workerId = $derived($page.params.workerId ?? '');

  let data = $state<WorkerActivity | undefined>(undefined);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);
  /** Bound to a date input; '' means "no cutoff", which is the backend default. */
  let since = $state('');

  async function load(id: string, sinceValue: string): Promise<void> {
    loading = true;
    error = undefined;
    try {
      data = await getWorkerActivity(
        id,
        sinceValue ? new Date(sinceValue).toISOString() : undefined,
      );
    } catch (e) {
      data = undefined;
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  // Only the param is tracked — `since` is applied on submit so typing a partial
  // date does not fire a request per keystroke.
  $effect(() => {
    if (workerId) void load(workerId, '');
  });

  function applySince(e: SubmitEvent): void {
    e.preventDefault();
    void load(workerId, since);
  }

  function workerName(w: Record<string, unknown> | null | undefined): string {
    const n = w?.name ?? w?.id;
    return typeof n === 'string' && n.length > 0 ? n : workerId;
  }

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle($page.url.pathname, data ? workerName(data.worker) : null);
  });
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-4">
    <nav aria-label="Breadcrumb" class="text-xs text-[var(--color-text-muted)]">
      <a href="/reports" class="hover:underline">Reports</a>
      <span class="mx-1">/</span>
      <span>Worker activity</span>
    </nav>
    <div class="mt-1 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-[var(--color-text)]">
          {data ? workerName(data.worker) : 'Worker activity'}
        </h1>
        <p class="mt-1 font-mono text-xs text-[var(--color-text-muted)]">{workerId}</p>
        <p class="mt-1 text-xs text-[var(--color-text-muted)]">
          Derived from the worker's state transitions — the workers service exposes no
          separate activity feed.
        </p>
      </div>
      <form class="flex items-end gap-2" onsubmit={applySince}>
        <label class="text-xs text-[var(--color-text-muted)]">
          Since
          <input
            type="date"
            bind:value={since}
            aria-label="Since date"
            class="mt-1 block h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]"
          />
        </label>
        <button
          type="submit"
          class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
        >
          Apply
        </button>
      </form>
    </div>
  </header>

  <ReportPanel
    label="this worker's activity"
    {loading}
    {error}
    empty={!data || data.events.length === 0}
    emptyMessage="No state transitions recorded for this worker in the selected window. Widen or clear the 'since' date to see older activity."
    onRetry={() => void load(workerId, since)}
  >
    {#if data}
      <table class="w-full table-auto border-collapse text-sm">
        <thead>
          <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
            <th class="py-2 pr-4">When</th>
            <th class="py-2 pr-4">Status</th>
            <th class="py-2 pr-4">Detail</th>
          </tr>
        </thead>
        <tbody>
          <!-- `data?.` on purpose: a failed reload sets `data` undefined and the
               each can re-evaluate before the surrounding `{#if}` tears down. -->
          {#each data?.events ?? [] as ev, i (`${ev.at}-${i}`)}
            <tr class="border-b border-[var(--color-border)] align-top">
              <td class="py-2 pr-4 whitespace-nowrap text-[var(--color-text-muted)]">
                {fmtDate(ev.at)}
              </td>
              <td class="py-2 pr-4 font-medium text-[var(--color-text)]">{ev.status}</td>
              <td class="py-2 pr-4 text-[var(--color-text-muted)]">{ev.detail ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </ReportPanel>
</div>
