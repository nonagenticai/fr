<script lang="ts">
  let {
    value = $bindable(''),
    type = 'text',
    placeholder = '',
    disabled = false,
    id,
    class: className = ''
  }: {
    value?: string;
    type?: 'text' | 'email' | 'tel' | 'password' | 'search' | 'number';
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    class?: string;
  } = $props();
</script>

<input
  {id}
  {type}
  {placeholder}
  {disabled}
  bind:value
  class={`h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 ${className}`}
/>
