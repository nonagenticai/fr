<script lang="ts" module>
  // A list of pass/fail/pending checks for the InspectorDrawer. `ok === true`
  // reads as passed, `false` as failed, `null`/undefined as not-yet-known.
  export interface CheckItem {
    label: string;
    ok?: boolean | null;
    note?: string;
  }
</script>

<script lang="ts">
  interface Props {
    items: CheckItem[];
    class?: string;
  }
  let { items, class: className = '' }: Props = $props();

  function glyph(ok: boolean | null | undefined): string {
    if (ok === true) return '✓';
    if (ok === false) return '✕';
    return '·';
  }
  function toneClass(ok: boolean | null | undefined): string {
    if (ok === true) return 'text-[var(--color-success-text)]';
    if (ok === false) return 'text-[var(--color-danger-text)]';
    return 'text-[var(--color-text-muted)]';
  }
</script>

{#if items.length > 0}
  <ul class={`space-y-1.5 ${className}`}>
    {#each items as item (item.label)}
      <li class="flex items-start gap-2 text-sm">
        <span class={`mt-0.5 shrink-0 font-semibold ${toneClass(item.ok)}`}>{glyph(item.ok)}</span>
        <span class="min-w-0">
          <span class="text-[var(--color-text)]">{item.label}</span>
          {#if item.note}
            <span class="text-[var(--color-text-muted)]"> — {item.note}</span>
          {/if}
        </span>
      </li>
    {/each}
  </ul>
{/if}
