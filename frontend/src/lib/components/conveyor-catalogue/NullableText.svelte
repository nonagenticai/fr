<!--
  A text field RM keeps NULL until it is set (phase output / exit rule).
  `null` = not set (import-defaults fills it) and renders as "not set" with a
  Set action; once set an empty box means "deliberately cleared" ("").
  "Mark not set" returns it to null.
-->
<script lang="ts">
  import { Button } from '$lib/components/ui';
  import TextField from './TextField.svelte';
  import { NOT_SET } from '$lib/conveyor-catalogue/forms';

  let { label, value = $bindable(null) }: { label: string; value?: string | null } = $props();
</script>

{#if value === null}
  <div class="flex flex-col gap-1 text-sm">
    <span>{label}</span>
    <p class="text-xs text-[var(--color-text-muted)]">{NOT_SET} (the default import fills it)</p>
    <div><Button variant="secondary" size="sm" onclick={() => (value = '')}>Set {label.toLowerCase()}</Button></div>
  </div>
{:else}
  <div class="flex flex-col gap-1">
    <TextField {label} bind:value={() => value ?? '', (v) => (value = v)} />
    <p class="text-xs text-[var(--color-text-muted)]">An empty box means deliberately cleared.</p>
    <div><Button variant="ghost" size="sm" onclick={() => (value = null)}>Mark {label.toLowerCase()} not set</Button></div>
  </div>
{/if}
