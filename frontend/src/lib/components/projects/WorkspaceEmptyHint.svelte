<script lang="ts">
	// WorkspaceEmptyHint.svelte — fr row 14b.
	//
	// A project is visible only in the workspace its own tag names, so an empty
	// projects page often means "your projects are one switch away", not "you
	// have none" (every super-admin's cold home view is empty since 14b). This
	// says so, and links the EXISTING workspace selector in the header.
	//
	// The optional list comes from GET /api/me/project-workspaces, which returns
	// PLATFORM workspaces only — the backend never names or counts a customer
	// workspace, for any caller. This component renders exactly what it is
	// given and adds nothing; on any failure it degrades to the text + link.
	import { onMount } from 'svelte';
	import { authFetch } from '$lib/api/auth-fetch';
	import { openWorkspaceSwitcher } from '$lib/utils/workspaceSwitcher';

	interface HintWorkspace {
		id: string;
		name: string;
		project_count: number;
	}

	let others = $state<HintWorkspace[]>([]);

	onMount(async () => {
		try {
			const res = await authFetch('/api/me/project-workspaces');
			if (!res.ok) return;
			const body = (await res.json()) as { items?: unknown };
			if (Array.isArray(body.items)) {
				others = (body.items as HintWorkspace[]).filter(
					(w) => typeof w?.id === 'string' && typeof w?.name === 'string' && w.project_count > 0
				);
			}
		} catch {
			// Text + link only.
		}
	});

	async function switchTo(id: string): Promise<void> {
		const { switchTenant } = await import('$lib/actions/switchTenant');
		await switchTenant(id);
	}
</script>

<div class="mt-4 text-center text-sm text-[var(--color-text-muted)]" data-testid="projects-workspace-hint">
	<p>
		No projects in this workspace.
		<button
			type="button"
			class="ml-1 underline text-[var(--color-accent)]"
			data-testid="projects-workspace-hint-switch"
			onclick={openWorkspaceSwitcher}
		>
			Switch workspace →
		</button>
	</p>
	{#if others.length > 0}
		<ul class="mt-2 space-y-1" data-testid="projects-workspace-hint-list">
			{#each others as w (w.id)}
				<li>
					<button
						type="button"
						class="underline"
						data-testid="projects-workspace-hint-item"
						onclick={() => void switchTo(w.id)}
					>
						{w.name} · {w.project_count} {w.project_count === 1 ? 'project' : 'projects'}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
