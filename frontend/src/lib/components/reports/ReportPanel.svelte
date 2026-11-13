<!--
  ReportPanel — the four-state envelope every /reports page renders through.

  Exists so "loading / error / empty / populated" is a STRUCTURAL guarantee
  rather than a convention each page re-implements (and one page eventually
  forgets). The states are mutually exclusive and evaluated in that order:
  a failed fetch must never be shown as "no data", which is the specific bug
  this component is here to make impossible.

  The error branch names the failure. A blank panel is not an error state —
  it is indistinguishable from an empty result, and that ambiguity is what
  sends a user to support instead of to a retry.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Human name of the thing being loaded — used in the error sentence. */
    label: string;
    loading: boolean;
    /** Message from the thrown Error, or undefined when the call succeeded. */
    error?: string;
    /** True when the call succeeded but returned nothing to show. */
    empty: boolean;
    /** Shown in the empty state. Say what would appear here and why it hasn't. */
    emptyMessage: string;
    /** Optional retry hook — rendered in the error state when supplied. */
    onRetry?: () => void;
    children: Snippet;
  }

  const {
    label,
    loading,
    error,
    empty,
    emptyMessage,
    onRetry,
    children,
  }: Props = $props();
</script>

{#if loading}
  <p data-testid="report-loading" class="text-sm text-[var(--color-text-muted)]">
    Loading {label}…
  </p>
{:else if error}
  <div data-testid="report-error" class="rounded-[var(--radius-md)] border border-[var(--color-danger)] bg-[var(--color-surface)] p-3">
    <p class="text-sm font-medium text-[var(--color-danger)]">
      Could not load {label}
    </p>
    <p class="mt-1 break-words text-xs text-[var(--color-text-muted)]">{error}</p>
    {#if onRetry}
      <button
        type="button"
        onclick={onRetry}
        data-testid="report-error-retry"
        class="mt-2 h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
      >
        Try again
      </button>
    {/if}
  </div>
{:else if empty}
  <p data-testid="report-empty" class="text-sm text-[var(--color-text-muted)]">
    {emptyMessage}
  </p>
{:else}
  <div data-testid="report-content">
    {@render children()}
  </div>
{/if}
