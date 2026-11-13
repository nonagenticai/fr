<script lang="ts">
	// One gathered dossier section (demo `.dsec`): a titled card with an optional
	// `↗ deeplink` to the section's full Inspect view. The body is a snippet so a
	// section can hold a key/value list, a diff, a risk list, options, etc.
	import type { Snippet } from 'svelte';

	interface Props {
		/** Section heading, e.g. "Requirements in scope". */
		title: string;
		/** Optional deep-link label, e.g. "↗ assets". */
		deeplink?: string | null;
		/** Fired when the deep-link is clicked (parent navigates). */
		onDeeplink?: () => void;
		children: Snippet;
	}
	let { title, deeplink = null, onDeeplink, children }: Props = $props();
</script>

<div
	class="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] shadow-[var(--shadow-sm)]"
>
	<div
		class="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]"
	>
		{title}
		{#if deeplink}
			<button
				type="button"
				onclick={onDeeplink}
				class="ml-auto text-[11px] font-semibold normal-case tracking-normal text-[var(--color-accent-strong)] hover:underline"
			>
				{deeplink}
			</button>
		{/if}
	</div>
	<div class="p-3.5 text-sm">
		{@render children()}
	</div>
</div>
