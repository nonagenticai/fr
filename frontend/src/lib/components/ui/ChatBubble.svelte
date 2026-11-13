<script lang="ts">
  import type { Snippet } from 'svelte';
  type Role = 'user' | 'agent' | 'system';

  let {
    role,
    children,
    class: className = ''
  }: { role: Role; children: Snippet; class?: string } = $props();

  const roleClass = $derived(
    role === 'user'
      ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)] self-end'
      : role === 'agent'
        ? 'bg-[var(--color-surface-strong)] text-[var(--color-text)] self-start'
        : 'bg-transparent text-[var(--color-text-muted)] italic self-center'
  );
</script>

<div
  class={`max-w-[75%] rounded-[var(--radius-lg)] px-4 py-2 text-sm leading-relaxed ${roleClass} ${className}`}
>
  {@render children()}
</div>
