<script lang="ts">
  // One quiet line for a cockpit panel that is down, stale, partial or not applicable (spec:
  // "empty is quiet", "plain words"). The machine code sits behind "Details", never in the line.
  import { panelSentence, type Panel } from '$lib/types/panel';

  interface Props {
    panel: Panel<unknown>;
    /** What the panel is, for the sentence ("The lifecycle"). */
    title?: string;
    class?: string;
  }
  let { panel, title, class: className = '' }: Props = $props();

  const sentence = $derived(panelSentence(panel, title ?? 'This'));
  const tone = $derived(
    panel.health === 'down'
      ? 'text-[var(--color-warning-text)]'
      : panel.health === 'degraded'
        ? 'text-[var(--color-warning-text)]'
        : 'text-[var(--color-text-muted)]',
  );
</script>

{#if sentence}
  <div class={`text-xs ${tone} ${className}`} data-testid="panel-note" data-health={panel.health}>
    <span>{sentence}</span>
    {#if panel.detail_code}
      <details class="ml-1 inline-block align-baseline">
        <summary class="cursor-pointer select-none text-[var(--color-text-muted)] underline decoration-dotted">Details</summary>
        <span class="ml-1 font-mono text-[11px] text-[var(--color-text-muted)]" data-testid="panel-detail-code">
          {panel.detail_code}{panel.down_since ? ` · since ${panel.down_since}` : ''}
        </span>
      </details>
    {/if}
  </div>
{/if}
