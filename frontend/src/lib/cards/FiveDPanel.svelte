<script lang="ts">
	import type { CardDetail } from './types';
	import PrinciplesSection from './sections/PrinciplesSection.svelte';
	import RequirementsSection from './sections/RequirementsSection.svelte';
	import DecisionsSection from './sections/DecisionsSection.svelte';
	import KagSection from './sections/KagSection.svelte';
	import type { ReadiedBrief } from './readiedBrief';

	interface Props {
		card: CardDetail;
		/** The readied brief parsed from the description (CardDetailSections). */
		brief?: ReadiedBrief | null;
	}
	let { card, brief = null }: Props = $props();

	// UI review 2026-10-07: the brief and the bound custom fields are two
	// sources; each section says "listed in the brief, not bound" instead of a
	// bare "none bound" when only the brief carries items of its kind.
	const briefCounts = $derived({
		principles: brief?.principles_applied?.length ?? 0,
		requirements: brief?.requirements_in_scope?.length ?? 0,
		decisions: brief?.decisions?.length ?? 0,
	});

	// Canonical 5D order per PHILOSOPHY.md §5D. Each section is rendered
	// even when empty — an empty dimension is a *signal*, not a bug, and
	// keeping the slot visible reinforces the doctrine.
	const sections = $derived([
		{ id: 'principles', label: 'Principles' },
		{ id: 'requirements', label: 'Requirements' },
		{ id: 'decisions', label: 'Decisions' },
		{ id: 'kag', label: 'KAG' },
	] as const);

	let open = $state<Record<string, boolean>>({
		principles: true,
		requirements: true,
		decisions: true,
		kag: true,
	});
</script>

<div class="space-y-4">
	{#each sections as s (s.id)}
		<section
			class="border border-[var(--color-border)] rounded-md bg-[var(--color-surface)]"
		>
			<header class="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
				<h3 class="text-sm font-medium text-[var(--color-text)]">
					{s.label}
				</h3>
				<button
					type="button"
					class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] font-mono"
					onclick={() => (open[s.id] = !open[s.id])}
					aria-expanded={open[s.id]}
				>
					{open[s.id] ? '−' : '+'}
				</button>
			</header>
			{#if open[s.id]}
				<div class="px-4 py-3">
					{#if s.id === 'principles'}
						<PrinciplesSection principles={card.groups.Principles ?? {}} briefCount={briefCounts.principles} />
					{:else if s.id === 'requirements'}
						<RequirementsSection
							requirements={card.groups.Requirements ?? {}}
							briefCount={briefCounts.requirements}
						/>
					{:else if s.id === 'decisions'}
						<DecisionsSection decisions={card.decisions} briefCount={briefCounts.decisions} />
					{:else if s.id === 'kag'}
						<KagSection kag_seeker={card.kag_seeker} />
					{/if}
				</div>
			{/if}
		</section>
	{/each}
</div>
