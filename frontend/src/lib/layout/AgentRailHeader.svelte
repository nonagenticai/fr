<script lang="ts">
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { threadPreviewText } from '$lib/api/agent-redact';
  import { threads } from '$lib/stores/threads.svelte';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ExternalLink from 'lucide-svelte/icons/external-link';
  import X from 'lucide-svelte/icons/x';

  let pickerOpen = $state(false);

  const activeTitle = $derived(
    threadPreviewText(
      threads.threads.find((t) => t.id === agentRail.activeThreadId)?.lastMessagePreview,
      'New conversation',
    ),
  );

  async function newThread(): Promise<void> {
    const t = await threads.create({
      channel: 'web',
      projectId: agentRail.projectId,
    });
    agentRail.openThread(t.id);
    pickerOpen = false;
  }
</script>

<header
  class="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
>
  <div class="flex items-center gap-1">
    <button
      type="button"
      class="rounded px-2 py-1 text-xs"
      class:bg-[var(--color-surface-strong)]={agentRail.tab === 'agent'}
      onclick={() => agentRail.switchTab('agent')}
    >
      Agent
    </button>
    <button
      type="button"
      class="rounded px-2 py-1 text-xs"
      class:bg-[var(--color-surface-strong)]={agentRail.tab === 'detail'}
      onclick={() => agentRail.switchTab('detail')}
    >
      Detail
    </button>
  </div>

  {#if agentRail.tab === 'agent'}
    <div class="relative ml-2 flex-1">
      <button
        type="button"
        class="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--color-surface-strong)]"
        onclick={() => (pickerOpen = !pickerOpen)}
      >
        <span class="truncate">{activeTitle}</span>
        <ChevronDown size={12} />
      </button>
      {#if pickerOpen}
        <div
          class="absolute z-10 mt-1 max-h-72 w-72 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-strong)]"
            onclick={newThread}
          >
            + New conversation
          </button>
          {#each threads.threads.slice(0, 10) as t (t.id)}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-[var(--color-surface-strong)]"
              onclick={() => {
                agentRail.openThread(t.id);
                pickerOpen = false;
              }}
            >
              <span class="truncate">{threadPreviewText(t.lastMessagePreview, 'New conversation')}</span>
            </button>
          {/each}
          <a
            class="block border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-accent)]"
            href="/threads"
            onclick={() => (pickerOpen = false)}
          >
            View all conversations →
          </a>
        </div>
      {/if}
    </div>
    {#if agentRail.activeThreadId}
      <a
        class="flex items-center justify-center rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-accent)]"
        href={`/threads/${agentRail.activeThreadId}`}
        title="Open in focus mode"
        aria-label="Open in focus mode"
      >
        <ExternalLink size={14} />
      </a>
    {/if}
  {/if}

  <button
    type="button"
    class="ml-auto flex items-center justify-center rounded p-1 hover:bg-[var(--color-surface-strong)]"
    onclick={() => agentRail.close()}
    aria-label="Close agent rail"
  >
    <X size={16} />
  </button>
</header>
