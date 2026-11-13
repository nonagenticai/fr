<!--
  KanbanCardView — read-only embed of a single kanban card for the right pane.
  Source: /api/kanban/cards/:id (Planka-proxied via fr-backend), same call
  kanbanStore.selectCard() uses.

  Why read-only and not shared with CardModal:
  CardModal is bound to the singleton `kanbanStore.selectedCard`. Two
  simultaneous edit surfaces (modal + right-pane) on different cards would
  fight over that singleton. Read-only here, full editor in the modal —
  this is a deliberate split. Decoupling kanbanStore from CardModal so
  both surfaces could host the full editor is out of T11's scope.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiClient } from '$lib/api/unified-client';
  import type { PlankaCardDetail } from '$lib/types/api';
  import { Pill } from '$lib/components/ui';

  type Props = { id: string };
  let { id }: Props = $props();

  let detail = $state<PlankaCardDetail | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      detail = await apiClient.kanban.getCard(id);
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function fmtDueDate(d: string | null | undefined): string {
    if (!d) return '—';
    try {
      return new Date(d).toLocaleDateString();
    } catch {
      return d;
    }
  }

  onMount(load);
</script>

<div class="flex flex-col gap-3 p-4">
  <header class="flex items-center justify-between">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">Kanban card</h2>
    <code class="text-xs text-[var(--color-text-muted)]">{id}</code>
  </header>
  {#if error}
    <Pill tone="warning">{error}</Pill>
  {:else if detail === null}
    <div class="text-xs italic text-[var(--color-text-muted)]">Loading…</div>
  {:else}
    {@const card = detail.card}
    <div class="text-base font-semibold text-[var(--color-text)]">{card.name ?? '(untitled)'}</div>
    <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      <dt class="text-[var(--color-text-muted)]">Due</dt>
      <dd>{fmtDueDate(card.dueDate)}</dd>
      <dt class="text-[var(--color-text-muted)]">List</dt>
      <dd><code class="text-xs">{card.listId ?? '—'}</code></dd>
      <dt class="text-[var(--color-text-muted)]">Labels</dt>
      <dd>
        {#if card.labels && card.labels.length > 0}
          <div class="flex flex-wrap gap-1">
            {#each card.labels as label (label.id)}
              <span class="inline-block text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-muted)] text-[var(--color-text)]">
                {label.name ?? label.id}
              </span>
            {/each}
          </div>
        {:else}
          —
        {/if}
      </dd>
      <dt class="text-[var(--color-text-muted)]">Members</dt>
      <dd>{card.memberIds?.length ?? 0}</dd>
      <dt class="text-[var(--color-text-muted)]">Tasks</dt>
      <dd>{detail.tasks?.length ?? 0}</dd>
      <dt class="text-[var(--color-text-muted)]">Comments</dt>
      <dd>{detail.comments?.length ?? 0}</dd>
    </dl>
    {#if card.description}
      <div>
        <h3 class="text-xs font-semibold text-[var(--color-text-muted)] uppercase mb-1">Description</h3>
        <p class="text-xs whitespace-pre-wrap text-[var(--color-text)]">{card.description}</p>
      </div>
    {/if}
  {/if}
</div>
