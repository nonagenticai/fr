<!--
  ProjectCreateCard — the confirm card for an agent `projects.create` proposal
  (fr-agui SPEC §6.2, W).

  ⛔ ONE DOOR, ONE FORM. It renders the SAME <ProjectForm> /projects/new uses —
  same fields per type, same conditional logic (feature hint, IT remediation
  flow, repository selection), same startable-only type picker, same request
  body — pre-filled from the proposal. On the human's Confirm it sends
  `POST /api/projects` under the human's own session with the proposal's
  `Idempotency-Key`, so a double click or a retry replays the same project.

  There is no GitHub token field: repository access is the GitHub App (George
  2026-10-18). A refusal (503
  conveyor_not_configured, 409, 422, 403) renders verbatim.
-->
<script lang="ts">
	import ProjectForm from '$lib/components/ProjectForm.svelte';
	import { apiClient, ApiError } from '$lib/api/unified-client';
	import type { ProjectCreate } from '$lib/types/api';
	import type { AgentProposal } from '$lib/agui/types';
	import { proposalToFormInitial, verbatimErrorText } from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const initial = $derived(proposalToFormInitial(proposal.input));
	let created = $state<{ id: string; name: string; replayed: boolean } | null>(null);

	async function confirm(payload: ProjectCreate, meta: { idempotencyKey: string }): Promise<void> {
		try {
			const project = (await apiClient.projects.create(payload, {
				idempotencyKey: meta.idempotencyKey,
				proposalId: proposal.proposalId
			})) as unknown as { id: string; name?: string; idempotent_replay?: boolean };
			created = { id: project.id, name: project.name ?? payload.name, replayed: project.idempotent_replay === true };
		} catch (err) {
			// ProjectForm shows an ApiError's message: make it the server's own code + message.
			if (err instanceof ApiError) {
				throw new ApiError(verbatimErrorText(err), err.status, err.statusText, err.data, err.endpoint, err.method);
			}
			throw err;
		}
	}
</script>

<div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid="project-create-card">
	{#if created}
		<div data-testid="project-create-card-done" class="space-y-2">
			<p class="text-[var(--color-text)]">
				{created.replayed ? 'Already created:' : 'Created:'} <strong>{created.name}</strong>
			</p>
			<a
				href={`/projects/${created.id}`}
				data-testid="project-create-card-open"
				class="inline-block rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)]"
			>
				Open project →
			</a>
		</div>
	{:else}
		<p class="mb-2 text-xs text-[var(--color-text-muted)]">
			The agent prepared this project. Review it — nothing is created until you confirm.
		</p>
		<ProjectForm
			{initial}
			idempotencyKey={proposal.idempotencyKey}
			submitLabel="Confirm and create"
			submittingLabel="Creating..."
			cancelHref="/"
			onSubmit={confirm}
		/>
	{/if}
</div>
