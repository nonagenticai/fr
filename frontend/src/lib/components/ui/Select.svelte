<script lang="ts" generics="T extends string">
  let {
    value = $bindable<T>(),
    options,
    disabled = false,
    id,
    onchange,
    class: className = ''
  }: {
    value: T;
    options: { value: T; label: string }[];
    disabled?: boolean;
    id?: string;
    onchange?: (e: Event) => void;
    class?: string;
  } = $props();
</script>

<select
  {id}
  {disabled}
  bind:value
  {onchange}
  class={`h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 ${className}`}
>
  {#each options as opt (opt.value)}
    <option value={opt.value}>{opt.label}</option>
  {/each}
</select>
