<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Button } from '.';

  let {
    icon,
    title,
    body = '',
    actionLabel = '',
    onAction,
    class: className = ''
  }: {
    icon?: Snippet;
    title: string;
    body?: string;
    actionLabel?: string;
    onAction?: () => void;
    class?: string;
  } = $props();

  const showAction = $derived(Boolean(actionLabel && onAction));
</script>

<div
  data-testid="empty-state"
  class={`flex flex-col items-center justify-center gap-3 py-12 px-6 text-center ${className}`}
>
  {#if icon}
    <div class="text-[var(--color-text-muted)]" data-testid="empty-state-icon">
      {@render icon()}
    </div>
  {/if}
  <h3 class="text-lg font-semibold text-[var(--color-text)]" data-testid="empty-state-title">
    {title}
  </h3>
  {#if body}
    <p class="text-sm text-[var(--color-text-muted)] max-w-md" data-testid="empty-state-body">
      {body}
    </p>
  {/if}
  {#if showAction}
    <div class="mt-2">
      <Button variant="primary" onclick={onAction}>
        {actionLabel}
      </Button>
    </div>
  {/if}
</div>
