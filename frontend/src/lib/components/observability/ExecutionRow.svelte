<!--
  ExecutionRow.svelte

  Single-line representation of one execution (n8n run, ingestion job, etc).
  Renders status badge → name → duration → started-at → optional Tempo link
  → optional caller slot.

  Generic on purpose: takes shaped fields rather than a data-source-specific
  union. The /tools/n8n page passes its scoped-execution shape; future
  sources can pass an equivalent.

  Tempo deep-link (Open follow-up from
  docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md):
  if `traceUrl` is provided we render it as-is; if only `traceId` is
  provided we build a Grafana Explore URL via `buildTempoUrl`. The link
  opens in a new tab with `rel="noopener noreferrer"`. Callers can still
  pass a custom slot in `children` for non-Tempo deep-links — both render
  side by side when both are present.

  Plan: docs/superpowers/plans/...woolly-harp Wave 2 Task 2.1 Step 6.
-->
<script lang="ts">
  import StatusBadge from './StatusBadge.svelte';
  import { buildTempoUrl } from '$lib/utils/tempo-url';
  import type { Snippet } from 'svelte';

  let {
    status,
    name,
    durationMs,
    startedAt,
    traceUrl,
    traceId,
    workflowId,
    children,
  }: {
    status: string | undefined;
    name: string;
    durationMs?: number | undefined;
    startedAt?: string | undefined;
    /** Pre-computed Tempo/Grafana deep-link. Wins over traceId when both are present. */
    traceUrl?: string | null | undefined;
    /** Raw trace / execution id — used to construct a Tempo URL via `buildTempoUrl`. */
    traceId?: string | undefined;
    /** Optional workflow id — narrows the Tempo query when traceId-driven. */
    workflowId?: string | undefined;
    /** Optional trailing slot — typical use: an additional deep-link (n8n editor, etc). */
    children?: Snippet;
  } = $props();

  function fmtDuration(ms: number | undefined, st: string | undefined): string {
    if (ms === undefined || !Number.isFinite(ms)) {
      const v = (st ?? '').toLowerCase();
      if (v === 'running' || v === 'waiting' || v === 'new') return 'in progress';
      return '—';
    }
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1_000);
    return `${mins}m ${secs}s`;
  }

  function fmtTime(iso: string | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    return new Date(t).toLocaleString();
  }

  /**
   * Resolved Tempo deep-link. Prefer the precomputed `traceUrl` (mirrors the
   * backend's `trace_url` field) over a client-side build from `traceId` so
   * the source of truth stays in one place when both are sent.
   */
  const tempoHref = $derived.by((): string | null => {
    if (traceUrl) return traceUrl;
    if (traceId) return buildTempoUrl({ executionId: traceId, workflowId });
    return null;
  });
</script>

<div
  class="flex items-center gap-3 py-1.5 text-sm"
  data-testid="execution-row"
>
  <StatusBadge status={(status ?? 'unknown').toLowerCase()} />
  <span class="font-mono text-xs text-[var(--color-text)] truncate dark:text-[var(--color-text-muted)]" title={name}>{name}</span>
  <span class="ml-auto text-xs tabular-nums text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
    {fmtDuration(durationMs, status)}
  </span>
  <span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{fmtTime(startedAt)}</span>
  {#if tempoHref}
    <a
      href={tempoHref}
      target="_blank"
      rel="noopener noreferrer"
      class="text-xs text-[var(--color-accent)] hover:underline"
      data-testid="execution-row-tempo-link"
      title="Open trace in Grafana Tempo"
    >
      Tempo →
    </a>
  {/if}
  {#if children}
    <span class="text-xs">
      {@render children()}
    </span>
  {/if}
</div>
