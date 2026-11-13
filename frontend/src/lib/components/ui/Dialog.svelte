<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    open = $bindable(false),
    title,
    children,
    class: className = ''
  }: { open?: boolean; title?: string; children: Snippet; class?: string } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  });

  function onClose() {
    open = false;
  }
</script>

<dialog
  bind:this={dialogEl}
  onclose={onClose}
  class={`rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-0 text-[var(--color-text)] backdrop:bg-black/40 ${className}`}
>
  <div class="flex flex-col gap-4 p-6 min-w-[320px] max-w-[640px]">
    {#if title}
      <h2 class="text-lg font-semibold">{title}</h2>
    {/if}
    {@render children()}
  </div>
</dialog>
