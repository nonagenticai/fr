<!--
  Band ③ — Phase journey (Planka-sourced, NOT n8n).

  fr and n8n are decoupled through Planka (shared-state / blackboard): n8n
  drives the card through Planka lists; fr reconstructs the journey from the
  list-move actions Planka records on the card. There is no fr→n8n call.

  Renders the createCard + moveCard transitions (backend-mapped to AA
  phases) as a timeline. When the action log is empty or unreachable, it
  degrades to the card's current phase alone.
-->
<script lang="ts">
	import type { PhaseTransition } from '../types';
	import { phaseFromListName, isBlocked } from '../phase';

	interface Props {
		/** `null` means the journey could NOT be read — distinct from `[]`, which
		 *  would mean Planka reported no transitions. Rendering the two the same
		 *  way is what let an unreadable history look like an empty one. */
		journey: PhaseTransition[] | null;
		currentListName: string | null;
		/** Short form of the card's CURRENT Runtime State block_reason, if any. */
		blockReasonText?: string | null;
	}
	let { journey, currentListName, blockReasonText = null }: Props = $props();

	// UI review 2026-10-07: a "QA → BLOCKED" step with nothing beside it read as
	// a rendering gap. A BLOCKED step shows its OWN reason when Planka recorded
	// one (backend `block_reason`, from the field's write history); the current
	// step falls back to the card's current `block_reason`; any other BLOCKED step
	// says plainly that no reason was recorded for it.
	function blockedNote(index: number, t: PhaseTransition): string | null {
		if (!isBlocked(t.to_list)) return null;
		const own = t.block_reason?.trim();
		if (own) return own;
		const isCurrent = journey !== null && index === journey.length - 1 && isBlocked(currentListName);
		return isCurrent && blockReasonText ? blockReasonText : 'no reason recorded';
	}

	const currentPhase = $derived(phaseFromListName(currentListName));

	function fmt(iso: string | null): string {
		if (!iso) return '';
		try {
			return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
		} catch {
			return iso;
		}
	}
</script>

<div>
	{#if journey === null}
		<div class="text-sm">
			{#if currentPhase}
				<p class="text-[var(--color-text)]">
					Currently in <span class="font-mono">{currentPhase}</span>
					{#if currentListName}
						<span class="text-[var(--color-text-muted)]">(list: {currentListName})</span>
					{/if}
				</p>
			{/if}
			<p class="text-[var(--color-text-muted)] italic mt-1">
				Phase history unavailable — the board's activity log could not be read. This
				is not the same as the card having no transitions.
			</p>
		</div>
	{:else if journey.length === 0}
		<div class="text-sm">
			{#if currentPhase}
				<p class="text-[var(--color-text)]">
					Currently in <span class="font-mono">{currentPhase}</span>
					{#if currentListName}
						<span class="text-[var(--color-text-muted)]">(list: {currentListName})</span>
					{/if}
				</p>
			{/if}
			<p class="text-[var(--color-text-muted)] italic mt-1">
				No list-transition history is available for this card.
			</p>
		</div>
	{:else}
		<ol class="space-y-2.5">
			{#each journey as t, i (t.action_id)}
				{@const note = blockedNote(i, t)}
				<li class="flex items-baseline gap-3 text-sm">
					<span class="font-mono text-xs text-[var(--color-text-muted)] shrink-0 w-32">
						{fmt(t.at)}
					</span>
					<span class="flex-1">
						{#if t.type === 'createCard'}
							<span class="text-[var(--color-text-muted)]">created in</span>
							<span class="font-mono text-[var(--color-text)]">{t.to_list ?? '—'}</span>
						{:else}
							<span class="font-mono text-[var(--color-text-muted)]">{t.from_list ?? '—'}</span>
							<span class="text-[var(--color-text-muted)]"> → </span>
							<span class="font-mono text-[var(--color-text)]">{t.to_list ?? '—'}</span>
						{/if}
						{#if note}
							<span
								class="block text-xs text-[var(--color-text-muted)] italic break-words"
								data-testid="journey-block-note"
							>
								{note}
							</span>
						{/if}
					</span>
					{#if t.to_phase}
						<span
							class="font-mono text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--color-surface-strong)] text-[var(--color-text-muted)] shrink-0"
							class:phase-change={t.from_phase !== t.to_phase}
						>
							{t.to_phase}
						</span>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</div>

<style>
	/* A phase boundary (not just an intra-phase list move) gets emphasis. */
	.phase-change {
		background: var(--color-accent-bg);
		color: var(--color-accent);
	}
</style>
