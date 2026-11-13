<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { apiClient, ApiError } from '$lib/api/unified-client';
	import { auth } from '$lib/stores/auth.svelte';
	import type { ProjectRequest, ProjectRequestStatus } from '$lib/types/api';

	// The CP→fr bridge inbox: project requests Common Practice forwarded as drafts
	// for a human to review + approve. Tenant-scoped by the backend.
	let requests = $state<ProjectRequest[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	// Server-reported total; when it exceeds the loaded rows the status filter
	// narrows a PAGE, and the page says so.
	let total = $state<number | null>(null);

	onMount(load);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await apiClient.projectRequests.list();
			requests = res.items || [];
			total = typeof res.total === 'number' ? res.total : null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load project requests';
		} finally {
			loading = false;
		}
	}

	function badgeClass(status: ProjectRequestStatus): string {
		switch (status) {
			case 'draft':
				return 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]';
			case 'promoted':
				return 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]';
			case 'rejected':
				return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]';
			case 'failed':
				return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]';
			default:
				return 'bg-[var(--color-surface-strong)] text-[var(--color-text)]';
		}
	}

	// UI review 2026-10-07: a status filter over the LOADED rows (values present
	// only), and an inline "New request" that drafts from free text through the
	// same endpoint as /projects/intake, then opens the created draft.
	let statusFilter = $state<string>('');
	const statusValues = $derived([...new Set(requests.map((r) => r.status))].sort());
	const visible = $derived(
		statusFilter ? requests.filter((r) => r.status === statusFilter) : requests,
	);

	let creating = $state(false);
	let newTitle = $state('');
	let newText = $state('');
	let submitting = $state(false);
	let createError = $state<string | null>(null);

	async function submitNew(e: Event) {
		e.preventDefault();
		if (submitting || newText.trim() === '') return;
		submitting = true;
		createError = null;
		try {
			const res = await apiClient.projectRequests.draftFromText({
				text: newText.trim(),
				name: newTitle.trim() || undefined,
			});
			await goto(`/projects/requests/${res.project_request_id}`);
		} catch (err) {
			const data = err instanceof ApiError ? (err.data as { error?: unknown; detail?: unknown } | undefined) : undefined;
			const detail = typeof data?.detail === 'string' ? data.detail : null;
			createError =
				detail ?? (err instanceof Error ? err.message : 'Could not create the request. Try again.');
		} finally {
			submitting = false;
		}
	}

	function originLabel(req: ProjectRequest): string {
		const o = req.external_origin ?? {};
		const by = typeof o.initiated_by === 'string' ? o.initiated_by : null;
		return by ? `${req.source} · ${by}` : req.source;
	}
</script>

<div class="max-w-5xl mx-auto space-y-6 pb-12">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-[var(--color-text)]">Project Requests</h1>
			<p class="mt-2 text-[var(--color-text-muted)]">
				Drafts forwarded from Common Practice. Review, edit, then approve to create a project.
			</p>
		</div>
		<div class="flex items-center gap-2">
			{#if !auth.conveyorCreationDisabled}
			<button
				type="button"
				onclick={() => (creating = !creating)}
				data-testid="project-request-new"
				class="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] transition-colors"
			>
				New request
			</button>
			{/if}
			<a href="/" class="px-4 py-2 text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-lg hover:bg-[var(--color-surface)] transition-colors">Projects</a>
		</div>
	</div>

	{#if creating}
		<form
			class="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
			onsubmit={submitNew}
			data-testid="project-request-new-form"
		>
			<label class="block text-sm">
				<span class="text-[var(--color-text-muted)]">Title (optional — derived from the text if empty)</span>
				<input
					type="text"
					bind:value={newTitle}
					maxlength="255"
					disabled={submitting}
					data-testid="project-request-new-title"
					class="mt-1 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)] disabled:opacity-50"
				/>
			</label>
			<label class="block text-sm">
				<span class="text-[var(--color-text-muted)]">What should the project do?</span>
				<textarea
					bind:value={newText}
					rows="4"
					maxlength="20000"
					required
					disabled={submitting}
					data-testid="project-request-new-text"
					class="mt-1 w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)] disabled:opacity-50"
				></textarea>
			</label>
			{#if createError}
				<p class="text-sm text-[var(--color-danger-text)]" role="alert" data-testid="project-request-new-error">
					Not created: {createError}
				</p>
			{/if}
			<div class="flex gap-2">
				<button
					type="submit"
					disabled={submitting || newText.trim() === ''}
					data-testid="project-request-new-submit"
					class="px-3 py-1.5 rounded bg-[var(--color-accent)] text-sm text-[var(--color-on-primary)] hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
				>
					{submitting ? 'Drafting…' : 'Create draft'}
				</button>
				<button
					type="button"
					onclick={() => (creating = false)}
					disabled={submitting}
					class="px-3 py-1.5 rounded border border-[var(--color-border-strong)] text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-50"
				>
					Cancel
				</button>
			</div>
		</form>
	{/if}

	{#if !loading && !error && statusValues.length > 1}
		<div class="flex items-center gap-2 text-sm">
			<label for="project-request-status" class="text-[var(--color-text-muted)]">Status</label>
			<select
				id="project-request-status"
				bind:value={statusFilter}
				data-testid="project-request-status-filter"
				class="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]"
			>
				<option value="">All ({requests.length})</option>
				{#each statusValues as st (st)}
					<option value={st}>{st} ({requests.filter((r) => r.status === st).length})</option>
				{/each}
			</select>
			{#if total !== null && total > requests.length}
				<span class="text-xs text-[var(--color-warning-text)]" data-testid="project-request-capped">
					First {requests.length} of {total} shown — the filter applies to these only.
				</span>
			{/if}
		</div>
	{/if}

	{#if error}
		<div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4">
			<p class="text-[var(--color-danger)] text-sm">{error}</p>
		</div>
	{/if}

	{#if loading}
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each Array(3) as _}
				<div class="h-32 bg-[var(--color-surface)] rounded-lg animate-pulse"></div>
			{/each}
		</div>
	{:else if error}
		<!-- UI review 2026-10-07: a failed read is reported above; it is not "no requests". -->
	{:else if requests.length === 0}
		<div class="text-center py-16 text-[var(--color-text-muted)]">
			<p class="text-lg">No project requests yet.</p>
			<p class="text-sm mt-1">Requests forwarded from Common Practice will appear here.</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each visible as req (req.id)}
				<a
					href="/projects/requests/{req.id}"
					class="block bg-[var(--color-bg)] rounded-lg shadow p-4 hover:shadow-md transition-shadow dark:bg-[var(--color-surface)]"
				>
					<div class="flex items-start justify-between gap-2">
						<h2 class="font-semibold text-[var(--color-text)] line-clamp-2">
							{req.payload?.name || req.external_ref}
						</h2>
						<span class="shrink-0 px-2 py-0.5 rounded-full text-xs font-medium {badgeClass(req.status)}">
							{req.status}
						</span>
					</div>
					<p class="mt-2 text-xs text-[var(--color-text-muted)]">{originLabel(req)}</p>
					{#if req.payload?.problem_statement}
						<p class="mt-2 text-sm text-[var(--color-text-muted)] line-clamp-2">{req.payload.problem_statement}</p>
					{/if}
					<p class="mt-3 text-xs text-[var(--color-text-muted)]">
						ref {req.external_ref} · {new Date(req.created_at).toLocaleDateString()}
					</p>
				</a>
			{/each}
		</div>
	{/if}
</div>
