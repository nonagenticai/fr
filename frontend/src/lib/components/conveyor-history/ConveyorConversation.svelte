<!--
  ConveyorConversation — every ask and sign-off the conveyor sent for this project, newest
  first: what it asked, the answer or decision, who decided, when, and which card. An open
  item links to the existing decide surface; nothing is decided here.
-->
<script lang="ts">
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { ConversationEntry } from '$lib/types/conveyor-history';
  import { askKindLabel, decideHref, decisionLabel, when } from './view';

  let { projectId, block }: { projectId: string; block: Panel<{ entries: ConversationEntry[] }> } = $props();

  const entries = $derived(hasData(block) ? (block.data?.entries ?? []) : []);
</script>

<section data-testid="conveyor-conversation">
  <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
    Conversation with the conveyor{hasData(block) ? ` · ${entries.length}` : ''}
  </h3>
  {#if !hasData(block)}
    <PanelNote panel={block} title="Conversation" />
  {:else if entries.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="conveyor-conversation-empty">
      The conveyor has not asked anything on this project yet.
    </p>
  {:else}
    <ol class="space-y-2">
      {#each entries as e (e.approval_id)}
        <li
          class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs"
          data-testid="conveyor-conversation-entry"
        >
          <div class="flex flex-wrap items-baseline gap-2 text-[11px] text-[var(--color-text-muted)]">
            <span class="font-semibold text-[var(--color-text)]">{askKindLabel(e.ask_kind)}</span>
            {#if e.card_name}<span data-testid="conveyor-conversation-card">on “{e.card_name}”</span>{/if}
            {#if e.card_type}<span>· {e.card_type}</span>{/if}
            {#if e.list}<span>· {e.list}</span>{/if}
            <span class="ml-auto">{when(e.asked_at)}</span>
          </div>
          <p class="mt-1 whitespace-pre-wrap break-words text-[var(--color-text)]" data-testid="conveyor-conversation-question">
            {e.question}
          </p>
          {#if e.context}
            <p class="mt-1 whitespace-pre-wrap break-words text-[var(--color-text-muted)]">{e.context}</p>
          {/if}
          {#if e.open}
            <a
              class="mt-2 inline-block font-semibold text-[var(--color-accent-strong)] underline"
              href={decideHref(projectId, e.approval_id)}
              data-testid="conveyor-conversation-decide">Answer or decide</a
            >
          {:else}
            <div class="mt-2 border-l-2 border-[var(--color-border)] pl-2" data-testid="conveyor-conversation-answer">
              <p class="text-[11px] text-[var(--color-text-muted)]">
                <span class="font-semibold text-[var(--color-text)]">{decisionLabel(e)}</span>
                {#if e.decided_by}by {e.decided_by}{/if}
                {#if e.decided_at}· {when(e.decided_at)}{/if}
              </p>
              {#if e.answer}
                <p class="mt-0.5 whitespace-pre-wrap break-words text-[var(--color-text)]">{e.answer}</p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
