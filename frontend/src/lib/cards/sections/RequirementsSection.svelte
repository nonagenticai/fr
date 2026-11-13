<script lang="ts">
	interface Props {
		requirements: Record<string, string>;
		/** UI review 2026-10-07: how many items of this kind the readied brief
		 *  lists. The brief is parsed from the description while this section
		 *  reads the bound custom fields — so a bare "none bound" directly under a
		 *  brief listing five of them read as a contradiction. */
		briefCount?: number;
	}
	let { requirements, briefCount = 0 }: Props = $props();

	const rows = $derived(
		Object.entries(requirements)
			.filter(([, v]) => v && v.trim())
			.map(([k, v]) => ({ slot: k, value: v })),
	);
</script>

<div>
	{#if rows.length === 0 && briefCount > 0}
		<p class="text-sm text-[var(--color-text-muted)] italic" data-testid="brief-listed-not-bound">
			Listed in the readied brief, not bound to the card.
		</p>
	{:else if rows.length === 0}
		<p class="text-sm text-[var(--color-text-muted)] italic">
			No requirements bound to this card.
		</p>
	{:else}
		<ul class="space-y-1.5">
			{#each rows as row (row.slot)}
				<li class="flex items-baseline gap-2 text-sm">
					<span class="font-mono text-xs text-[var(--color-text-muted)] uppercase">
						{row.slot.replace('requirement_', '#')}
					</span>
					<a
						class="text-[var(--color-accent)] hover:text-[var(--color-accent-strong)] hover:underline truncate"
						href={`/requirements/${encodeURIComponent(row.value)}`}
					>
						{row.value}
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
