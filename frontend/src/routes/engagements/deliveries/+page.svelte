<!--
  /engagements/deliveries — delivery audit log.

  Renders rows from `engagement_deliveries` (Wave 4 backend). Filters map
  to the GET /api/engagements/deliveries query schema 1:1; non-admins
  always see only their own deliveries (server-enforced).

  Pagination is "load more" — the server uses a simple LIMIT, so we just
  bump the local limit and refetch. v1 starts at 100 and grows by 100.

  Plan: docs/superpowers/plans/...woolly-harp Wave 5 Task 5.2 Step 2.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    listDeliveries,
    DELIVERY_CHANNELS,
    DELIVERY_STATUSES,
    maskRecipient,
    statusBadgeKind,
    type DeliveryRow,
    type DeliveryChannel,
    type DeliveryStatus,
  } from '$lib/api/deliveries';
  import { StatusBadge } from '$lib/components/observability';
  import { ErrorState, EmptyState } from '$lib/components/ui';

  type SinceWindow = 'all' | '1h' | '24h' | '7d';

  const PAGE_SIZE = 100;

  // ---- Filter form state (applied → query state) ------------------------
  // `formChannel` is a bare string, not `DeliveryChannel | ''`: the option set
  // is no longer the compile-time enum (see `channelOptions` below).
  let formChannel = $state<string>('');
  let formStatus = $state<DeliveryStatus | ''>('');
  let formSince = $state<SinceWindow>('all');
  let formActionId = $state<string>('');

  // Applied filters used by the fetcher.
  let appliedChannel = $state<string>('');
  let appliedStatus = $state<DeliveryStatus | ''>('');
  let appliedSince = $state<SinceWindow>('all');
  let appliedActionId = $state<string>('');

  let limit = $state<number>(PAGE_SIZE);

  let rows = $state<DeliveryRow[]>([]);
  let loading = $state<boolean>(false);
  let error = $state<string | null>(null);
  let lastUpdated = $state<number | null>(null);

  // ---- Channel options ---------------------------------------------------
  //
  // `DELIVERY_CHANNELS` is a hardcoded mirror of the backend's zod
  // `ChannelEnum` (backend/src/routes/engagements/deliveries.ts) and it has
  // DRIFTED from the table it filters: `engagement_deliveries.channel` is a
  // free text column and the dominant live value is `telegram`, which the enum
  // does not list. So the Channel filter offered seven options that match
  // nothing and could not offer the one value the data actually contains — a
  // filter built from a list instead of from its own rows.
  //
  // The option set is therefore the UNION of the server enum and the channels
  // observed in the rows we have loaded.
  //
  // Observed channels ACCUMULATE rather than being rebuilt per fetch: narrowing
  // to a channel that returns zero rows must not delete the option the user is
  // standing on.
  let observedChannels = $state<string[]>([]);

  let channelOptions = $derived(
    [...new Set<string>([...DELIVERY_CHANNELS, ...observedChannels])].sort(),
  );

  /** True when the server's zod enum will accept this value as `?channel=`. */
  function isServerChannel(value: string): value is DeliveryChannel {
    return (DELIVERY_CHANNELS as readonly string[]).includes(value);
  }

  // A channel outside the server enum cannot be pushed into the query — the
  // handler runs `ListQuerySchema.parse(raw)`, which THROWS on an unlisted
  // value — so it narrows the page we already hold instead. Offering an option
  // that 400s would be strictly worse than not offering it.
  let clientChannel = $derived(
    appliedChannel !== '' && !isServerChannel(appliedChannel) ? appliedChannel : null,
  );

  // ---- Helpers -----------------------------------------------------------
  function sinceToIso(window_: SinceWindow): string | undefined {
    if (window_ === 'all') return undefined;
    const now = Date.now();
    const ms =
      window_ === '1h' ? 60 * 60 * 1000 : window_ === '24h' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    return new Date(now - ms).toISOString();
  }

  function formatLocalTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleString();
    } catch {
      return iso;
    }
  }

  function truncate(value: string, n: number): string {
    if (value.length <= n) return value;
    return `${value.slice(0, n)}…`;
  }

  // ---- Fetchers ----------------------------------------------------------
  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const out = await listDeliveries({
        // Only enum-valid channels travel as a query param; anything else is
        // narrowed client-side via `visibleRows`.
        channel:
          appliedChannel !== '' && isServerChannel(appliedChannel) ? appliedChannel : undefined,
        status: appliedStatus || undefined,
        actionId: appliedActionId.trim() || undefined,
        since: sinceToIso(appliedSince),
        limit,
      });
      rows = out.data;
      // Learn the channels the data actually uses, so the filter can offer them.
      observedChannels = [
        ...new Set<string>([...observedChannels, ...out.data.map((r) => r.channel)]),
      ];
      lastUpdated = Date.now();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function applyFilters(): void {
    appliedChannel = formChannel;
    appliedStatus = formStatus;
    appliedSince = formSince;
    appliedActionId = formActionId;
    limit = PAGE_SIZE;
    void refresh();
  }

  function resetFilters(): void {
    formChannel = '';
    formStatus = '';
    formSince = 'all';
    formActionId = '';
    appliedChannel = '';
    appliedStatus = '';
    appliedSince = 'all';
    appliedActionId = '';
    limit = PAGE_SIZE;
    void refresh();
  }

  function loadMore(): void {
    limit += PAGE_SIZE;
    void refresh();
  }

  function openRow(id: string): void {
    void goto(`/engagements/deliveries/${id}`);
  }

  onMount(() => {
    void refresh();
  });

  // The server may have more rows than `limit`; we only know we're at the
  // end when the returned count is strictly less than the requested limit.
  // Deliberately measured on `rows` (the SERVER page), not `visibleRows`: it
  // describes what the server still has, not what the local narrowing kept.
  let hasMore = $derived(rows.length === limit);

  // What the table actually renders.
  let visibleRows = $derived(
    clientChannel === null ? rows : rows.filter((r) => r.channel === clientChannel),
  );
