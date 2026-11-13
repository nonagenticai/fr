<!--
  /engagements/deliveries/[id] — single delivery detail.

  Renders all columns from the `engagement_deliveries` row, plus the
  pretty-printed metadata payload and a prominent error banner. v1 has
  no actions/<id> page yet; the action_id is shown as plain text.

  Plan: docs/superpowers/plans/...woolly-harp Wave 5 Task 5.2 Step 3.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import {
    getDelivery,
    maskRecipient,
    statusBadgeKind,
    type DeliveryRow,
  } from '$lib/api/deliveries';
  import { StatusBadge } from '$lib/components/observability';
  import { Skeleton, ErrorState } from '$lib/components/ui';

  let row = $state<DeliveryRow | null>(null);
  let loading = $state<boolean>(true);
  let error = $state<string | null>(null);

  const id = $derived($page.params.id ?? '');

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      row = await getDelivery(id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      row = null;
    } finally {
      loading = false;
    }
  }

  function formatLocalTime(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function truncate(value: string, n: number): string {
    if (value.length <= n) return value;
    return `${value.slice(0, n)}…`;
  }

  function metadataPretty(meta: Record<string, unknown> | null): string {
    if (meta === null || meta === undefined) return '(none)';
    try {
      return JSON.stringify(meta, null, 2);
    } catch {
      return String(meta);
    }
  }

  onMount(() => {
    void load();
  });
</script>

<div class="flex flex-col gap-4 h-full" data-testid="delivery-detail-page">
  <header class="flex items-center gap-3">
    <a
      href="/engagements/deliveries"
      class="text-sm text-[var(--color-accent)] hover:underline"
      data-testid="delivery-detail-back"
    >
      ← Delivery log
    </a>
    {#if row}
      <h1
        class="text-xl font-semibold text-[var(--color-text)] truncate dark:text-[var(--color-text)]"
        data-testid="delivery-detail-title"
      >
        Delivery — {row.channel} — {maskRecipient(row.channel, row.recipient_address)}
      </h1>
    {:else}
      <h1 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Delivery</h1>
    {/if}
  </header>

  {#if loading}
    <div data-testid="delivery-detail-loading">
      <Skeleton variant="box" height="14rem" />
    </div>
  {:else if error}
    <div data-testid="delivery-detail-error">
      <ErrorState error={error} title="Couldn't load delivery" onRetry={load} />
    </div>
  {:else if row}
    {#if row.error}
      <div
        class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] text-[var(--color-danger-text)] px-4 py-3 rounded dark:bg-[var(--color-danger-bg)]/20"
        role="alert"
        data-testid="delivery-detail-error-banner"
      >
        <div class="font-semibold text-sm">Delivery error</div>
        <div class="font-mono text-xs mt-1 whitespace-pre-wrap break-all">{row.error}</div>
      </div>
    {/if}

    <section
      class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
      data-testid="delivery-detail-fields"
    >
      <dl class="grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">ID</dt>
        <dd class="font-mono text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]" data-testid="field-id">{row.id}</dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Created at</dt>
        <dd class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]" data-testid="field-created-at">
          {formatLocalTime(row.created_at)}
          <span class="text-xs text-[var(--color-text-muted)] font-mono ml-2 dark:text-[var(--color-text-muted)]">({row.created_at})</span>
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Channel</dt>
        <dd class="text-[var(--color-text)] font-mono text-xs dark:text-[var(--color-text-muted)]" data-testid="field-channel">
          {row.channel}
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Status</dt>
        <dd data-testid="field-status">
          <StatusBadge status={statusBadgeKind(row.status)} label={row.status} />
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Recipient (masked)</dt>
        <dd class="text-[var(--color-text)] font-mono text-xs dark:text-[var(--color-text-muted)]" data-testid="field-recipient-masked">
          {maskRecipient(row.channel, row.recipient_address)}
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Recipient address</dt>
        <dd class="text-[var(--color-text)] font-mono text-xs break-all dark:text-[var(--color-text-muted)]" data-testid="field-recipient-address">
          {row.recipient_address}
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Recipient user ID</dt>
        <dd class="text-[var(--color-text)] font-mono text-xs dark:text-[var(--color-text-muted)]" data-testid="field-recipient-user-id">
          {row.recipient_user_id ?? '(none)'}
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Engagement type</dt>
        <dd class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]" data-testid="field-engagement-type">
          {row.engagement_type}
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Engagement ID</dt>
        <dd class="text-[var(--color-text)] font-mono text-xs dark:text-[var(--color-text-muted)]" data-testid="field-engagement-id">
          {row.engagement_id ?? '(none)'}
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Action</dt>
        <dd class="text-[var(--color-text)] font-mono text-xs dark:text-[var(--color-text-muted)]" data-testid="field-action-id">
          {#if row.action_id}
            <span title={row.action_id}>Action: {truncate(row.action_id, 13)}</span>
          {:else}
            (none)
          {/if}
        </dd>

        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Error</dt>
        <dd class="text-[var(--color-text)] font-mono text-xs whitespace-pre-wrap break-all dark:text-[var(--color-text-muted)]" data-testid="field-error">
          {row.error ?? '(none)'}
        </dd>
      </dl>
    </section>

    <section class="flex flex-col gap-2" data-testid="delivery-detail-metadata-section">
      <h2 class="text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Metadata</h2>
      <pre
        class="bg-[var(--color-bg)] text-[var(--color-text)] text-xs rounded p-3 overflow-x-auto whitespace-pre-wrap break-all"
        data-testid="delivery-detail-metadata"
        >{metadataPretty(row.metadata_json)}</pre>
    </section>
  {/if}
</div>
