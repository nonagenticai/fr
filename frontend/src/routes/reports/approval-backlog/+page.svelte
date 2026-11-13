<!--
  /reports/approval-backlog — GET /api/reports/approval-backlog

  Backend: backend/src/routes/reports/index.ts:31 -> { data: { pending, count } }.
  Scoped to the CALLING user (approvalBacklog(user.id, tenantId)), so this is
  "approvals waiting on me", not a fleet-wide queue.

  ⚠️ This route directory must stay a STATIC segment sitting beside the dynamic
  /reports/[reportId]. SvelteKit resolves static before dynamic, which mirrors
  the backend's own first-match ordering note at server.ts:2074.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getApprovalBacklog, type ApprovalSummary } from '$lib/api/reports';
  import ReportPanel from '$lib/components/reports/ReportPanel.svelte';
  // ⛔ REUSED verbatim from the shared module — not re-implemented, not loosened.
  // A backlog report is read to COUNT and compare rows; a raw `[object Object]`
  // here is the one place a reader is most likely to take the text as the
  // producer's own words.
  import { markUnreadableProducerOutput } from '$lib/approvals/rationale';

  let pending = $state<ApprovalSummary[]>([]);
  let count = $state(0);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);

  async function refresh(): Promise<void> {
    loading = true;
    error = undefined;
    try {
      const r = await getApprovalBacklog();
      pending = r.pending;
      count = r.count;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(refresh);

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  /** An expiry already in the past is the thing a backlog report exists to surface. */
  function isExpired(iso: string | null | undefined): boolean {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t < Date.now();
  }
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-4">
    <nav aria-label="Breadcrumb" class="text-xs text-[var(--color-text-muted)]">
      <a href="/reports" class="hover:underline">Reports</a>
      <span class="mx-1">/</span>
      <span>Approval backlog</span>
    </nav>
    <div class="mt-1 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-[var(--color-text)]">Approval backlog</h1>
        <p class="mt-1 text-sm text-[var(--color-text-muted)]">
          Approvals still waiting on you{#if !loading && !error}
            — <span class="font-medium text-[var(--color-text)]">{count}</span> pending{/if}.
        </p>
      </div>
      <button
        type="button"
        onclick={() => void refresh()}
        class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
      >
        Refresh
      </button>
    </div>
  </header>

  <ReportPanel
    label="the approval backlog"
    {loading}
    {error}
    empty={pending.length === 0}
    emptyMessage="Nothing is waiting on you. Approvals assigned to you appear here until you decide them."
    onRetry={() => void refresh()}
  >
    <table class="w-full table-auto border-collapse text-sm">
      <thead>
        <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <th class="py-2 pr-4">Description</th>
          <th class="py-2 pr-4">Role</th>
          <th class="py-2 pr-4">Status</th>
          <th class="py-2 pr-4">Raised</th>
          <th class="py-2 pr-4">Expires</th>
          <th class="py-2 pr-4"></th>
        </tr>
      </thead>
      <tbody>
        {#each pending as a (a.id)}
          <tr class="border-b border-[var(--color-border)] align-top">
            <td class="py-2 pr-4 font-medium text-[var(--color-text)]"
              >{markUnreadableProducerOutput(a.description)}</td
            >
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">{a.role ?? '—'}</td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">{a.status}</td>
            <td class="py-2 pr-4 whitespace-nowrap text-[var(--color-text-muted)]">
              {fmtDate(a.created_at)}
            </td>
            <td class="py-2 pr-4 whitespace-nowrap">
              {#if isExpired(a.expires_at)}
                <span data-testid="expired-badge" class="text-[var(--color-danger)]"
                  >{fmtDate(a.expires_at)} (expired)</span
                >
              {:else}
                <span class="text-[var(--color-text-muted)]">{fmtDate(a.expires_at)}</span>
              {/if}
            </td>
            <td class="py-2 pr-4">
              <a
                href={`/approvals/${encodeURIComponent(a.id)}`}
                class="text-xs text-[var(--color-accent)] hover:underline">Decide</a
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </ReportPanel>
</div>
