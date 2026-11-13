<script lang="ts">
	// ListColumn — one column in the kanban board. Renders a card stack plus
	// an inline compose-card affordance. Lists themselves are read-only in
	// fr (no rename/delete) — list lifecycle is owned upstream (Planka /
	// improvement-stream provisioning).
	import type { PlankaCard, PlankaList } from '$lib/types/api';
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import { dndzone } from 'svelte-dnd-action';
	import { isBlocked as isBlockedList } from '$lib/cards/phase';
	import { computeCardMoves, DragSnapshot } from './cardMoves';
	import CardTypeBadge from './CardTypeBadge.svelte';
	import { reportMutationFailure } from './mutationFeedback';

	type Props = {
		list: PlankaList;
		cards: PlankaCard[];
		onOpenCard: (cardId: string) => void;
	};
	const { list, cards, onOpenCard }: Props = $props();

	let composing = $state(false);
	let newName = $state('');
	// In-flight guard for the create. `submitNew` is bound to BOTH the "Add
	// card" button and Enter in the textarea, so a double-click — or
	// Enter-then-click — used to POST twice and leave two identical cards on
	// the board. Guarding the handler (not just the button) is what closes the
	// Enter path. Idiom: lib/bridge/PromoteButton.svelte.
	let creatingCard = $state(false);

	function labelColorClass(color: string): string {
		const map: Record<string, string> = {
			'berry-red': 'bg-[var(--color-danger)]',
			'pumpkin-orange': 'bg-[var(--color-warning)]',
			'lagoon-blue': 'bg-[var(--color-accent)]',
			'pink-tulip': 'bg-[var(--color-danger-border)]',
			'light-mud': 'bg-[var(--color-warning)]',
			'orange-peel': 'bg-[var(--color-warning-border)]',
			'bright-moss': 'bg-[var(--color-success)]',
			'antique-blue': 'bg-[var(--color-accent)]',
			'dark-granite': 'bg-[var(--color-surface-strong)]',
			'morning-sky': 'bg-[var(--color-accent)]',
			'light-orange': 'bg-[var(--color-warning-border)]',
			'midnight-blue': 'bg-[var(--color-accent-strong)]',
			'tank-green': 'bg-[var(--color-success)]',
			'gun-metal': 'bg-[var(--color-surface-strong)]',
			'wet-moss': 'bg-[var(--color-success)]',
			'red-burgundy': 'bg-[var(--color-danger-text)]',
			'light-concrete': 'bg-[var(--color-surface-strong)]',
			'apricot-red': 'bg-[var(--color-danger)]',
			'desert-sand': 'bg-[var(--color-warning-border)]',
			'navy-blue': 'bg-[var(--color-accent-strong)]',
			'egg-yellow': 'bg-[var(--color-warning-border)]',
			'coral-green': 'bg-[var(--color-success)]',
			'light-cocoa': 'bg-[var(--color-warning-border)]'
		};
		return map[color] ?? 'bg-[var(--color-surface-strong)]';
	}

	function formatDate(d: string | null): string {
		if (!d) return '';
		return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	function isPast(d: string | null): boolean {
		return d ? new Date(d) < new Date() : false;
	}

	// Shared matcher (`.includes('BLOCK')`) so the danger styling here always
	// agrees with the board-level blocked banner in BoardView.
	const isBlocked = $derived(isBlockedList(list.name ?? null));

	async function submitNew() {
		if (creatingCard) return;
		const name = newName.trim();
		if (!name) return;
		// Planka 2.1.0 requires a position on card create (422 "Position must be
		// present" otherwise). Append after the last existing card in this list.
		const last = cards[cards.length - 1]?.position ?? 0;
		const position = last + 65536;
		creatingCard = true;
		try {
			await kanbanStore.createCard(list.id, { name, position });
			// Reset only on success — a failed create keeps the composer open
			// with the title the user typed.
			newName = '';
			composing = false;
		} catch (e) {
			reportMutationFailure('add the card', e);
		} finally {
			// In a `finally` so a THROWN create does not wedge the button.
			creatingCard = false;
		}
	}

	// DnD wiring: svelte-dnd-action wants objects with an `id` field on the
	// dnd-zone items array. PlankaCard already satisfies that.
	// One per column instance; capture-once per gesture. See cardMoves.ts.
	const dragSnapshot = new DragSnapshot();

	function handleConsider(e: CustomEvent<{ items: PlankaCard[] }>) {
		// Let dnd-action morph the DOM; the real state change happens on finalize.
		// We still want the visual to reflect the pending order during drag, so
		// swap the store slice for this list in place.
		const board = kanbanStore.board;
		if (!board) return;
		// MUST run before the mutation below: consider rewrites board.cards for the
		// drag visual, so this is the last point the pre-drag order still exists.
		dragSnapshot.begin(board.cards);
		const incoming = e.detail.items;
		// Remove all cards in this list AND any incoming-card IDs from elsewhere
		// (during cross-list drag, the source card still has its old listId in
		// `board.cards` — keeping both would duplicate the key).
		const incomingIds = new Set(incoming.map((c) => c.id));
		const others = board.cards.filter((c) => c.listId !== list.id && !incomingIds.has(c.id));
		board.cards = [...others, ...incoming.map((c) => ({ ...c, listId: list.id }))];
	}

	async function handleFinalize(e: CustomEvent<{ items: PlankaCard[] }>) {
		const items = e.detail.items;
		const board = kanbanStore.board;
		if (!board) return;
		const incomingIds = new Set(items.map((c) => c.id));
		const others = board.cards.filter((c) => c.listId !== list.id && !incomingIds.has(c.id));
		// The pre-DRAG order, captured at the first `consider`. Reading board.cards
		// here would give the post-drag order (consider already rewrote it), the
		// diff would be empty, and nothing would persist.
		const previous = dragSnapshot.end(board.cards);
		board.cards = [...others, ...items.map((c) => ({ ...c, listId: list.id }))];

		// Only the cards that genuinely changed list or index — see cardMoves.ts
		// for why the previous "call moveCard for everything" approach existed and
		// what it cost.
		for (const move of computeCardMoves(previous, items, list.id)) {
			try {
				await kanbanStore.moveCard(move.cardId, {
					toListId: move.toListId,
					position: move.position
				});
			} catch (e) {
				// A rejected move means the server never moved the card, so Planka
				// emits NO websocket event — there is nothing to "refresh from".
				// The store's rollback (the card flying back) is ALL the user sees,
				// so it needs a reason.
				//
				// And stop: one drop can produce several moves, and continuing past
				// a rejection would apply the rest on top of an order the server
				// refused, leaving a partially-applied reorder that matches neither
				// what the user dragged nor what Planka holds.
				reportMutationFailure('move the card', e);
				break;
			}
		}
	}
</script>

<div
	class="flex-shrink-0 w-72 flex flex-col rounded-lg max-h-full {isBlocked
		? 'bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] dark:bg-[var(--color-danger-bg)]/20'
		: 'bg-[var(--color-surface)] dark:bg-[var(--color-surface)]'}"
