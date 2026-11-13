<!--
  ModelReviewCard — the confirm card of `architecture.review_model_revision`.

  The agent put a saved version of an architecture model in front of the user; it
  did NOT and cannot decide (fr is a facilitator, never a judge): `decision` and
  `reason` are human-only fields the server strips from any proposal. The HUMAN
  chooses approve or reject here (nothing is pre-selected) and writes the reason
  (required to reject); Confirm sends exactly that, under the human's session, to
  `POST /api/capabilities/architecture.review_model_revision/invoke`, which runs
  the version page's own review route as them. A refusal (e.g. "please say why you are
  rejecting this version") renders verbatim.
-->
<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import { getModel, getRevision } from '$lib/api/modeling';
	import type { AgentProposal } from '$lib/agui/types';
	import { raiseInvalidate } from '$lib/agent/invalidation';
	import { versionName } from '$lib/modeling/explain';
	import ApprovalCard from './ApprovalCard.svelte';
	import { MODEL_REVIEW_DECISIONS, invokeOutcome, invokesOwnRoute, modelReviewBody, verbatimErrorText, type ModelReviewDecision } from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const invokable = $derived(proposal.card === 'model-review' && invokesOwnRoute(proposal));
	const modelId = $derived(typeof proposal.input.model_id === 'string' ? proposal.input.model_id : '');
	const revisionId = $derived(typeof proposal.input.revision_id === 'string' ? proposal.input.revision_id : '');

	let label = $state<string | null>(null);
	let requested = false;
	$effect(() => {
		if (requested || !modelId || !revisionId) return;
		requested = true;
		Promise.all([getModel(modelId), getRevision(modelId, revisionId)])
			.then(([m, r]) => (label = `${m.title}, ${versionName(r)}`))
			.catch((err) => console.warn('[ModelReviewCard] the version could not be named', err));
	});

	let decision = $state<ModelReviewDecision | null>(null);
	let reason = $state('');
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let recorded = $state<ModelReviewDecision | null>(null);
	let parked = $state<string | null>(null);
	const ready = $derived(modelReviewBody(proposal.input, decision, reason, proposal.proposalId) !== null);

	async function confirm(): Promise<void> {
		if (!invokable || submitting || recorded || parked) return;
		const body = modelReviewBody(proposal.input, decision, reason, proposal.proposalId);
		if (!body) return;
		submitError = null;
		submitting = true;
		try {
			const res = await apiClient.capabilities.invoke(proposal.action, body, { proposalId: proposal.proposalId });
			const out = invokeOutcome(res?.data);
			if (out.kind === 'parked') parked = out.approvalId;
			else recorded = decision;
			raiseInvalidate(res?.invalidate);
		} catch (err) {
			submitError = verbatimErrorText(err);
		} finally {
			submitting = false;
		}
	}
</script>

<div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm" data-testid="model-review-card" data-agent-surface="card">
	<p class="font-semibold text-[var(--color-text)]">Review a model version</p>
	<p class="mt-0.5 text-xs text-[var(--color-text-muted)]" data-testid="model-review-card-version">
		{label ?? 'A saved version of an architecture model'}
		{#if modelId && revisionId}
			· <a class="text-[var(--color-link)] underline" href={`/library/architecture/models/${encodeURIComponent(modelId)}/versions/${encodeURIComponent(revisionId)}`}>Open it</a>
		{/if}
	</p>
	{#if !invokable}
		<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="model-review-card-refused">
			This proposal does not name its own confirm route, so it cannot be confirmed here.
		</p>
	{:else if parked}
		<p class="mt-2 text-xs text-[var(--color-text-muted)]">Sent for approval — the review is recorded once it is signed off.</p>
		<div class="mt-2"><ApprovalCard approvalId={parked} /></div>
	{:else if recorded}
		<p class="mt-2 text-[var(--color-text)]" data-testid="model-review-card-done">Your review is recorded: {recorded === 'approve' ? 'approved' : 'rejected'}.</p>
	{:else}
		<p class="mt-1 text-xs text-[var(--color-text-muted)]">Your decision. The assistant does not choose for you.</p>
		<div class="mt-2 flex gap-3" role="radiogroup" aria-label="Your decision">
			{#each MODEL_REVIEW_DECISIONS as d (d)}
				<label class="flex items-center gap-1 text-xs text-[var(--color-text)]">
					<input type="radio" name={`model-review-${proposal.proposalId}`} value={d} bind:group={decision} data-testid={`model-review-card-${d}`} />
					{d === 'approve' ? 'Approve' : 'Reject'}
				</label>
			{/each}
		</div>
		<label class="mt-2 block text-xs text-[var(--color-text-muted)]" for={`model-review-reason-${proposal.proposalId}`}>
			Comment {decision === 'reject' ? '(required to reject)' : '(optional)'}
		</label>
		<textarea
			id={`model-review-reason-${proposal.proposalId}`}
			rows="2"
			bind:value={reason}
			data-testid="model-review-card-reason"
			class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs"
		></textarea>
		{#if submitError}<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="model-review-card-error">{submitError}</p>{/if}
		<button
			type="button"
			data-testid="model-review-card-confirm"
			disabled={submitting || !ready}
			onclick={confirm}
			class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-50"
		>
			{submitting ? 'Recording…' : 'Record my review'}
		</button>
	{/if}
</div>
