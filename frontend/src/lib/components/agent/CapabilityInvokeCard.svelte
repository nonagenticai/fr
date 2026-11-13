<!--
  CapabilityInvokeCard — the confirm card for an AGENT-NATIVE write (fr-agui SPEC
  §5.2 W, §13 P1c-b): a write with no UI route of its own, today the project
  TOC builds (`toc.build_io_map`, `toc.evaporate_conflict`, `toc.evaluate_lenses`).

  The agent PROPOSED it; nothing has run. The human reviews (and may edit) the
  input and, on Confirm, this card calls `POST /api/capabilities/<id>/invoke`
  under the HUMAN's session, with `X-Agent-Proposal-Id` (read by the route for
  AUDIT only — it binds nothing). A double confirm runs once: `submitting`
  dedupes a double click, and the body always carries the proposal's stable
  `idempotency_key` (`invokeIdempotencyKey`), on which the registry's per-user
  `runIdempotent` (24h) dedupes a second confirm, e.g. after a re-render. The
  toc confirm spec has no `idempotent` flag, so no `Idempotency-Key` header is
  sent. The route resolves the principal, re-checks project read
  access, runs the action's own RBAC and keeps its approval policy — so a
  project-owner policy still PARKS, and the card then shows that approval inline
  (the full ApprovalCard) instead of a dead end. A refusal renders verbatim
  (SPEC §5.6). The route's `invalidate` list is raised so the views re-fetch.

  The binding is not editable: the card shows the project, and `project_id`
  goes back exactly as the server bound it. Every value shown is redacted for
  display (lib/api/agent-redact.ts); a declared secret field is never pre-filled.
-->
<script lang="ts">
	import { apiClient } from '$lib/api/unified-client';
	import type { AgentProposal } from '$lib/agui/types';
	import { activeProject } from '$lib/stores/activeProject.svelte';
	import { raiseInvalidate } from '$lib/agent/invalidation';
	import { redactForDisplay } from '$lib/api/agent-redact';
	import ApprovalCard from './ApprovalCard.svelte';
	import {
		actionTitle,
		invokeCardBody,
		invokeCardFields,
		invokeOutcome,
		isInvokeProposal,
		verbatimErrorText,
		type InvokeField
	} from './proposal-cards';

	let { proposal }: { proposal: AgentProposal } = $props();

	const invokable = $derived(isInvokeProposal(proposal));
	const projectId = $derived(typeof proposal.input.project_id === 'string' ? proposal.input.project_id : null);
	const projectName = $derived(
		projectId ? (activeProject.projects.find((p) => p.id === projectId)?.name ?? (activeProject.active?.id === projectId ? activeProject.active?.name : null)) : null
	);

	let fields = $state<InvokeField[]>([]);
	let initialised = false;
	$effect(() => {
		if (initialised) return;
		const shown = redactForDisplay(proposal.input, proposal.secretFields);
		fields = invokeCardFields(shown, proposal.secretFields, proposal.action);
		initialised = true;
	});

	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let outcome = $state<{ kind: 'parked'; approvalId: string } | { kind: 'done' } | null>(null);

	async function confirm(): Promise<void> {
		if (!invokable || submitting || outcome) return;
		submitError = null;
		let body: Record<string, unknown>;
		try {
			// The proposal's own input (unredacted, as the server bound it) with the
			// human's edits applied; the binding is kept and the idempotency key is
			// the proposal's own (or derived from its id) — stable per proposal.
			body = invokeCardBody(proposal.input, fields, proposal.proposalId);
		} catch (err) {
			submitError = err instanceof Error ? err.message : String(err);
			return;
		}
		submitting = true;
		try {
			const res = await apiClient.capabilities.invoke(proposal.action, body, { proposalId: proposal.proposalId });
			outcome = invokeOutcome(res?.data);
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
	data-testid="capability-invoke-card"
	data-agent-surface="card"
>
	<p class="font-semibold text-[var(--color-text)]">{actionTitle(proposal.action)}</p>
	{#if projectId}
		<p class="mt-0.5 text-xs text-[var(--color-text-muted)]" data-testid="capability-invoke-card-project">
			Project: {projectName ?? projectId}
		</p>
	{/if}
	{#if !invokable}
		<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="capability-invoke-card-refused">
			This proposal does not name its own confirm route, so it cannot be confirmed here.
		</p>
	{:else if outcome?.kind === 'done'}
		<p class="mt-2 text-[var(--color-text)]" data-testid="capability-invoke-card-done">Done.</p>
	{:else if outcome?.kind === 'parked'}
		<p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="capability-invoke-card-parked">
			Sent for approval — this action needs a sign-off before it runs.
		</p>
		<div class="mt-2"><ApprovalCard approvalId={outcome.approvalId} /></div>
	{:else}
		<p class="mt-1 text-xs text-[var(--color-text-muted)]">
			The agent proposed this. Nothing runs until you confirm.
		</p>
		{#each fields as f, i (f.key)}
			<label class="mt-2 block text-xs text-[var(--color-text-muted)]" for={`invoke-${proposal.proposalId}-${f.key}`}>{f.key}</label>
			{#if f.kind === 'boolean'}
				<input
					id={`invoke-${proposal.proposalId}-${f.key}`}
					type="checkbox"
					data-testid={`capability-invoke-card-field-${f.key}`}
					checked={f.value === 'true'}
					onchange={(e) => (fields[i] = { ...f, value: String((e.currentTarget as HTMLInputElement).checked) })}
				/>
			{:else if f.kind === 'text' || f.kind === 'number'}
				<input
					id={`invoke-${proposal.proposalId}-${f.key}`}
					type={f.kind === 'number' ? 'number' : 'text'}
					data-testid={`capability-invoke-card-field-${f.key}`}
					bind:value={fields[i]!.value}
					class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs"
				/>
			{:else}
				<textarea
					id={`invoke-${proposal.proposalId}-${f.key}`}
					data-testid={`capability-invoke-card-field-${f.key}`}
					bind:value={fields[i]!.value}
					rows={f.kind === 'json' ? 4 : 3}
					class="w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
				></textarea>
			{/if}
		{/each}
		{#if submitError}
			<p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="capability-invoke-card-error">{submitError}</p>
		{/if}
		<button
			type="button"
			data-testid="capability-invoke-card-confirm"
			disabled={submitting}
			onclick={confirm}
			class="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:opacity-50"
		>
			{submitting ? 'Confirming…' : 'Confirm'}
		</button>
	{/if}
</div>
