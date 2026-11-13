<script lang="ts">
	// Hides project-creation UI on an instance without the v4 conveyor wiring
	// (auth.conveyorCreationDisabled ← GET /api/auth/me `conveyor_configured`).
	// The backend refuses those creates 503 `conveyor_not_configured` regardless;
	// this only stops the UI offering a form that can never succeed.
	import type { Snippet } from 'svelte';
	import { auth } from '$lib/stores/auth.svelte';

	let { children }: { children: Snippet } = $props();
</script>

{#if auth.conveyorCreationDisabled}
	<div
		data-testid="conveyor-not-configured"
		role="status"
		class="rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-muted)]"
	>
		<strong class="text-[var(--color-text)]">Project creation is off on this instance.</strong>
		The delivery conveyor is not configured here, so new projects and project requests cannot be started.
	</div>
{:else}
	{@render children()}
{/if}