</script>

<div class="flex flex-col gap-4 h-full" data-testid="deliveries-page">
  <header class="flex items-center justify-between">
    <h1 class="text-2xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Delivery log</h1>
    <button
      type="button"
      onclick={() => void refresh()}
      disabled={loading}
      class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
      data-testid="deliveries-refresh"
    >
      {loading ? '…' : 'Refresh'}
    </button>
  </header>

  <!-- Filter row -->
  <section
    class="flex flex-wrap items-end gap-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
    data-testid="deliveries-filters"
  >
    <label class="flex flex-col text-xs text-[var(--color-text)] gap-1 dark:text-[var(--color-text-muted)]">
      <span>Channel</span>
      <select
        bind:value={formChannel}
        class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] min-w-[8rem] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
        data-testid="filter-channel"
      >
        <option value="">any</option>
        {#each channelOptions as ch (ch)}
          <option value={ch}>{ch}</option>
        {/each}
      </select>
    </label>

    <label class="flex flex-col text-xs text-[var(--color-text)] gap-1 dark:text-[var(--color-text-muted)]">
      <span>Status</span>
      <select
        bind:value={formStatus}
        class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] min-w-[10rem] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
        data-testid="filter-status"
      >
        <option value="">any</option>
        {#each DELIVERY_STATUSES as st (st)}
          <option value={st}>{st}</option>
        {/each}
      </select>
    </label>

    <label class="flex flex-col text-xs text-[var(--color-text)] gap-1 dark:text-[var(--color-text-muted)]">
      <span>Since</span>
      <select
        bind:value={formSince}
        class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] min-w-[8rem] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
        data-testid="filter-since"
      >
        <option value="all">all</option>
        <option value="1h">last 1h</option>
        <option value="24h">last 24h</option>
        <option value="7d">last 7d</option>
      </select>
    </label>

    <label class="flex flex-col text-xs text-[var(--color-text)] gap-1 dark:text-[var(--color-text-muted)]">
      <span>Action ID</span>
      <input
        type="text"
        bind:value={formActionId}
        placeholder="00000000-0000-0000-0000-000000000000"
        title="UUID v4 — 8-4-4-4-12 hex digits"
        class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] font-mono w-[20rem] dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)]"
        data-testid="filter-action-id"
      />
    </label>

    <div class="flex items-center gap-2 ml-auto">
      <button
        type="button"
        onclick={applyFilters}
        class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
        disabled={loading}
        data-testid="filter-apply"
      >
        Apply
      </button>
      <button
        type="button"
        onclick={resetFilters}
        class="px-3 py-1 bg-[var(--color-surface)] text-[var(--color-text)] text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border)] dark:hover:bg-[var(--color-surface-strong)]"
        data-testid="filter-reset"
      >
        Reset
      </button>
    </div>
  </section>

  {#if error}
    <div data-testid="deliveries-error">
      <ErrorState {error} title="Couldn't load deliveries" onRetry={refresh} />
    </div>
  {/if}

  <!-- Table -->
  <section class="flex flex-col gap-2" data-testid="deliveries-table-section">
    <div class="flex items-center justify-between">
      <h2 class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
        Showing {visibleRows.length} {visibleRows.length === 1 ? 'delivery' : 'deliveries'}{lastUpdated
          ? ` · updated ${new Date(lastUpdated).toLocaleTimeString()}`
          : ''}
      </h2>
    </div>

    {#if visibleRows.length === 0 && !loading}
      <div data-testid="deliveries-empty">
        <EmptyState
          title="No deliveries"
          body="Nothing matches the current filters. Try widening the channel or status filter."
        />
      </div>
    {:else}
      <div class="overflow-x-auto border border-[var(--color-border)] rounded dark:border-[var(--color-border)]">
        <table class="min-w-full text-sm" data-testid="deliveries-table">
          <thead class="bg-[var(--color-surface)] text-[var(--color-text)] text-xs uppercase tracking-wide dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
            <tr>
              <th class="px-3 py-2 text-left font-medium">Time</th>
              <th class="px-3 py-2 text-left font-medium">Channel</th>
              <th class="px-3 py-2 text-left font-medium">Status</th>
              <th class="px-3 py-2 text-left font-medium">Recipient</th>
              <th class="px-3 py-2 text-left font-medium">Action</th>
              <th class="px-3 py-2 text-left font-medium">Engagement</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--color-border)] bg-[var(--color-bg)] dark:divide-[var(--color-border-strong)] dark:bg-[var(--color-surface)]">
            {#each visibleRows as row (row.id)}
              <tr
                class="hover:bg-[var(--color-accent)] cursor-pointer"
                onclick={() => openRow(row.id)}
                data-testid="deliveries-row"
                data-row-id={row.id}
              >
                <td class="px-3 py-1.5 whitespace-nowrap text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
                  {formatLocalTime(row.created_at)}
                </td>
                <td class="px-3 py-1.5 whitespace-nowrap text-[var(--color-text)] font-mono text-xs dark:text-[var(--color-text-muted)]">
                  {row.channel}
                </td>
                <td class="px-3 py-1.5 whitespace-nowrap">
                  <StatusBadge status={statusBadgeKind(row.status)} label={row.status} />
                </td>
                <td class="px-3 py-1.5 whitespace-nowrap text-[var(--color-text)] font-mono text-xs dark:text-[var(--color-text-muted)]">
                  {maskRecipient(row.channel, row.recipient_address)}
                </td>
                <td class="px-3 py-1.5 whitespace-nowrap">
                  <a
                    href={`/engagements/deliveries/${row.id}`}
                    class="text-[var(--color-accent)] hover:underline font-mono text-xs"
                    onclick={(e) => e.stopPropagation()}
                    data-testid="deliveries-row-link"
                  >
                    {truncate(row.id, 13)}
                  </a>
                </td>
                <td class="px-3 py-1.5 whitespace-nowrap text-[var(--color-text)] text-xs dark:text-[var(--color-text-muted)]">
                  {row.engagement_type}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <div class="flex items-center justify-between">
      <span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]" data-testid="deliveries-pagination-hint">
        Showing {visibleRows.length} of {hasMore ? `${visibleRows.length}+` : visibleRows.length}
      </span>
      {#if hasMore}
        <button
          type="button"
          onclick={loadMore}
          disabled={loading}
          class="px-3 py-1 bg-[var(--color-surface)] text-[var(--color-text)] text-sm rounded border border-[var(--color-border)] hover:bg-[var(--color-surface-strong)] disabled:bg-[var(--color-surface)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border)] dark:hover:bg-[var(--color-surface-strong)]"
          data-testid="deliveries-load-more"
        >
          {loading ? 'Loading…' : `Load ${PAGE_SIZE} more`}
        </button>
      {/if}
    </div>
  </section>
</div>
