<script lang="ts">
	import type { PlankaLabel } from '$lib/types/api';
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import { reportMutationFailure } from './mutationFeedback';

	// Attach/detach an EXISTING board label only. Label create/update/delete
	// were removed from fr (George 2026-10-10): labels are edited in Planka.
	type Props = {
		cardId: string;
		attachedLabels: PlankaLabel[];
	};
	const { cardId, attachedLabels }: Props = $props();

	let open = $state(false);
	let query = $state('');

	function colorClass(c: string): string {
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
			'modern-green': 'bg-[var(--color-success)]',
			'pirate-gold': 'bg-[var(--color-warning-border)]',
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
		return map[c] ?? 'bg-[var(--color-surface-strong)]';
	}

	const boardLabels = $derived(kanbanStore.board?.labels ?? []);
	const filteredLabels = $derived(
		boardLabels.filter((l) =>
			query.trim() ? (l.name ?? l.color).toLowerCase().includes(query.toLowerCase()) : true
		)
	);
	const attachedIds = $derived(new Set(attachedLabels.map((l) => l.id)));

	async function toggle(labelId: string) {
		if (attachedIds.has(labelId)) {
			try {
				await kanbanStore.detachLabel(cardId, labelId);
			} catch (e) {
				reportMutationFailure('remove the label', e);
			}
		} else {
			try {
				await kanbanStore.attachLabel(cardId, labelId);
			} catch (e) {
				reportMutationFailure('add the label', e);
			}
		}
	}
</script>

<div class="relative" data-testid="label-picker-{cardId}">
	<div class="flex flex-wrap items-center gap-1">
		{#each attachedLabels as label}
			<span
				class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded text-[var(--color-text)] {colorClass(
					label.color
				)}"
			>
				{label.name ?? label.color}
				<button
					class="text-[var(--color-text)]/80 hover:text-[var(--color-text)]"
					aria-label="Detach label"
					onclick={() => toggle(label.id)}>×</button
				>
			</span>
		{/each}
		<button
			class="px-2 py-0.5 text-xs border border-dashed border-[var(--color-border-strong)] rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
			onclick={() => (open = !open)}
			data-testid="label-picker-toggle-{cardId}">+ Label</button
		>
	</div>

	{#if open}
		<div
			class="absolute left-0 mt-2 w-64 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-lg z-20 p-3 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
		>
			<input
				class="w-full mb-2 px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded dark:border-[var(--color-border-strong)]"
				placeholder="Search labels…"
				value={query}
				oninput={(e) => (query = (e.target as HTMLInputElement).value)}
			/>
			<div class="max-h-48 overflow-y-auto space-y-1">
				{#each filteredLabels as l (l.id)}
					<button
						class="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-[var(--color-surface)] text-left dark:hover:bg-[var(--color-surface-strong)]"
						onclick={() => toggle(l.id)}
					>
						<span class="w-3 h-3 rounded {colorClass(l.color)}"></span>
						<span class="text-sm flex-1">{l.name ?? l.color}</span>
						{#if attachedIds.has(l.id)}
							<span class="text-xs text-[var(--color-accent)]">✓</span>
						{/if}
					</button>
				{/each}
				{#if filteredLabels.length === 0}
					<p class="text-xs text-[var(--color-text-muted)] text-center py-2 dark:text-[var(--color-text-muted)]">No labels match</p>
				{/if}
			</div>

			<p class="mt-2 text-xs text-[var(--color-text-muted)]">
				Attach an existing board label. New labels are created on your board.
			</p>
		</div>
	{/if}
</div>
