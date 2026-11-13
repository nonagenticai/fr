<script lang="ts">
	import { PHASES, type Phase } from './types';
	import { phaseFromListName, isBlocked } from './phase';

	interface Props {
		list_name: string | null;
	}

	let { list_name }: Props = $props();

	const current = $derived<Phase | null>(phaseFromListName(list_name));
	const currentIdx = $derived<number>(
		current ? PHASES.indexOf(current) : -1,
	);
	const blocked = $derived<boolean>(isBlocked(list_name));

	function pillClass(idx: number): string {
		if (currentIdx < 0) {
			return 'border-[var(--color-border)] text-[var(--color-text-muted)] opacity-50';
		}
		if (idx < currentIdx) {
			return 'border-[var(--color-success)] text-[var(--color-success)] bg-[var(--color-success-bg)]';
		}
		if (idx === currentIdx) {
			return 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-bg)] font-medium';
		}
		return 'border-[var(--color-border)] text-[var(--color-text-muted)]';
	}
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between">
		<h2 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
			Phase
		</h2>
		{#if blocked}
			<span
				class="px-2 py-0.5 text-xs font-medium rounded border border-[var(--color-danger)] text-[var(--color-danger)] bg-[var(--color-danger-bg)]"
				title="Andon cord engaged — card is blocked"
			>
				BLOCKED
			</span>
		{/if}
	</div>
	<ol class="flex flex-col gap-1.5" aria-label="Card phase progression">
		{#each PHASES as phase, idx (phase)}
			<li
				class="flex items-center gap-2 px-3 py-1.5 rounded border text-sm {pillClass(
					idx,
				)}"
			>
				<span class="font-mono text-xs">{idx + 1}.</span>
				<span>{phase}</span>
				{#if idx === currentIdx}
					<span class="ml-auto text-xs opacity-70">current</span>
				{:else if idx < currentIdx}
					<span class="ml-auto text-xs opacity-70">✓</span>
				{/if}
			</li>
		{/each}
	</ol>
	{#if currentIdx < 0}
		<p class="text-xs text-[var(--color-text-muted)] italic">
			List "{list_name ?? '(none)'}" is outside the AA pipeline.
		</p>
	{/if}
</div>
