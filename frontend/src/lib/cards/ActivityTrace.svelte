<!--
  ActivityTrace — canonical legend of the six AA activity patterns.

  v1 is a pattern legend, not an execution trace. The schema
  (`n8n_execution_mapping`) keys executions by `project_id` — not
  `card_id` — so per-card "this step ran at 09:14" attribution is not
  available today without backend work outside Wave A scope. When the
  card_seeker_links table lands (Wave D) the Seeker entry below can
  deep-link into the populated KAG entries.

  Source-of-truth gloss: `n8n_custom_nodes/AA_IMPLEMENTATION/ACTIVITY_PATTERNS.md`
  §3.1–3.6. Edits to that file should be mirrored here.
-->
<script lang="ts">
	interface Props {
		open: boolean;
		onClose: () => void;
	}
	let { open, onClose }: Props = $props();

	type Pattern = {
		id: 'seeker' | 'expansion' | 'compression' | 'conversion' | 'action' | 'reasoning';
		name: string;
		purpose: string;
		reads: readonly string[];
		writes: readonly string[];
		phases: readonly string[];
	};

	const PATTERNS: readonly Pattern[] = [
		{
			id: 'seeker',
			name: 'Seeker',
			purpose: 'Gather relevant context from all 5 dimensions for a given query.',
			reads: ['KAG', 'Requirements', 'Principles', 'Decisions'],
			writes: [],
			phases: ['READYING', 'DOING', 'INSPECTING', 'PUBLISHING'],
		},
		{
			id: 'expansion',
			name: 'Expansion',
			purpose: 'Generate new knowledge to fill gaps when Seeker returns sparse results.',
			reads: [],
			writes: ['KAG', 'Requirements', 'Principles', 'Decisions'],
			phases: ['READYING'],
		},
		{
			id: 'compression',
			name: 'Compression',
			purpose: 'Distil card outcomes into lessons and write them back into KAG.',
			reads: ['KAG', 'Requirements'],
			writes: ['KAG'],
			phases: ['PUBLISHING'],
		},
		{
			id: 'conversion',
			name: 'Conversion',
			purpose: 'Re-shape an artefact from one dimension into another (e.g. decision → requirement).',
			reads: ['Decisions', 'Requirements'],
			writes: ['Requirements'],
			phases: ['DOING'],
		},
		{
			id: 'action',
			name: 'Action',
			purpose: 'Execute a stored procedure step against an external system.',
			reads: [],
			writes: ['KAG'],
			phases: ['DOING'],
		},
		{
			id: 'reasoning',
			name: 'Reasoning',
			purpose: 'Worker-driven inference over seeded context; emits structured output.',
			reads: ['KAG', 'Requirements'],
			writes: [],
			phases: ['DOING', 'INSPECTING'],
		},
	] as const;
</script>

{#if open}
	<!-- Backdrop -->
	<button
		type="button"
		aria-label="Close activity patterns"
		class="fixed inset-0 z-40 bg-black/40"
		onclick={onClose}
	></button>

	<!-- Slide-over -->
	<div
		class="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
		role="dialog"
		aria-modal="true"
		aria-labelledby="activity-trace-title"
	>
		<header
			class="flex items-start justify-between gap-4 border-b border-[var(--color-border)] p-4"
		>
			<div>
				<h2
					id="activity-trace-title"
					class="text-base font-semibold text-[var(--color-text)]"
				>
					Activity patterns
				</h2>
				<p class="mt-1 text-xs text-[var(--color-text-muted)]">
					Every card's phase pattern composes these six activities. Each pattern
					reads and writes a defined subset of the 5D space.
				</p>
			</div>
			<button
				type="button"
				onclick={onClose}
				class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
				aria-label="Close"
			>
				×
			</button>
		</header>

		<div class="flex-1 overflow-y-auto p-4 space-y-4">
			{#each PATTERNS as p (p.id)}
				<section
					class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-3"
				>
					<header class="flex items-baseline justify-between gap-3">
						<h3 class="text-sm font-semibold text-[var(--color-text)]">
							{p.name}
						</h3>
						<div class="flex flex-wrap gap-1">
							{#each p.phases as ph (ph)}
								<span
									class="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
								>
									{ph}
								</span>
							{/each}
						</div>
					</header>
					<p class="mt-1 text-sm text-[var(--color-text)]">
						{p.purpose}
					</p>
					<dl class="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
						<dt class="text-[var(--color-text-muted)]">Reads</dt>
						<dd class="font-mono text-[var(--color-text)]">
							{p.reads.length === 0 ? '—' : p.reads.join(' · ')}
						</dd>
						<dt class="text-[var(--color-text-muted)]">Writes</dt>
						<dd class="font-mono text-[var(--color-text)]">
							{p.writes.length === 0 ? '—' : p.writes.join(' · ')}
						</dd>
					</dl>
				</section>
			{/each}

			<p class="text-xs text-[var(--color-text-muted)] italic">
				Per-card execution timestamps will appear here once card-scoped execution
				attribution lands. Source: AA implementation ACTIVITY_PATTERNS §3.
			</p>
		</div>
	</div>
{/if}
