<script lang="ts" module>
  // A labelled key/value table (the InspectorDrawer identity/metadata block).
  // Visual language lifted from KagNodeDetailPanel's metadata <dl>. `mono`
  // renders values in a monospace face (ids, hashes) — off by default so
  // customer-facing drawers stay readable.
  export interface KvRow {
    label: string;
    value: string;
  }
</script>

<script lang="ts">
  interface Props {
    rows: KvRow[];
    mono?: boolean;
    class?: string;
  }
  let { rows, mono = false, class: className = '' }: Props = $props();
</script>

{#if rows.length > 0}
  <dl
    class={`divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] text-sm ${className}`}
  >
    {#each rows as row (row.label)}
      <div class="flex gap-3 px-3 py-2">
        <dt class="w-1/3 shrink-0 font-medium text-[var(--color-text-muted)]">{row.label}</dt>
        <dd
          class={`min-w-0 break-words text-[var(--color-text)] ${mono ? 'font-mono text-xs' : ''}`}
        >
          {row.value}
        </dd>
      </div>
    {/each}
  </dl>
{/if}
