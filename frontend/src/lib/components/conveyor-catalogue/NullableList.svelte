<!--
  A list field RM keeps NULL until it is set (card-type inputs/outputs/
  acceptance/rules). `null` = not set (import-defaults fills it) and renders as
  "not set" with a Set action; once set it is an ordinary list editor, where an
  empty list means "deliberately cleared". "Mark not set" returns it to null.
  The form never turns an untouched null into [].
-->
<script lang="ts">
  import { Button } from '$lib/components/ui';
  import ListEditor from './ListEditor.svelte';
  import { NOT_SET } from '$lib/conveyor-catalogue/forms';

  let { label, values = $bindable(null) }: { label: string; values?: string[] | null } = $props();
</script>

{#if values === null}
  <fieldset class="flex flex-col gap-2">
    <legend class="text-sm font-medium text-[var(--color-text)]">{label}</legend>
    <p class="text-xs text-[var(--color-text-muted)]">{NOT_SET} (the default import fills it)</p>
    <div><Button variant="secondary" size="sm" onclick={() => (values = [])}>Set {label.toLowerCase()}</Button></div>
  </fieldset>
{:else}
  <div class="flex flex-col gap-1">
    <ListEditor {label} bind:values={() => values ?? [], (v) => (values = v)} />
    <p class="text-xs text-[var(--color-text-muted)]">An empty list means deliberately cleared.</p>
    <div><Button variant="ghost" size="sm" onclick={() => (values = null)}>Mark {label.toLowerCase()} not set</Button></div>
  </div>
{/if}
