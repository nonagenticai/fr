<!--
  ArtifactReviewCard — the confirm card of `artifacts.review` (fr-agui P2-c2).

  The agent put one of the project's artifacts in front of the user; it did NOT and
  cannot decide (fr is a facilitator, never a judge): the proposal carries only the
  project and the artifact — the server strips any decision or comment the model
  sent. The HUMAN chooses approve / reject / revise here (nothing is pre-selected)
  and may write a comment; Confirm sends exactly that, under the human's session,
  to `POST /api/capabilities/artifacts.review/invoke`, which runs the Artifacts
  page's own review route as them. A refusal renders verbatim (SPEC §5.6).
-->
<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import type { AgentProposal } from '$lib/agui/types';
	import { raiseInvalidate } from '$lib/agent/invalidation';
	import ApprovalCard from './ApprovalCard.svelte';
	import { REVIEW_DECISIONS, invokeOutcome, invokesOwnRoute, reviewCardBody, verbatimErrorText, type ReviewDecision } from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const invokable = $derived(proposal.card === 'artifact-review' && invokesOwnRoute(proposal));
	const artifactId = $derived(typeof proposal.input.artifact_id === 'string' ? proposal.input.artifact_id : '');

	let decision = $state<ReviewDecision | null>(null);
	let comment = $state('');
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let recorded = $state<ReviewDecision | null>(null);
	// A parked answer (HTTP 202 PendingAction) is NOT a recorded decision: show the approval inline.
	let parked = $state<string | null>(null);

	async function confirm(): Promise<void> {
		if (!invokable || submitting || recorded || parked) return;
		const body = reviewCardBody(proposal.input, decision, comment, proposal.proposalId);
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

<div
	class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
	data-testid="artifact-review-card"
	data-agent-surface="card"
>
	<p class="font-semibold text-[var(--color-text)]">Review an artifact</p>
	<p class="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]" data-testid="artifact-review-card-artifact">{artifactId}</p>
	{#if !invokable}
		<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="artifact-review-card-refused">
			This proposal does not name its own confirm route, so it cannot be confirmed here.
		</p>
	{:else if parked}
		<p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="artifact-review-card-parked">
			Sent for approval — your decision is recorded once it is signed off.
		</p>
		<div class="mt-2"><ApprovalCard approvalId={parked} /></div>
	{:else if recorded}
		<p class="mt-2 text-[var(--color-text)]" data-testid="artifact-review-card-done">
			Recorded: {REVIEW_DECISIONS.find((d) => d.value === recorded)?.label}.
		</p>
	{:else}
		<p class="mt-1 text-xs text-[var(--color-text-muted)]">The decision is yours. Nothing is recorded until you confirm.</p>
		<fieldset class="mt-2 space-y-1">
			<legend class="sr-only">Your decision</legend>
			{#each REVIEW_DECISIONS as d (d.value)}
				<label class="flex items-center gap-2 text-xs text-[var(--color-text)]">
					<input
						type="radio"
						name={`review-${proposal.proposalId}`}
						value={d.value}
						data-testid={`artifact-review-card-${d.value}`}
						checked={decision === d.value}
						onchange={() => (decision = d.value)}
					/>
					{d.label}
				</label>
			{/each}
		</fieldset>
		<label class="mt-2 block text-xs text-[var(--color-text-muted)]" for={`review-comment-${proposal.proposalId}`}>Comment (optional)</label>
		<textarea
			id={`review-comment-${proposal.proposalId}`}
			data-testid="artifact-review-card-comment"
			bind:value={comment}
			rows="3"
			maxlength="4000"
			class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs"
		></textarea>
		{#if submitError}
			<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="artifact-review-card-error">{submitError}</p>
		{/if}
		<button
			type="button"
			data-testid="artifact-review-card-confirm"
			disabled={submitting || decision === null}
			onclick={confirm}
			class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-50"
		>
			{submitting ? 'Recording…' : 'Confirm my decision'}
		</button>
	{/if}
</div>
