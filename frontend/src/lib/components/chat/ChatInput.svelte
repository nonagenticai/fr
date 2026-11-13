<script lang="ts">
  import { Button } from '$lib/components/ui';
  import { threads } from '$lib/stores/threads.svelte';

  let value = $state('');

  // Pick up text restored by the threads store after a retry-exhausted
  // transient send failure (Cursor / Claude.ai-style draft restore).
  $effect(() => {
    const draft = threads.restoredDraft;
    if (draft !== null) {
      value = draft;
      threads.restoredDraft = null;
    }
  });

  async function send(): Promise<void> {
    const text = value.trim();
    if (!text) return;
    value = '';
    await threads.sendMessage(text);
  }

  function onKeydown(e: KeyboardEvent): void {
    // Enter to send, Shift-Enter for newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<div class="flex items-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-agent-surface="input">
  <textarea
    class="flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed focus:border-[var(--color-accent)] focus:outline-none"
    rows="2"
    placeholder="Ask, instruct, search, or trigger a workflow…"
    bind:value
    onkeydown={onKeydown}
    disabled={threads.streaming}
  ></textarea>
  {#if threads.streaming}
    <Button onclick={() => threads.interrupt()} class="shrink-0">Stop</Button>
  {:else}
    <Button onclick={send} class="shrink-0" disabled={!value.trim()}>Send</Button>
  {/if}
</div>
