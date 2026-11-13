<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import BoardView from '$lib/components/kanban/BoardView.svelte';
	import CardModal from '$lib/components/kanban/CardModal.svelte';
	import { reportMutationFailure } from '$lib/components/kanban/mutationFeedback';

	type Props = { boardId: string | null | undefined };
	let { boardId }: Props = $props();

	let error = $state<string | null>(null);

	async function load(id: string) {
		error = null;
		try {
			await kanbanStore.loadBoard(id);
		} catch (err) {
			const e = err as { status?: number; message?: unknown };
			error =
				e?.status === 502
					? 'The board service is currently unavailable.'
					: typeof e?.message === 'string'
						? e.message
						: 'Failed to load board';
		}
	}

	$effect(() => {
		if (boardId) {
			void load(boardId);
		}
	});

	async function refresh() {
		if (boardId) await load(boardId);
	}

	async function openCard(cardId: string) {
		try {
			await kanbanStore.selectCard(cardId);
		} catch (err) {
			// The banner above is bound to the BOARD load, not this one, and the
			// modal simply never opens — a click that does nothing, silently.
			reportMutationFailure('open the card', err);
		}
	}

	function closeCard() {
		kanbanStore.closeSelectedCard();
	}

	onMount(() => {
		kanbanStore.openSocket();
	});

	onDestroy(() => {
		kanbanStore.closeSocket();
	});
</script>

<div class="flex flex-col">
	{#if !boardId}
		<div class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-4 dark:bg-[var(--color-warning-bg)]/20">
			<p class="text-[var(--color-warning-text)] text-sm dark:text-[var(--color-warning-text)]">
				This project is not linked to a board yet. Re-create the project or contact an
				admin to provision one.
			</p>
		</div>
	{:else}
		<div class="flex items-center justify-end mb-3">
			<button
				onclick={refresh}
				disabled={kanbanStore.boardLoading}
				class="px-3 py-1.5 text-sm bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors disabled:opacity-50 dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
			>
				Refresh
			</button>
		</div>

		{#if error}
			<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4 mb-4 dark:bg-[var(--color-danger-bg)]/20">
				<p class="text-[var(--color-danger-text)] text-sm dark:text-[var(--color-danger-text)]">{error}</p>
			</div>
		{:else if kanbanStore.boardLoading}
			<div class="flex flex-col items-center justify-center py-20">
				<div
					class="w-12 h-12 border-4 border-[var(--color-accent)] border-t-blue-600 rounded-full animate-spin"
				></div>
				<p class="mt-4 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Loading board…</p>
			</div>
		{:else if kanbanStore.board}
			<BoardView onOpenCard={openCard} />
		{:else if kanbanStore.boardStale || kanbanStore.error}
			<!--
				The board id resolves but the Planka board was deleted upstream
				(loadBoard sets boardStale + error and returns WITHOUT throwing, so
				the local `error` above never fires). Surface it instead of a blank.
			-->
			<div class="bg-[var(--color-warning-bg)] border border-[var(--color-warning-bg)] rounded-lg p-4 dark:bg-[var(--color-warning-bg)]/20">
				<p class="text-[var(--color-warning-text)] text-sm dark:text-[var(--color-warning-text)]">
					{kanbanStore.error ?? 'This board is no longer available.'}
				</p>
			</div>
		{/if}
	{/if}
</div>

<CardModal onClose={closeCard} />
