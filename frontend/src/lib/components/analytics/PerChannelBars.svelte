<!--
  PerChannelBars.svelte — small horizontal bar chart for notification
  send volumes per channel kind (telegram / teams / email / web / inapp /
  voice / future).

  Spec: docs/archive/2026-04-27-foundation-design.md §9.3
        "Per-channel send volumes — extra subsection: a small bar chart
         (or table) of notification sends per channel kind, backed by an
         existing notification_log query."

  Data shape matches `GET /api/tools/analytics/per-channel`.
  Pure render: no fetch, no store. Layout helpers are exported from the
  module block so the unit test can pin the bar-width math without
  mounting Svelte.
-->
<script lang="ts" module>
  export interface ChannelDatum {
    kind: string;
    sends: number;
  }

  export interface ChannelBar extends ChannelDatum {
    /** Width in pixels relative to the largest bar. */
    width: number;
    /** Convenience formatted count. */
    label: string;
  }

  function fmt(n: number): string {
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return Math.round(n).toString();
  }

  /**
   * Compute pixel widths for each bar so the largest fills `maxWidth`.
   * Stable and deterministic — channels sort by `sends` desc, then by
   * `kind` asc to break ties.
   */
  export function layoutBars(
    channels: ReadonlyArray<ChannelDatum>,
    maxWidth = 200,
  ): ChannelBar[] {
    if (channels.length === 0) return [];
    const sorted = [...channels].sort((a, b) => {
      if (b.sends !== a.sends) return b.sends - a.sends;
      return a.kind.localeCompare(b.kind);
    });
    const max = Math.max(...sorted.map((c) => c.sends), 1);
    return sorted.map((c) => ({
      ...c,
      width: Math.max(2, Math.round((c.sends / max) * maxWidth)),
      label: fmt(c.sends),
    }));
  }

  /**
   * What the panel may claim. Three states, not two.
   *
   * An empty `channels` array reaches this component identically whether the
   * window genuinely had no sends or the per-channel read failed and the store
   * degraded to `null`. Rendering "No notifications dispatched in this window."
   * for the second case is a confident, wrong claim about production. The
   * caller passes the store's `perChannelError` so the two separate.
   */
  export type ChannelPanelState = 'unreadable' | 'empty' | 'bars';

  export function channelPanelState(
    barCount: number,
    unavailable: string | null | undefined,
  ): ChannelPanelState {
    if (unavailable != null && unavailable !== '') return 'unreadable';
    return barCount > 0 ? 'bars' : 'empty';
  }
</script>

<script lang="ts">
  interface Props {
    channels: ReadonlyArray<ChannelDatum>;
    maxBarWidth?: number;
    /** Sanitized reason the per-channel read failed; null/absent = it succeeded. */
    unavailable?: string | null;
  }

  const { channels, maxBarWidth = 200, unavailable = null }: Props = $props();
  const bars = $derived(layoutBars(channels, maxBarWidth));
  const panelState = $derived(channelPanelState(bars.length, unavailable));
</script>

<div class="border border-[var(--color-border)] rounded mt-6 dark:border-[var(--color-border)]" data-testid="analytics-per-channel">
  <header class="flex items-center px-3 py-2 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
    <h2 class="text-sm font-semibold text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Notifications by channel</h2>
    <span class="ml-auto text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      {#if panelState === 'unreadable'}
        <!-- "0 channels" is a count, and we do not have one. -->
        —
      {:else}
        {bars.length} {bars.length === 1 ? 'channel' : 'channels'}
      {/if}
    </span>
  </header>

  {#if panelState === 'unreadable'}
    <p
      class="text-sm text-[var(--color-warning-text)] px-3 py-6 text-center"
      data-testid="analytics-per-channel-unreadable"
      role="alert"
    >
      Per-channel sends could not be read, so this is NOT a record that nothing was
      dispatched.<br />
      <span class="text-xs font-mono text-[var(--color-text-muted)]">{unavailable}</span>
    </p>
  {:else if panelState === 'empty'}
    <p class="text-sm text-[var(--color-text-muted)] px-3 py-6 text-center dark:text-[var(--color-text-muted)]">
      No notifications dispatched in this window.
    </p>
  {:else}
    <ul class="px-3 py-2 space-y-1.5">
      {#each bars as bar (bar.kind)}
        <li class="flex items-center gap-2 text-sm" data-testid="analytics-per-channel-row">
          <span class="w-20 truncate text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{bar.kind}</span>
          <span
            class="h-3 rounded bg-[var(--color-accent)] dark:bg-[var(--color-accent)]"
            style="width: {bar.width}px"
            aria-hidden="true"
          ></span>
          <span class="text-xs tabular-nums text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{bar.label}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
