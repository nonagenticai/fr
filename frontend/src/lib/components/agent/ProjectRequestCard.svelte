<!--
  ProjectRequestCard — the confirm card for the doorway agent's project-request
  proposals (fr-agui SPEC §5.2 W, §6.0): draft from text, edit, submit, approve,
  reject, withdraw.

  The agent PROPOSED the write; nothing has happened yet. The human edits the
  fields and, on Confirm, this card calls the request's own route under the
  human's session (`apiClient.projectRequests.*`, the same calls the review page
  makes), with `X-Agent-Proposal-Id`. Every guard of the route applies unchanged
  — the conveyor gate, the repo-access gate, requester-only withdraw. A refusal
  renders verbatim (SPEC §5.6).

  After an approve, the card offers "Open project", which goes INTO the new
  project's shell; every other write offers the request's review page.
-->
<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import type { AgentProposal } from '$lib/agui/types';
	import type { ProjectCreate } from '$lib/types/api';
	import {
		PROJECT_REQUEST_CONFIRM_LABEL,
		PROJECT_REQUEST_FIELDS,
		PROJECT_REQUEST_REQUIRED,
		isProjectRequestAction,
		requestCardBody,
		requestCardCanConfirm,
		requestCardInitialValues,
		requestCardResultLink,
		verbatimErrorText,
		type ProjectRequestAction
	} from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const action = $derived(isProjectRequestAction(proposal.action) ? (proposal.action as ProjectRequestAction) : null);
	const requestId = $derived(typeof proposal.input.id === 'string' ? proposal.input.id : null);

	let values = $state<Record<string, string>>({});
	let initialised = false;
	$effect(() => {
		if (initialised || !action) return;
		values = requestCardInitialValues(action, proposal.input);
		initialised = true;
	});

	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let done = $state<{ href: string; label: string; testid: string } | null | undefined>(undefined);

	const LABELS: Record<string, string> = {
		name: 'Name',
		text: 'What should the project do?',
		description: 'Description',
		project_type: 'Project type',
		problem_statement: 'Problem statement',
		desired_outcome: 'Desired outcome',
		business_case: 'Business case',
		repository_url: 'Repository URL',
		reason: 'Reason'
	};
	const MULTILINE = new Set(['text', 'description', 'problem_statement', 'desired_outcome', 'business_case', 'reason']);

	const canConfirm = $derived(
		!!action && !submitting && (action === 'project_requests.draft_from_text' || !!requestId) && requestCardCanConfirm(action, values)
	);

	async function confirm(): Promise<void> {
		if (!action || !canConfirm) return;
		submitting = true;
		submitError = null;
		const opts = { proposalId: proposal.proposalId };
		const body = requestCardBody(action, values);
		const id = requestId ?? '';
		try {
			let result: unknown;
			switch (action) {
				case 'project_requests.draft_from_text':
					result = await apiClient.projectRequests.draftFromText(
						{ text: body.text ?? '', ...(body.name ? { name: body.name } : {}) },
						opts
					);
					break;
				case 'project_requests.patch':
					result = await apiClient.projectRequests.patch(id, body as Partial<ProjectCreate>, opts);
					break;
				case 'project_requests.submit':
					result = await apiClient.projectRequests.submit(id, opts);
					break;
				case 'project_requests.approve':
					// `{}` approves the request's stored payload as it is (the route's own rule).
					result = await apiClient.projectRequests.approve(id, {}, opts);
					break;
				case 'project_requests.reject':
					result = await apiClient.projectRequests.reject(id, body.reason ?? '', opts);
					break;
				case 'project_requests.withdraw':
					result = await apiClient.projectRequests.withdraw(id, opts);
					break;
			}
			done = requestCardResultLink(action, requestId, result);
		} catch (err) {
			submitError = verbatimErrorText(err);
		} finally {
			submitting = false;
		}
	}
</script>

<div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid="project-request-card">
	{#if !action}
		<p class="text-[var(--color-danger)]">This proposal ({proposal.action}) has no confirm card.</p>
	{:else if done !== undefined}
		<div data-testid="project-request-card-done" class="space-y-2">
			<p class="text-[var(--color-text)]">Done.</p>
			{#if done}
				<a
					href={done.href}
					data-testid={done.testid}
					class="inline-block rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)]"
				>
					{done.label}
				</a>
			{/if}
		</div>
	{:else}
		<p class="mb-2 text-xs text-[var(--color-text-muted)]">
			The agent prepared this. Review it — nothing happens until you confirm.
		</p>
		{#if requestId}
			<p class="mb-2 text-xs text-[var(--color-text-muted)]">
				Request <a href={`/projects/requests/${requestId}`} class="underline">{requestId.slice(0, 8)}</a>
			</p>
		{/if}
		{#each PROJECT_REQUEST_FIELDS[action] as field (field)}
			{@const fid = `${proposal.proposalId}-${field}`}
			<label class="mt-2 block text-xs text-[var(--color-text-muted)]" for={fid}>
				{LABELS[field] ?? field}{(PROJECT_REQUEST_REQUIRED[action] ?? []).includes(field) ? ' (required)' : ''}
			</label>
			{#if MULTILINE.has(field)}
				<textarea
					id={fid}
					data-testid={`project-request-card-field-${field}`}
					bind:value={values[field]}
					rows="3"
					class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs"
				></textarea>
			{:else}
				<input
					id={fid}
					data-testid={`project-request-card-field-${field}`}
					bind:value={values[field]}
					class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs"
				/>
			{/if}
		{/each}
		{#if submitError}
			<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="project-request-card-error">{submitError}</p>
		{/if}
		<button
			type="button"
			data-testid="project-request-card-confirm"
			disabled={!canConfirm}
			onclick={confirm}
			class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-50"
		>
			{submitting ? 'Working…' : PROJECT_REQUEST_CONFIRM_LABEL[action]}
		</button>
	{/if}
</div>
