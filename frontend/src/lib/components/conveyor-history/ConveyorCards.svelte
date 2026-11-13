<!--
  ConveyorCards — every card on the project's board (finished ones included): name, list,
  card type, last move. Expanding a card shows its comments as a timeline, newest first;
  only the human text is shown — the conveyor's JSON blocks (raw ids) never reach the page.
-->
<script lang="ts">
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { HistoryCard } from '$lib/types/conveyor-history';
  import { commentKindLabel, when } from './view';

  let { block }: { block: Panel<{ cards: HistoryCard[] }> } = $props();

  const cards = $derived(hasData(block) ? (block.data?.cards ?? []) : []);
  let openId = $state<string | null>(null);

  function toggle(id: string): void {
    openId = openId === id ? null : id;
  }
</script>

<section data-testid="conveyor-cards">
  <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
    Cards{hasData(block) ? ` · ${cards.length}` : ''}
  </h3>
  {#if !hasData(block)}
    <PanelNote panel={block} title="Cards" />
  {:else}
    {#if block.health !== 'ok'}
      <div class="mb-1" data-testid="conveyor-cards-note"><PanelNote panel={block} title="Cards" /></div>
    {/if}
    {#if cards.length === 0}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="conveyor-cards-empty">The board has no cards yet.</p>
    {:else}
      <ul class="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
        {#each cards as c (c.id)}
          <li data-testid="conveyor-card">
            <button
              type="button"
              class="flex w-full flex-wrap items-baseline gap-2 px-2 py-1.5 text-left text-xs"
              aria-expanded={openId === c.id}
              onclick={() => toggle(c.id)}
              data-testid="conveyor-card-toggle"
            >
              <span class="font-semibold text-[var(--color-text)]">{c.name}</span>
              {#if c.list_name}
                <span class="rounded-full bg-[var(--color-accent-bg)] px-1.5 text-[10px] font-semibold uppercase text-[var(--color-accent-strong)]">{c.list_name}</span>
              {/if}
              {#if c.card_type}<span class="text-[var(--color-text-muted)]">{c.card_type}</span>{/if}
              <span class="ml-auto text-[11px] text-[var(--color-text-muted)]">
                moved {when(c.last_moved_at)} · {c.comments === null ? 'comments unavailable' : `${c.comment_count} ${c.comment_count === 1 ? 'comment' : 'comments'}`}
              </span>
            </button>
            {#if openId === c.id}
              <div class="px-2 pb-2" data-testid="conveyor-card-timeline">
                {#if c.comments === null}
                  <p class="text-xs text-[var(--color-warning-text)]">Unavailable: {c.comments_error ?? 'the comments could not be read'}.</p>
                {:else if c.comments.length === 0}
                  <p class="text-xs text-[var(--color-text-muted)]">No comments on this card.</p>
                {:else}
                  {#if c.comments_truncated}
                    <p class="mb-1 text-xs text-[var(--color-warning-text)]">Only the most recent comments are shown.</p>
                  {/if}
                  <ol class="space-y-1.5 border-l border-[var(--color-border)] pl-2">
                    {#each c.comments as m (m.id)}
                      <li class="text-xs" data-testid="conveyor-card-comment" data-kind={m.kind}>
                        <p class="text-[11px] text-[var(--color-text-muted)]">
                          <span class="font-semibold text-[var(--color-text)]">{commentKindLabel(m.kind)}</span>
                          · {m.author}{#if m.list} · {m.list}{/if} · {when(m.created_at)}
                        </p>
                        {#if m.text}
                          <p class="whitespace-pre-wrap break-words text-[var(--color-text)]">{m.text}</p>
                        {:else if m.summary}
                          <p class="whitespace-pre-wrap break-words text-[var(--color-text)]">{m.summary}</p>
                        {/if}
                      </li>
                    {/each}
                  </ol>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
