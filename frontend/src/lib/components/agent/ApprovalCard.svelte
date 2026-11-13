<!--
  ApprovalCard — the FULL decision card in the chat (fr-agui SPEC §5.2, §5.3,
  §13 P1c-b): the project agent's `approvals.decide` proposal (W), a parked
  write's inline Review, and a confirm card whose route parked.

  ⛔ ONE DECISION SURFACE. It mounts the same `ApprovalDecisionSurface` the
  approval pages mount (`/approvals/[id]`, `/projects/[id]/approve/[approvalId]`)
  and decides through the same `recordDecision` helper — so every control the
  page renders conditionally (the question and its answer demand, RECLASSIFY with
  `new_card_type`, the COVERAGE criteria checklist → `rejected_criterion_ids`,
  the broken-gate override reason, reject with a reason) renders here exactly as
  there, from the row's own metadata. A DROP row is decided like the page decides
  it: the stored `deblock_action` drives it; the page offers no decider-chosen
  DROP override, so neither does this card (recorded in the P1c-b SPEC status).

  It shows the minted artifact (`artifactRefLink`); a sign-off answers it and
  never attaches one. The agent may SUGGEST a decision and comment (shown, never
  pre-recorded); only the human's click, under the human's own session
  (`PUT /api/approvals/:id`), records it — `decision-guards` apply unchanged.
  After a decision the approvals / board / project views are invalidated.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { apiClient } from '$lib/api/unified-client';
	import { auth } from '$lib/stores/auth.svelte';
	import { raiseInvalidate } from '$lib/agent/invalidation';
	import { redactForDisplay, scrubString } from '$lib/api/agent-redact';
	import ApprovalDecisionSurface from '$lib/components/approval/ApprovalDecisionSurface.svelte';
	import { answerRequired } from '$lib/approvals/question';
	import type { Approval } from '$lib/types/api';
	import {
		artifactRefLink,
		recordDecision,
		type Decision
	} from '../../../routes/approvals/[id]/page-helpers';
	import { isFullApprovalId, verbatimErrorText, type DecideInput } from './proposal-cards';

	let {
		approvalId,
		prefill = {}
	}: { approvalId: string; prefill?: Partial<Omit<DecideInput, 'approvalId'>> } = $props();

	let approval = $state<Approval | null>(null);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	let submitError = $state<string | null>(null);
	let decided = $state<{ kind: Decision; message: string } | null>(null);

	onMount(() => {
		if (!isFullApprovalId(approvalId)) {
			loadError = 'This approval id is incomplete — open the approvals inbox to decide it.';
			return;
		}
		apiClient.approvals
			.get(approvalId)
			.then((a) => {
				approval = a;
				if (a.status === 'approved') decided = { kind: 'approve', message: 'Approved.' };
				else if (a.status === 'rejected') decided = { kind: 'reject', message: 'Rejected.' };
			})
			.catch((err: unknown) => (loadError = verbatimErrorText(err)));
	});

	// ⛔ fr-agui SPEC §10.1: everything this card PAINTS goes through agent-redact —
	// including the shared ApprovalDecisionSurface, which here renders inside the
	// agent. It gets the REDACTED row (ids, roles, status and metadata structure are
	// unchanged by redaction, so the roster / question / RECLASSIFY / COVERAGE logic
	// reads the same); the decision itself is recorded against the raw row's id. The
	// standalone approval pages mount the surface with the raw row, unchanged.
	const shown = $derived(approval ? redactForDisplay(approval) : null);
	const artifact = $derived(shown ? artifactRefLink(shown) : null);
	const suggestion = $derived(
		prefill.decision || prefill.comment || prefill.reason
			? [
					prefill.decision ? (prefill.decision === 'reject' ? 'reject' : 'approve') : null,
					prefill.comment ? `“${scrubString(prefill.comment)}”` : null,
					prefill.reason ? `reason: “${scrubString(prefill.reason)}”` : null
				]
					.filter(Boolean)
					.join(' — ')
			: null
	);

	async function decide(
		kind: Decision,
		comment: string,
		overrideReason?: string,
		reclassify?: { newCardType: string },
		coverage?: { rejectedCriterionIds: string[] }
	): Promise<void> {
		if (!approval || busy) return;
		busy = true;
		submitError = null;
		try {
			decided = await recordDecision(
				approval.id,
				kind,
				comment,
				{
					isQuestion: answerRequired(approval, 'approved'),
					answerRequiredOnReclassify: answerRequired(approval, 'approved', 'RECLASSIFY')
				},
				overrideReason,
				reclassify,
				coverage
			);
			const p = approval.project_id;
			raiseInvalidate(['approvals:me', ...(p ? [`approvals:${p}`, `board:${p}`, `project:${p}`] : [])]);
		} catch (err) {
			submitError = verbatimErrorText(err);
		} finally {
			busy = false;
		}
	}
</script>

<div
	class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
	data-testid="approval-card"
	data-agent-surface="card"
>
	{#if loadError}
		<p class="text-[var(--color-danger)]" data-testid="approval-card-error">{loadError}</p>
		<a href="/approvals" class="text-xs underline">Open approvals</a>
	{:else if !approval}
		<p class="text-[var(--color-text-muted)]">Loading approval…</p>
	{:else}
		<p class="text-[var(--color-text)]" data-testid="approval-card-description">{shown?.description ?? ''}</p>
		{#if artifact}
			<p class="mt-1 text-xs">
				Artifact:
				<a href={artifact.href} class="underline" data-testid="approval-card-artifact">{artifact.label}</a>
			</p>
		{/if}
		{#if suggestion && !decided}
			<p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="approval-card-suggestion">
				The agent suggests: {suggestion}. Nothing is recorded until you decide below.
			</p>
		{/if}
		<div class="mt-2">
			<ApprovalDecisionSurface
				approval={shown ?? approval}
				user={auth.user}
				canOverrideBrokenGate={auth.isSuperAdmin}
				{decided}
				{busy}
				onDecide={decide}
			/>
		</div>
		{#if submitError}
			<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="approval-card-submit-error">{submitError}</p>
		{/if}
		{#if approval.project_id}
			<a
				href={`/projects/${approval.project_id}/approve/${approval.id}`}
				class="mt-2 inline-block text-xs underline"
				data-testid="approval-card-open">Open the full review →</a
			>
		{/if}
	{/if}
</div>
