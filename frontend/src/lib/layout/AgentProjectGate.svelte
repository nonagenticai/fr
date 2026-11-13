<!--
  AgentProjectGate — what a TENANT page shows where the agent used to be
  (fr-agui SPEC §5.1 / §13 P1c, OQ-17 = (c), George 2026-10-14).

  The tenant rail is retired: outside a project the agent is available only on
  the doorway pages (start a project / a request). Everywhere else this says so
  and offers a project picker that goes INTO the project's shell, where the
  project agent lives. Nothing here talks to the agent: no thread is listed,
  created or streamed. Every capability stays in the classic UI.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { activeProject } from '$lib/stores/activeProject.svelte';

	onMount(() => {
		if (!activeProject.loaded) void activeProject.load();
	});

	const projects = $derived(activeProject.projects);
</script>

<div class="flex flex-col gap-3 p-4 text-sm" data-testid="agent-project-gate">
	<p class="font-semibold text-[var(--color-text)]">Open a project to use the agent</p>
	<p class="text-xs text-[var(--color-text-muted)]">
		The agent works inside a project: its board, cards, sign-offs and assets. To start new work,
		<a href="/projects/intake" class="underline">describe a project</a> or
		<a href="/projects/new" class="underline">create one</a>.
	</p>
	{#if activeProject.error && projects.length === 0}
		<p class="text-xs text-[var(--color-danger)]" data-testid="agent-project-gate-error">
			Your projects could not be loaded ({activeProject.error}). Open one from
			<a href="/" class="underline">Projects</a>.
		</p>
	{:else if !activeProject.loaded}
		<p class="text-xs text-[var(--color-text-muted)]">Loading your projects…</p>
	{:else if projects.length === 0}
		<p class="text-xs text-[var(--color-text-muted)]" data-testid="agent-project-gate-empty">
			There are no projects in this workspace yet.
		</p>
	{:else}
		<ul class="flex flex-col gap-1" data-testid="agent-project-gate-list" aria-label="Your projects">
			{#each projects.slice(0, 20) as p (p.id)}
				<li>
					<a
						href={`/projects/${encodeURIComponent(p.id)}`}
						data-testid="agent-project-gate-item"
						class="block truncate rounded px-2 py-1 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
						>{p.name}</a
					>
				</li>
			{/each}
		</ul>
		{#if projects.length > 20}
			<a href="/" class="text-xs underline">All projects →</a>
		{/if}
	{/if}
</div>
