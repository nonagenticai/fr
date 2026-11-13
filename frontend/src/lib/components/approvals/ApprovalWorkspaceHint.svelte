<script lang="ts">
	// ApprovalWorkspaceHint.svelte — fr row 14d, the twin of 14b's
	// WorkspaceEmptyHint.
	//
	// Since 14d every approvals lane reads the ACTIVE workspace only — a
	// super-admin's home view no longer lists every tenant's queue. An empty
	// pending tab can therefore mean "the work is one switch away", and the
	// work must never silently disappear. This lists where it is, with a
	// one-click switch.
	//
	// The list comes from GET /api/me/approval-workspaces: super-admin only,
	// PLATFORM workspaces only — the backend never names or counts a customer
	// workspace, and returns [] for anyone else. This component renders exactly
	// what it is given, nothing when that is empty, and a one-line "could not
	// check" note when the call fails (an outage must not read as "no work
	// elsewhere").
	import { authFetch } from '$lib/api/auth-fetch';
	import { workspaces } from '$lib/stores/workspaces.svelte';

	interface HintWorkspace {
		id: string;
		name: string;
		pending_count: number;
	}

	let others = $state<HintWorkspace[]>([]);
	let loadError = $state<string | null>(null);

	async function load(): Promise<void> {
		try {
			const res = await authFetch('/api/me/approval-workspaces');
			if (!res.ok) {
				loadError = `HTTP ${res.status}`;
				others = [];
				return;
			}
			loadError = null;
			const body = (await res.json()) as { items?: unknown };
			others = Array.isArray(body.items)
				? (body.items as HintWorkspace[]).filter(
						(w) =>
							typeof w?.id === 'string' &&
							typeof w?.name === 'string' &&
							typeof w?.pending_count === 'number' &&
							w.pending_count > 0
					)
				: [];
		} catch (e) {
			loadError = e instanceof Error ? e.message : String(e);
			others = [];
		}
	}

	// Re-ask whenever the active workspace changes: the list never offers the
	// active workspace, so a stale list would offer the one just switched to.
	$effect(() => {
		void workspaces.scopeKey;
		void load();
	});

	async function switchTo(id: string): Promise<void> {
		const { switchTenant } = await import('$lib/actions/switchTenant');
		await switchTenant(id);
	}
</script>

{#if others.length > 0}
	<div class="mt-4 text-center text-sm text-[var(--color-text-muted)]" data-testid="approvals-workspace-hint">
		<p>Pending approvals are waiting in another workspace. Switch workspace →</p>
		<ul class="mt-2 space-y-1" data-testid="approvals-workspace-hint-list">
			{#each others as w (w.id)}
				<li>
					<button
						type="button"
						class="underline text-[var(--color-accent)]"
						data-testid="approvals-workspace-hint-item"
						onclick={() => void switchTo(w.id)}
					>
						{w.name} · {w.pending_count} pending
					</button>
				</li>
			{/each}
		</ul>
	</div>
{:else if loadError}
	<p class="mt-4 text-center text-xs text-[var(--color-text-muted)]" data-testid="approvals-workspace-hint-error">
		Could not check other workspaces for pending approvals ({loadError}).
	</p>
{/if}
