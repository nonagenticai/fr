<script lang="ts">
	// The redesign's dotted tag set (demo `.tag`/.dot). Distinct from `Pill`:
	// adds the `info` (violet) tone the demo uses pervasively + an optional
	// leading status dot. Token-driven, bordered (the demo tags carry a border
	// the bare Pill does not).
	import type { Snippet } from 'svelte';

	type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

	let {
		tone = 'neutral',
		dot = false,
		children,
		class: className = '',
	}: { tone?: Tone; dot?: boolean; children: Snippet; class?: string } = $props();

	const toneClass = $derived(
		{
			neutral:
				'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]',
			accent:
				'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-accent-strong)]',
			success:
				'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
			warning:
				'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
			danger:
				'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]',
			info: 'border-[var(--color-info-border)] bg-[var(--color-info-bg)] text-[var(--color-info-text)]',
		}[tone],
	);
</script>

<span
	class={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${toneClass} ${className}`}
>
	{#if dot}
		<span class="h-1.5 w-1.5 flex-none rounded-full bg-current"></span>
	{/if}
	{@render children()}
</span>
