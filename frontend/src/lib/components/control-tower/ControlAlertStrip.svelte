<script lang="ts">
  // Fleet alert strip — derived alert tiles from the `alerts` block. Each tile
  // carries a deep-link hint (block:<name> / card:<id>) surfaced via `onselect`
  // so the page can scroll to a block or select a card. Alerts come from the
  // backend `deriveAlerts` checks, never hand-written.
  import Tag from '$lib/components/ui/Tag.svelte';
  import { alertTone } from './logic';
  import type { ControlAlert } from '$lib/types/control-tower';

  interface Props {
    alerts: ControlAlert[];
    onselect?: (alert: ControlAlert) => void;
  }
  let { alerts, onselect }: Props = $props();

  const SEVERITY_LABEL: Record<ControlAlert['severity'], string> = {
    ok: 'OK',
    warn: 'Warn',
    danger: 'Blocked',
  };
</script>

{#if alerts.length > 0}
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="control-tower-alert-strip">
    {#each alerts as alert (alert.key)}
      <button
        type="button"
        disabled={!alert.link || !onselect}
        onclick={() => onselect?.(alert)}
        class="flex flex-col items-start gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left transition-colors enabled:hover:border-[var(--color-border-strong)] disabled:cursor-default"
        data-testid="control-tower-alert"
      >
        <Tag tone={alertTone(alert.severity)} dot>{SEVERITY_LABEL[alert.severity]}</Tag>
        <span class="text-sm font-semibold text-[var(--color-text)]">{alert.title}</span>
        <span class="text-xs text-[var(--color-text-muted)]">{alert.detail}</span>
      </button>
    {/each}
  </div>
{/if}
