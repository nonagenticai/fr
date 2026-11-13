<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { apiClient } from '$lib/api/unified-client';
	import { registerUnsaved } from '$lib/stores/unsavedWork';
	import ConveyorCreateGate from '$lib/components/projects/ConveyorCreateGate.svelte';

	// Conversational intake (D5). The user describes a project in free text; one
	// single-turn worker extraction (NOT an agent tool-loop — workers stay
	// single-turn per the AA non-agentic philosophy) lands a DRAFT project_request,
	// then we redirect to the existing review page (/projects/requests/:id) where
	// the human edits + approves. Approval routes through the shared
	// createSingleProject, so the *_start_request_analysis card (P-SYS-09 IO-Map)
	// is guaranteed for orchestrated (feature/it) types.

	let text = $state('');
	let name = $state('');
	let submitting = $state(false);
	let error = $state<string | null>(null);

	const canSubmit = $derived(text.trim().length > 0 && !submitting);

	// This page is pure component-local `$state` with no draft persistence, and
	// `/projects/intake` carries no [param] — so a workspace switch keeps the user
	// here and rebuilds the document, which would take the description with it.
	// Returning the unregister from onMount ties the probe to this mount: after
	// a successful submit we `goto` the review page and the guard goes with us.
	onMount(() =>
		registerUnsaved(
			'projects/intake',
			() => text.trim().length > 0 || name.trim().length > 0,
		),
	);

	async function submit(): Promise<void> {
		if (!canSubmit) return;
		submitting = true;
		error = null;
		try {
			const res = await apiClient.projectRequests.draftFromText({
				text: text.trim(),
				name: name.trim() || undefined,
			});
			goto(`/projects/requests/${res.project_request_id}`);
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: 'Could not draft the project from your description. Please try again.';
			submitting = false;
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		// Cmd/Ctrl+Enter submits.
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			void submit();
		}
	}
</script>

<div class="mx-auto max-w-3xl space-y-6 pb-12">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-[var(--color-text)]">Describe your project</h1>
			<p class="mt-2 text-[var(--color-text-muted)]">
				Tell us what you want to build or fix in plain language. We'll draft a
				structured project request for you to review and approve.
			</p>
		</div>
		<a
			href="/projects/new"
			class="rounded-lg border border-[var(--color-border-strong)] px-4 py-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)]"
		>
			Use the form instead
		</a>
	</div>

	<ConveyorCreateGate>
	{#if error}
		<div
			class="rounded-[var(--radius-md)] border border-[var(--color-danger)] bg-[var(--color-danger-subtle,transparent)] px-4 py-3 text-sm text-[var(--color-danger)]"
			role="alert"
			data-testid="intake-error"
		>
			{error}
		</div>
	{/if}

	<div class="space-y-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
		<label class="block">
			<span class="mb-1 block text-sm font-semibold text-[var(--color-text)]">Project name <span class="font-normal text-[var(--color-text-muted)]">(optional)</span></span>
			<input
				type="text"
				bind:value={name}
				maxlength="255"
				placeholder="Leave blank to let us infer it"
				data-testid="intake-name"
				class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-semibold text-[var(--color-text)]">What do you want to do?</span>
			<textarea
				bind:value={text}
				onkeydown={onKeydown}
				rows="8"
				maxlength="20000"
				placeholder="e.g. Build an internal dashboard that shows p95 API latency per service, alerting when it crosses our SLO…"
				data-testid="intake-text"
				class="w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
			></textarea>
		</label>

		<div class="flex items-center justify-between">
			<p class="text-xs text-[var(--color-text-muted)]">
				You'll review and edit everything before anything is created.
			</p>
			<button
				type="button"
				onclick={submit}
				disabled={!canSubmit}
				data-testid="intake-submit"
				class="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--color-accent-strong)] disabled:cursor-not-allowed disabled:opacity-50"
			>
				{submitting ? 'Drafting…' : 'Draft project →'}
			</button>
		</div>
	</div>
	</ConveyorCreateGate>
</div>
