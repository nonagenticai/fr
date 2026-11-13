<script lang="ts">
  let {
    title,
    subtitle = '',
    active = false,
    href = undefined,
    onclick,
    class: className = ''
  }: {
    title: string;
    subtitle?: string;
    active?: boolean;
    href?: string;
    onclick?: (e: MouseEvent) => void;
    class?: string;
  } = $props();

  const cls = $derived(
    `flex w-full flex-col items-start gap-0.5 rounded-[var(--radius-md)] px-3 py-2 text-left text-sm transition hover:bg-[var(--color-surface-strong)] ${active ? 'bg-[var(--color-surface-strong)] text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'} ${className}`
  );
</script>

{#if href}
  <a {href} {onclick} class={cls}>
    <span class="truncate font-medium text-[var(--color-text)]">{title}</span>
    {#if subtitle}
      <span class="truncate text-xs text-[var(--color-text-muted)]">{subtitle}</span>
    {/if}
  </a>
{:else}
  <button type="button" {onclick} class={cls}>
    <span class="truncate font-medium text-[var(--color-text)]">{title}</span>
    {#if subtitle}
      <span class="truncate text-xs text-[var(--color-text-muted)]">{subtitle}</span>
    {/if}
  </button>
{/if}
