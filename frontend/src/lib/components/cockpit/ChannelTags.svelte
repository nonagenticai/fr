<script lang="ts">
	// The "also reachable on" multi-channel row (demo `.channels`/.chtag): a gate
	// can be acted on from Web / Teams / IM / Email. Presentational — the set of
	// channels comes from the approval's reachable-channels (defaults to the
	// canonical four the demo shows).
	interface Props {
		channels?: { icon: string; label: string }[];
		prefix?: string;
	}
	const DEFAULTS = [
		{ icon: '🌐', label: 'Web' },
		{ icon: '💬', label: 'Teams' },
		{ icon: '📱', label: 'IM' },
		{ icon: '✉', label: 'Email' },
	];
	let { channels = DEFAULTS, prefix = 'Also reachable on:' }: Props = $props();
</script>

<div class="flex flex-wrap items-center gap-1.5">
	{#if prefix}
		<span class="text-[11px] text-[var(--color-text-muted)]">{prefix}</span>
	{/if}
	{#each channels as ch (ch.label)}
		<span
			class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-text)]"
		>
			{ch.icon} {ch.label}
		</span>
	{/each}
</div>
