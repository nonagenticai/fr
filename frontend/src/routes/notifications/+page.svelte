<!--
  /notifications — project-execution notification inbox (WS1 Phase 1B).

  Personal feed of non-approval lifecycle/outcome events written by the AA
  pipeline through fr-backend (POST /api/webhooks/n8n/execution-event). Lists
  the caller's durable `notifications` rows, supports unread/all filtering,
  mark-read per row + mark-all, and keeps the sidebar badge (navCounts) in sync.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listNotifications,
    markRead,
    markAllRead,
    EVENT_TYPE_LABELS,
    type NotificationRow,
    type NotificationSeverity,
  } from '$lib/api/notifications';
  import { navCounts } from '$lib/stores/navCounts.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { safeHref } from '$lib/utils/safeUrl';

  let rows = $state<NotificationRow[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let filter = $state<'all' | 'unread'>('all');
  let busy = $state<Set<string>>(new Set());

  const unreadCount = $derived(rows.filter((r) => !r.read_at).length);

  function severityClass(sev: NotificationSeverity): string {
    const base = 'inline-block px-2 py-0.5 rounded text-xs font-medium border';
    switch (sev) {
      case 'error':
        return `${base} bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]`;
      case 'warning':
        return `${base} bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-bg)]`;
      case 'success':
        return `${base} bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success)]`;
      default:
        return `${base} bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]`;
    }
  }

  function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function markBusy(id: string, on: boolean): void {
    const next = new Set(busy);
    if (on) next.add(id);
    else next.delete(id);
    busy = next;
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      rows = await listNotifications({ status: filter, limit: 100 });
      loadError = null;
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  async function setFilter(next: 'all' | 'unread'): Promise<void> {
    if (filter === next) return;
    filter = next;
    await load();
  }

  async function handleMarkRead(row: NotificationRow): Promise<void> {
    if (row.read_at) return;
    const original = rows;
    rows = rows.map((r) => (r.id === row.id ? { ...r, read_at: new Date().toISOString() } : r));
    markBusy(row.id, true);
    try {
      await markRead(row.id);
      void navCounts.refresh();
      if (filter === 'unread') rows = rows.filter((r) => r.id !== row.id);
    } catch (err) {
      rows = original;
      toast.error(`Mark read failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      markBusy(row.id, false);
    }
  }

  async function handleMarkAll(): Promise<void> {
    const original = rows;
    rows = rows.map((r) => ({ ...r, read_at: r.read_at ?? new Date().toISOString() }));
    try {
      await markAllRead();
      void navCounts.refresh();
      if (filter === 'unread') rows = [];
      toast.success('All notifications marked read');
    } catch (err) {
      rows = original;
      toast.error(`Mark all failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
</script>

<div class="flex flex-col gap-4 p-6 max-w-3xl" data-testid="notifications-inbox">
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-semibold">Notifications</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Project-execution events. Manage channels in
        <a href="/settings/communication" class="underline">Settings → Communication</a>.
      </p>
    </div>
    <button
      type="button"
      onclick={() => void handleMarkAll()}
      disabled={unreadCount === 0}
      class="text-xs px-3 py-1.5 rounded border border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] disabled:opacity-50"
      data-testid="mark-all-read"
    >
      Mark all read
    </button>
  </header>

  <div class="flex gap-2" role="tablist" aria-label="Notification filter">
    <button
      type="button"
      role="tab"
      aria-selected={filter === 'all'}
      onclick={() => void setFilter('all')}
      class="text-sm px-3 py-1 rounded {filter === 'all' ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]' : 'border border-[var(--color-border-strong)]'}"
      data-testid="filter-all"
    >
      All
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={filter === 'unread'}
      onclick={() => void setFilter('unread')}
      class="text-sm px-3 py-1 rounded {filter === 'unread' ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]' : 'border border-[var(--color-border-strong)]'}"
      data-testid="filter-unread"
    >
      Unread{unreadCount > 0 ? ` (${unreadCount})` : ''}
    </button>
  </div>

  {#if loadError}
    <div
      role="alert"
      data-testid="load-error"
      class="rounded border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-sm text-[var(--color-danger-text)] p-3"
    >
      {loadError}
    </div>
  {/if}

  <!--
    The `loadError` branch is load-bearing, not tidying.

    Without it a failed read renders the error banner AND "No notifications
    yet." together — the page asserting in one breath both that it does not
    know and that the answer is none. "No rows" is a claim about the server's
    data and may only be made when the read actually succeeded.

    It is guarded on `rows.length === 0` so a failed REFRESH keeps the rows it
    already has and merely adds the banner; only a load with nothing to show
    defers entirely to the banner.
  -->
  {#if loading && rows.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError && rows.length === 0}
    <!-- The banner above is the entire answer. Rendering an empty list here
         would redraw the very "zero rows" claim the banner is retracting. -->
  {:else if rows.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="empty-state">
      {filter === 'unread' ? 'No unread notifications.' : 'No notifications yet.'}
    </p>
  {:else}
    <ul class="flex flex-col gap-2" data-testid="notification-items">
      {#each rows as row (row.id)}
        <li
          class="border rounded p-3 flex flex-col gap-1 {row.read_at ? 'opacity-70' : 'bg-[var(--color-surface)]'}"
          data-testid="notification-item"
          data-read={row.read_at ? 'true' : 'false'}
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              {#if !row.read_at}
                <span class="inline-block h-2 w-2 rounded-full bg-[var(--color-accent)]" aria-label="unread"></span>
              {/if}
              <span class={severityClass(row.severity)}>{EVENT_TYPE_LABELS[row.event_type] ?? row.event_type}</span>
              <span class="font-medium truncate">{row.title}</span>
            </div>
            <span class="text-xs text-[var(--color-text-muted)] whitespace-nowrap">{relativeTime(row.created_at)}</span>
          </div>
          {#if row.body}
            <p class="text-sm text-[var(--color-text-muted)]">{row.body}</p>
          {/if}
          <div class="flex items-center gap-3 text-xs">
            {#if row.link}
              {@const linkHref = safeHref(row.link)}
              {#if linkHref}
                <a href={linkHref} class="text-[var(--color-accent)] hover:underline" data-testid="notification-link">Open</a>
              {:else}
                <span class="text-[var(--color-text-muted)] break-all" data-testid="notification-link-text">{row.link}</span>
              {/if}
            {/if}
            {#if !row.read_at}
              <button
                type="button"
                disabled={busy.has(row.id)}
                onclick={() => void handleMarkRead(row)}
                class="text-[var(--color-text-muted)] hover:underline disabled:opacity-50"
                data-testid="mark-read"
              >
                Mark read
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
