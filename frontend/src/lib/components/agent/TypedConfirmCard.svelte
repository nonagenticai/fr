<!--
  TypedConfirmCard — the confirm card of a DESTRUCTIVE project write (fr-agui P2-c2;
  SPEC §5.2 "destructive with typed confirmation"). Today: `projects.archive` (the
  project's name), `architecture.delete_model` (the model's title), the UML deletes
  and the ArchiMate element / relationship / view deletes (its name; a relationship: its type).

  Nothing has run. The human types the exact name (the agent never fills it:
  `confirm_name` / `confirm_title` is a human-only field the server strips from any
  proposal and re-checks against the stored name before anything is removed). Confirm calls
  `POST /api/capabilities/<action>/invoke` under the human's session, which runs the
  Settings page's own route as them. A refusal renders verbatim (SPEC §5.6).
-->
<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import { getArchimate, getModel, getUml } from '$lib/api/modeling';
	import type { AgentProposal } from '$lib/agui/types';
	import { activeProject } from '$lib/stores/activeProject.svelte';
	import { raiseInvalidate } from '$lib/agent/invalidation';
	import ApprovalCard from './ApprovalCard.svelte';
	import { ARCHIMATE_DELETE_TARGET, TYPED_CONFIRM_COPY, UML_DELETE_TARGET, archimateConfirmName, invokeOutcome, invokesOwnRoute, typedConfirmBodyFor, typedConfirmMatches, umlConfirmName, verbatimErrorText } from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const invokable = $derived(proposal.card === 'typed-confirm' && invokesOwnRoute(proposal) && proposal.action in TYPED_CONFIRM_COPY);
	const copy = $derived(TYPED_CONFIRM_COPY[proposal.action]);
	const projectId = $derived(typeof proposal.input.project_id === 'string' ? proposal.input.project_id : null);
	const modelId = $derived(typeof proposal.input.model_id === 'string' ? proposal.input.model_id : null);
	const isModel = $derived(copy?.subject === 'model' || copy?.subject === 'uml' || copy?.subject === 'archimate');
	const archimateTarget = $derived(ARCHIMATE_DELETE_TARGET[proposal.action]);
	const umlTarget = $derived(UML_DELETE_TARGET[proposal.action]);

	let fetchedName = $state<string | null>(null);
	let nameUnknown = $state(false);
	const storeName = $derived(
		!isModel && projectId
			? (activeProject.projects.find((p) => p.id === projectId)?.name ??
					(activeProject.active?.id === projectId ? activeProject.active?.name : null) ??
					null)
			: null
	);
	const projectName = $derived(storeName ?? fetchedName);

	let requested = false;
	$effect(() => {
		if (requested || storeName) return;
		if (archimateTarget) {
			const rowId = proposal.input[archimateTarget.field];
			if (typeof rowId !== 'string' || !rowId) return;
			requested = true;
			getArchimate<{ title?: unknown; relationship_type?: unknown }>(archimateTarget.resource, rowId)
				.then((row) => (fetchedName = archimateConfirmName(row)))
				.catch((err) => {
					console.warn('[TypedConfirmCard] the item name could not be read', err);
					nameUnknown = true;
				});
			return;
		}
		if (umlTarget) {
			const rowId = proposal.input[umlTarget.field];
			if (typeof rowId !== 'string' || !rowId) return;
			requested = true;
			getUml<{ name?: unknown; kind?: unknown }>(umlTarget.resource, rowId)
				.then((row) => (fetchedName = umlConfirmName(row)))
				.catch((err) => {
					console.warn('[TypedConfirmCard] the item name could not be read', err);
					nameUnknown = true;
				});
			return;
		}
		if (isModel) {
			if (!modelId) return;
			requested = true;
			getModel(modelId)
				.then((m) => (fetchedName = typeof m?.title === 'string' ? m.title : null))
				.catch((err) => {
					console.warn('[TypedConfirmCard] the model title could not be read', err);
					nameUnknown = true;
				});
			return;
		}
		if (!projectId) return;
		requested = true;
		apiClient.projects
			.get(projectId)
			.then((p) => (fetchedName = typeof p?.name === 'string' ? p.name : null))
			.catch((err) => {
				console.warn('[TypedConfirmCard] the project name could not be read', err);
				nameUnknown = true;
			});
	});

	let typed = $state('');
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let done = $state(false);
	// A parked answer (HTTP 202 PendingAction) has NOT archived anything: show the approval inline.
	let parked = $state<string | null>(null);
	const matches = $derived(typedConfirmMatches(typed, projectName));

	async function confirm(): Promise<void> {
		if (!invokable || submitting || done || parked || !matches) return;
		submitError = null;
		submitting = true;
		try {
			const res = await apiClient.capabilities.invoke(proposal.action, typedConfirmBodyFor(proposal.action, proposal.input, typed, proposal.proposalId), {
				proposalId: proposal.proposalId
			});
			const out = invokeOutcome(res?.data);
			if (out.kind === 'parked') parked = out.approvalId;
			else done = true;
			raiseInvalidate(res?.invalidate);
		} catch (err) {
			submitError = verbatimErrorText(err);
		} finally {
			submitting = false;
		}
	}
</script>

<div
	class="rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-surface)] p-3 text-sm"
	data-testid="typed-confirm-card"
	data-agent-surface="card"
>
	<p class="font-semibold text-[var(--color-text)]">{copy?.title ?? proposal.action}</p>
	{#if !invokable}
		<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="typed-confirm-card-refused">
			This proposal does not name its own confirm route, so it cannot be confirmed here.
		</p>
	{:else if parked}
		<p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="typed-confirm-card-parked">
			Sent for approval — nothing changes until it is signed off.
		</p>
		<div class="mt-2"><ApprovalCard approvalId={parked} /></div>
	{:else if done}
		<p class="mt-2 text-[var(--color-text)]" data-testid="typed-confirm-card-done">Done: {projectName} {copy?.done ?? 'is done'}.</p>
	{:else}
		<p class="mt-1 text-xs text-[var(--color-text-muted)]">{copy.effect}</p>
		{#if projectName}
			<label class="mt-2 block text-xs text-[var(--color-text-muted)]" for={`typed-${proposal.proposalId}`}>
				Type <span class="font-semibold text-[var(--color-text)]" data-testid="typed-confirm-card-name">{projectName}</span> to confirm
			</label>
			<input
				id={`typed-${proposal.proposalId}`}
				type="text"
				autocomplete="off"
				data-testid="typed-confirm-card-input"
				bind:value={typed}
				class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs"
			/>
		{:else if nameUnknown}
			<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="typed-confirm-card-name-unknown">
				{isModel
					? "The name could not be read, so this cannot be confirmed here. Delete it from its own page instead."
					: "The project's name could not be read, so this cannot be confirmed here. Use the project's Settings page."}
			</p>
		{:else}
			<p class="mt-2 text-xs text-[var(--color-text-muted)]">{isModel ? 'Loading…' : 'Loading the project…'}</p>
		{/if}
		{#if submitError}
			<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="typed-confirm-card-error">{submitError}</p>
		{/if}
		<button
			type="button"
			data-testid="typed-confirm-card-confirm"
			disabled={submitting || !matches}
			onclick={confirm}
			class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] px-3 py-1.5 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-bg)] disabled:opacity-50"
		>
			{submitting ? 'Confirming…' : copy.confirm}
		</button>
	{/if}
</div>
