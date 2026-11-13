<script lang="ts">
	import ListColumn from './ListColumn.svelte';
	import CardTypeLegend from './CardTypeLegend.svelte';
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import { isBlocked } from '$lib/cards/phase';
	import type { PlankaCard } from '$lib/types/api';

	type Props = {
		onOpenCard: (cardId: string) => void;
	};
	const { onOpenCard }: Props = $props();

	const listsSorted = $derived(
		kanbanStore.board
			? [...kanbanStore.board.lists].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
			: []
	);

	// The BLOCKED jidoka lane is the human's whole job here ("you inspect and
	// unblock"), but it's just the 5th fixed-width column in a horizontally
	// scrolling row — off-screen on a normal viewport, so the board reads as
	// "empty" when the only card is blocked. Surface blocked cards in a banner
	// pinned above the lanes so they're seen without scrolling, regardless of
	// where Planka's `position` puts the lane. Uses the shared isBlocked() so it
	// can never disagree with ListColumn's danger styling.
	const blockedCards = $derived.by(() => {
		const board = kanbanStore.board;
		if (!board) return [] as { id: string; name: string }[];
		const listName = new Map<string, string>();
		for (const l of board.lists) listName.set(l.id, l.name);
		return board.cards
			.filter((c) => isBlocked(listName.get(c.listId) ?? null))
			.map((c) => ({ id: c.id, name: c.name }));
	});

	const cardsByList = $derived.by(() => {
		const map = new Map<string, PlankaCard[]>();
		const board = kanbanStore.board;
		if (!board) return map;
		for (const l of board.lists) {
			map.set(l.id, []);
		}
		for (const c of board.cards) {
			const arr = map.get(c.listId);
			if (arr) arr.push(c);
		}
		for (const arr of map.values()) {
			arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
		}
		return map;
	});
</script>

{#if kanbanStore.board}
	<div class="flex flex-col flex-1 min-h-0" data-testid="board-view">
		{#if blockedCards.length > 0}
			<div
				class="mb-3 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-4 py-3 dark:bg-[var(--color-danger-bg)]/20"
				data-testid="board-blocked-banner"
			>
				<div class="flex items-center gap-2">
					<span aria-hidden="true" class="text-[var(--color-danger-text)]">⚠</span>
					<span class="text-sm font-semibold text-[var(--color-danger-text)]">
						{blockedCards.length} blocked — needs you
					</span>
				</div>
				<ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
					{#each blockedCards as c (c.id)}
						<li>
							<button
								type="button"
								class="max-w-full truncate text-left text-sm text-[var(--color-danger-text)] underline-offset-2 hover:underline"
								onclick={() => onOpenCard(c.id)}
								title={c.name}
								data-testid="board-blocked-card-{c.id}"
							>
								{c.name}
							</button>
						</li>
					{/each}
				</ul>
				<p class="mt-1.5 text-[10px] italic text-[var(--color-text-muted)]">
					The autonomous line stopped these cards for your inspection — open one to unblock.
				</p>
			</div>
		{/if}
		<CardTypeLegend cards={kanbanStore.board.cards} />
		<div class="flex gap-4 overflow-x-auto flex-1 pb-4 min-h-0">
			{#each listsSorted as list (list.id)}
				<ListColumn list={list} cards={cardsByList.get(list.id) ?? []} {onOpenCard} />
			{/each}
		</div>
	</div>
{:else if kanbanStore.boardStale}
	<!--
		REACHABLE since the /kanban + /streams pages stopped gating this component
		on a truthy board (and since loadBoard nulls the board on entry). It was
		dead code before: every mount site rendered BoardView only when a board was
		already loaded, so the stale-board state showed as a blank pane.
	-->
	<div class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]" data-testid="board-stale">
		<p class="font-medium">This board no longer exists.</p>
		<p class="mt-1">It was deleted upstream. Pick another board from the list.</p>
	</div>
{:else}
	<p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]" data-testid="board-empty">
		No board loaded.
	</p>
{/if}
