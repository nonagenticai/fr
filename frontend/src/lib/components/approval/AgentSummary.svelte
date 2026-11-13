<script lang="ts">
	// The "don't read it all" path (demo `.agent-summary`): the agent's gathered
	// gist of an approval + a one-line recommendation, atop the dossier. Points
	// the human at the docked copilot to interrogate the same context.
	interface Props {
		/** The agent's plain-language summary (may contain inline markup). */
		summary: string;
		/** One-line recommendation, e.g. "✦ My read: safe to approve — …". */
		recommendation?: string | null;
		/**
		 * Show the "Ask the copilot →" hint. True on surfaces that actually dock a
		 * copilot (the project approve cockpit); pass false where there is none
		 * (the standalone /approvals/[id] review page) so it isn't a dead pointer.
		 */
		copilotHint?: boolean;
	}
	let { summary, recommendation = null, copilotHint = true }: Props = $props();
</script>

<div
	class="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] p-3.5"
>
	<div
		class="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-accent-strong)] text-[11px] font-bold text-white"
	>
		fr
	</div>
	<div class="text-sm">
		<!-- summary is agent-authored prose; rendered as-is so inline <strong>/<span class="mono"> survive -->
		<p>{@html summary}</p>
		{#if recommendation}
			<p class="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-[var(--color-accent-strong)]">
				{recommendation}
			</p>
		{/if}
		{#if copilotHint}
			<p class="mt-2 text-xs text-[var(--color-text-muted)]">
				Don't want to read it all? <strong>Ask the copilot →</strong> it has the full context loaded.
			</p>
		{/if}
	</div>
</div>