>
	<!-- Header -->
	<div
		class="px-3 py-2 rounded-t-lg flex items-center justify-between gap-2 flex-shrink-0 {isBlocked
			? 'bg-[var(--color-danger-bg)] border-b-2 border-[var(--color-danger-border)] dark:bg-[var(--color-danger-bg)]/30'
			: 'bg-[var(--color-surface-strong)] dark:bg-[var(--color-surface-strong)]'}"
	>
		<span
			class="flex-1 text-sm font-semibold truncate {isBlocked
				? 'text-[var(--color-danger-text)]'
				: 'text-[var(--color-text)] dark:text-[var(--color-text-muted)]'}"
		>
			{list.name}
		</span>
		<span
			class="px-2 py-0.5 text-xs font-medium rounded-full flex-shrink-0 {isBlocked
				? 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
				: 'bg-[var(--color-surface-strong)] text-[var(--color-text)] dark:text-[var(--color-text-muted)]'}"
		>
			{cards.length}
		</span>
	</div>

	<!-- Card stack (dnd zone) -->
	<div
		use:dndzone={{
			items: cards,
			type: 'kanban-card',
			flipDurationMs: 150,
			dropTargetStyle: {},
			dropTargetClasses: ['bg-[var(--color-accent)]', 'dark:bg-[var(--color-accent-strong)]/20']
		}}
		onconsider={handleConsider}
		onfinalize={handleFinalize}
		class="flex-1 overflow-y-auto p-2 space-y-2 min-h-[40px]"
		data-testid="list-dropzone-{list.id}"
	>
		{#each cards as card (card.id)}
			<div
				class="bg-[var(--color-bg)] rounded-lg shadow-sm border border-[var(--color-border)] p-3 hover:shadow-md hover:border-[var(--color-accent)] transition-all cursor-pointer dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
				data-testid="card-{card.id}"
			>
				<button class="w-full text-left" onclick={() => onOpenCard(card.id)}>
					{#if card.labels && card.labels.length > 0}
						<div class="flex flex-wrap gap-1 mb-2">
							{#each card.labels as label}
								<span
									class="inline-block h-2 rounded-full {labelColorClass(label.color)}"
									style="width: {label.name ? 'auto' : '2rem'}; {label.name
										? 'padding: 0 0.5rem;'
										: ''}"
									title={label.name || label.color}
								>
									{#if label.name}
										<span class="text-[var(--color-text)] text-[10px] leading-none font-medium">{label.name}</span>
									{/if}
								</span>
							{/each}
						</div>
					{/if}
					<div class="flex items-start gap-2">
						<span class="mt-1.5">
							<CardTypeBadge cardType={card.card_type} cardGroup={card.card_group} />
						</span>
						<p class="text-sm font-medium text-[var(--color-text)] leading-snug dark:text-[var(--color-text)]">{card.name}</p>
					</div>

					<div class="flex items-center gap-2 mt-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
						{#if card.dueDate}
							<span
								class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded {isPast(
									card.dueDate
								)
									? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
									: 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]'}"
							>
								{formatDate(card.dueDate)}
							</span>
						{/if}
						{#if card.memberIds && card.memberIds.length > 0}
							<span class="inline-flex items-center gap-1">
								<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
									/>
								</svg>
								{card.memberIds.length}
							</span>
						{/if}
						{#if card.description}
							<span title="Has description">
								<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 6h16M4 12h16M4 18h7"
									/>
								</svg>
							</span>
						{/if}
					</div>
				</button>
			</div>
		{/each}
	</div>

	<!-- Add-card composer -->
	<div class="p-2 flex-shrink-0">
		{#if composing}
			<div class="flex flex-col gap-2">
				<textarea
					class="w-full px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded resize-none dark:border-[var(--color-border-strong)]"
					rows="2"
					placeholder="Card title"
					value={newName}
					oninput={(e) => (newName = (e.target as HTMLTextAreaElement).value)}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							submitNew();
						}
					}}
				></textarea>
				<div class="flex gap-2">
					<button
						class="px-3 py-1 text-sm bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] disabled:opacity-50 disabled:cursor-not-allowed"
						onclick={submitNew}
						disabled={creatingCard}
						data-testid="add-card-submit-{list.id}"
					>
						Add card
					</button>
					<button
						class="px-3 py-1 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] rounded dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
						onclick={() => {
							composing = false;
							newName = '';
						}}
					>
						Cancel
					</button>
				</div>
			</div>
		{:else}
			<button
				class="w-full px-2 py-1 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-strong)] rounded text-left dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
				onclick={() => (composing = true)}
				data-testid="add-card-{list.id}"
			>
				+ Add a card
			</button>
		{/if}
	</div>
</div>
