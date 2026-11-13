<script lang="ts">
	import type { DecisionRow } from '../types';

	interface Props {
		decisions: DecisionRow[];
		/** UI review 2026-10-07: how many items of this kind the readied brief
		 *  lists. The brief is parsed from the description while this section
		 *  reads the bound custom fields — so a bare "none bound" directly under a
		 *  brief listing five of them read as a contradiction. */
		briefCount?: number;
	}
	let { decisions, briefCount = 0 }: Props = $props();

	function fmtDate(iso: string): string {
		try {
			return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
		} catch {
			return iso;
		}
	}
</script>

<div>
	{#if decisions.length === 0 && briefCount > 0}
		<p class="text-sm text-[var(--color-text-muted)] italic" data-testid="brief-listed-not-bound">
			Listed in the readied brief, not bound to the card.
		</p>
	{:else if decisions.length === 0}
		<p class="text-sm text-[var(--color-text-muted)] italic">
			No decisions recorded.
		</p>
	{:else}
		<ul class="space-y-2.5">
			{#each decisions as row (row.id)}
				<li
					class="text-sm border-l-2 pl-3 py-1 {row.source === 'approval'
						? 'border-[var(--color-accent)]'
						: 'border-[var(--color-border)]'}"
				>
					{#if row.source === 'approval'}
						<div class="flex items-center gap-2 mb-0.5">
							<span
								class="font-mono text-xs px-1.5 py-0.5 rounded uppercase {row.outcome === 'approved'
									? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
									: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'}"
							>
								{row.outcome}
							</span>
							<a
								href={`/approvals/${encodeURIComponent(row.approval_id)}`}
								class="text-xs text-[var(--color-accent)] hover:underline"
							>
								approval →
							</a>
							<span class="ml-auto text-xs text-[var(--color-text-muted)]">
								{fmtDate(row.decided_at)}
							</span>
						</div>
						<p class="text-[var(--color-text)]">{row.approval_description}</p>
						{#if row.comment}
							<p class="text-xs text-[var(--color-text-muted)] mt-0.5 italic">
								"{row.comment}"
							</p>
						{/if}
					{:else}
						<div class="flex items-center gap-2 mb-0.5">
							<span
								class="font-mono text-xs uppercase text-[var(--color-text-muted)]"
							>
								{row.id.replace('decision_', 'd#')}
							</span>
						</div>
						<p class="text-[var(--color-text)] whitespace-pre-wrap">{row.text}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>
