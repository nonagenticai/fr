<script lang="ts">
  import type { Snippet } from 'svelte';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
  type Size = 'sm' | 'md' | 'lg';

  let {
    variant = 'secondary',
    size = 'md',
    type = 'button',
    disabled = false,
    onclick,
    children,
    class: className = ''
  }: {
    variant?: Variant;
    size?: Size;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
    class?: string;
  } = $props();

  const variantClass = $derived(
    {
      primary:
        'bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)]',
      secondary:
        'bg-[var(--color-surface-strong)] text-[var(--color-text)] hover:bg-[var(--color-border)]',
      ghost:
        'bg-transparent text-[var(--color-text)] hover:bg-[var(--color-surface)]',
      danger:
        'bg-[var(--color-danger)] text-[var(--color-on-primary)] hover:opacity-90'
    }[variant]
  );

  const sizeClass = $derived(
    {
      sm: 'h-8 px-3 text-sm',
      md: 'h-10 px-4 text-sm',
      lg: 'h-12 px-6 text-base'
    }[size]
  );
</script>

<button
  {type}
  {disabled}
  {onclick}
  class={`inline-flex items-center justify-center rounded-[var(--radius-md)] font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${variantClass} ${sizeClass} ${className}`}
>
  {@render children()}
</button>
