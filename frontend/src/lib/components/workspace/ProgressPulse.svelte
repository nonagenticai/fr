<!--
  Project Workspace · Progress pulse.

  The curated, calm read on "where is this project right now" — NOT the raw
  event firehose. Two signals:

    1. A four-phase mantra strip (READYING → DOING → INSPECTING → PUBLISHING,
       per PHILOSOPHY.md), with live card counts derived from the project's
       Planka board, plus a BLOCKED side-count.
    2. An "In flight now" list: the cards currently in DOING — genuinely
       project-scoped and live (read straight off the board), so the user
       sees what the system is working on without scrolling executions.

  Board data is read directly off the shared `kanbanStore` singleton (loaded
  by the Board lens / KanbanProjectPanel). When the board hasn't loaded yet we
  fall back to the headline metrics alone rather than rendering zeros.
-->
<script lang="ts">
	import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
	import { phaseFromListName, isBlocked } from '$lib/cards/phase';
	import type { Phase } from '$lib/cards/types';
	import type { ProjectMetrics } from '$lib/types/api';

	interface Props {
		metrics: ProjectMetrics | null;
		/** Optional: open a card in the workspace (Board lens / overlay). */
		onOpenCard?: (cardId: string) => void;
	}
	let { metrics, onOpenCard }: Props = $props();

	// The four canonical phases, in mantra order, with the list label users
	// recognise from the board.
	const PHASES: Array<{ phase: Phase; label: string }> = [
		{ phase: 'READYING', label: 'Readying' },
		{ phase: 'DOING', label: 'Doing' },
		{ phase: 'INSPECTING', label: 'Inspecting' },
		{ phase: 'PUBLISHING', label: 'Publishing' },
	];

	// listId → list name, so each card can resolve to its AA phase.
	const listNameById = $derived.by(() => {
		const m = new Map<string, string>();
		for (const l of kanbanStore.board?.lists ?? []) m.set(l.id, l.name);
		return m;
	});

	const hasBoard = $derived((kanbanStore.board?.lists?.length ?? 0) > 0);

	// Card counts per phase + a BLOCKED side-count. One pass over the board.
	const counts = $derived.by(() => {
		const byPhase: Record<Phase, number> = {
			READYING: 0,
			DOING: 0,
			INSPECTING: 0,
			PUBLISHING: 0,
		};
		let blocked = 0;
		for (const c of kanbanStore.board?.cards ?? []) {
			const listName = listNameById.get(c.listId) ?? null;
			if (isBlocked(listName)) {
				blocked++;
				continue;
			}
			const p = phaseFromListName(listName);
			if (p) byPhase[p]++;
		}
		return { byPhase, blocked };
	});

	// Cards the system is actively working (DOING), capped — the "happening
	// now" signal. Resolved live off the board.
	const inFlight = $derived.by(() => {
		const rows: Array<{ id: string; name: string }> = [];
		for (const c of kanbanStore.board?.cards ?? []) {
			if (phaseFromListName(listNameById.get(c.listId) ?? null) === 'DOING') {
				rows.push({ id: c.id, name: c.name });
			}
		}
		return rows.slice(0, 6);
	});

	// Headline metrics — only the few that read as a "pulse", not the full grid.
	const headline = $derived.by(() => {
		if (!metrics) return [] as Array<{ label: string; value: string }>;
		const out: Array<{ label: string; value: string }> = [];
		if (metrics.cycle_time_days != null)
			out.push({ label: 'Cycle', value: `${metrics.cycle_time_days.toFixed(1)}d` });
		if (metrics.throughput != null)
			out.push({ label: 'Throughput', value: String(metrics.throughput) });
		if (metrics.success_rate != null)
			out.push({ label: 'Success', value: `${metrics.success_rate.toFixed(0)}%` });
		if (metrics.quality_score != null)
			out.push({ label: 'Quality', value: metrics.quality_score.toFixed(0) });
		return out;
	});
</script>

<section
	class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
	data-testid="progress-pulse"
>
	<h3 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
		Progress
	</h3>

	<!-- Mantra strip -->
	<div class="mt-3 space-y-1">
		{#each PHASES as p (p.phase)}
			<div class="flex items-center justify-between text-sm">
				<span class="text-[var(--color-text)]">{p.label}</span>
				<span class="font-mono text-[var(--color-text)]" class:opacity-40={!hasBoard}>
					{hasBoard ? counts.byPhase[p.phase] : '—'}
				</span>
			</div>
		{/each}
		{#if hasBoard && counts.blocked > 0}
			<div class="flex items-center justify-between text-sm pt-1 mt-1 border-t border-[var(--color-border)]">
				<span class="text-[var(--color-danger)]">Blocked</span>
				<span class="font-mono text-[var(--color-danger)]">{counts.blocked}</span>
			</div>
		{/if}
	</div>

	<!-- Happening now -->
	{#if inFlight.length > 0}
		<div class="mt-4">
			<h4 class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
				In flight now
			</h4>
			<ul class="space-y-0.5">
				{#each inFlight as c (c.id)}
					<li>
						{#if onOpenCard}
							<button
								type="button"
								class="text-left text-sm text-[var(--color-accent)] hover:underline truncate w-full"
								onclick={() => onOpenCard?.(c.id)}
								title={c.name}
							>
								{c.name}
							</button>
						{:else}
							<span class="text-sm text-[var(--color-text)] truncate block" title={c.name}>{c.name}</span>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Headline metrics -->
	{#if headline.length > 0}
		<div class="mt-4 grid grid-cols-2 gap-2">
			{#each headline as m (m.label)}
				<div class="rounded bg-[var(--color-bg)] px-2 py-1.5">
					<div class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">{m.label}</div>
					<div class="text-lg font-semibold text-[var(--color-text)]">{m.value}</div>
				</div>
			{/each}
		</div>
	{/if}
</section>
