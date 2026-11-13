<!-- A labelled multi-line text box for the catalogue forms. -->
<script lang="ts">
  let { label, value = $bindable(''), rows = 2 }: { label: string; value?: string; rows?: number } = $props();
</script>

<label class="flex flex-col gap-1 text-sm">
  {label}
  <textarea
    bind:value
    {rows}
    class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text)]"
  ></textarea>
</label>
