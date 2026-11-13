<!-- An editable list of strings (card-type inputs/outputs/acceptance/rules). -->
<script lang="ts">
  import { Button, Input } from '$lib/components/ui';

  let {
    label,
    values = $bindable([]),
    placeholder = '',
  }: { label: string; values?: string[]; placeholder?: string } = $props();

  function add(): void {
    values = [...values, ''];
  }
  function remove(i: number): void {
    values = values.filter((_, j) => j !== i);
  }
</script>

<fieldset class="flex flex-col gap-2">
  <legend class="text-sm font-medium text-[var(--color-text)]">{label}</legend>
  {#each values as _, i (i)}
    <div class="flex items-center gap-2">
      <Input bind:value={values[i]} {placeholder} class="min-w-0 flex-1" />
      <Button variant="ghost" size="sm" onclick={() => remove(i)}>Remove</Button>
    </div>
  {:else}
    <p class="text-xs text-[var(--color-text-muted)]">None yet.</p>
  {/each}
  <div>
    <Button variant="secondary" size="sm" onclick={add}>Add {label.toLowerCase()}</Button>
  </div>
</fieldset>
