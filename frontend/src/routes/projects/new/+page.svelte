<script lang="ts">
	import { goto } from '$app/navigation';
	import { apiClient } from '$lib/api/unified-client';
	import type { ProjectCreate } from '$lib/types/api';
	import ProjectForm from '$lib/components/ProjectForm.svelte';
	import ConveyorCreateGate from '$lib/components/projects/ConveyorCreateGate.svelte';

	// The 9-section project form lives in the shared <ProjectForm> component so
	// /projects/new (create) and /projects/requests/[id] (review + approve a
	// CP-forwarded draft) stay in lockstep. This page just wires create + redirect.
	async function create(payload: ProjectCreate, meta: { idempotencyKey: string }): Promise<void> {
		await apiClient.projects.create(payload, { idempotencyKey: meta.idempotencyKey });
		goto('/');
	}
</script>

<div class="max-w-4xl mx-auto space-y-6 pb-12">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-3xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">Create New Project</h1>
			<p class="mt-2 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Fill in the project details below. Fields marked with * are required.</p>
		</div>
		<a
			href="/"
			class="px-4 py-2 text-[var(--color-text)] hover:text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-lg hover:bg-[var(--color-surface)] transition-colors dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
		>
			Cancel
		</a>
	</div>

	<ConveyorCreateGate>
	<!--
		Conversational intake (D5, handoff §1): expert mode is the structured form
		below; the /projects/intake path lets you describe the project in plain
		language and have it drafted for review instead.
	-->
	<div
		class="flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-3"
	>
		<div class="flex items-center gap-3">
			<span
				class="grid h-7 w-7 place-items-center rounded-[7px] bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-accent-strong)] text-[11px] font-bold text-white"
				>fr</span
			>
			<p class="text-sm text-[var(--color-text-muted)]">
				<strong class="text-[var(--color-text)]">Describe it instead</strong> — write what you
				want in plain language and we'll draft the project for you to review.
			</p>
		</div>
		<a
			href="/projects/intake"
			class="rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg)]"
		>
			Describe it →
		</a>
	</div>

	<ProjectForm
		submitLabel="Create Project"
		submittingLabel="Creating Project..."
		cancelHref="/"
		onSubmit={create}
	/>
	</ConveyorCreateGate>
</div>
