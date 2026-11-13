<script lang="ts">
	// Renders the versioned outlines of a project request (stage B of the
	// two-stage lifecycle). The DECISION is not made here: an outline is decided
	// through the ordinary approvals queue (kind `project_outline.approval`), so
	// this panel only links to that approval.
	//
	// ⚠️ cost_estimate is an agent's PROPOSED figure. Billing carries no
	// per-project cost data, so it must never read as money spent.
	import type { Outline, OutlineDeliverable } from './types';
	import ProjectPlanView from '$lib/components/plan/ProjectPlanView.svelte';

	let { outlines }: { outlines: Outline[] } = $props();

	// Newest version first, regardless of what order we were handed.
	const sorted = $derived([...outlines].sort((a, b) => b.version - a.version));
	// The outline awaiting a decision; otherwise the newest one of any status.
	const current = $derived(sorted.find((o) => o.status === 'proposed') ?? sorted[0] ?? null);
	const older = $derived(sorted.filter((o) => o !== current));

	// UI review 2026-10-08: an outline can stay `proposed` while its approval was
	// withdrawn (voided), rejected or lapsed. Linking "Decide this outline" to that
	// row sends the reviewer to something nobody can decide, so say what happened.
	const CLOSED_APPROVAL_NOTE: Record<string, string> = {
		voided: 'Outline approval was withdrawn — resubmit to decide',
		withdrawn: 'Outline approval was withdrawn — resubmit to decide',
		rejected: 'Outline approval was rejected — resubmit to decide',
		expired: 'Outline approval expired unanswered — resubmit to decide'
	};
	const closedApprovalNote = $derived(
		current?.approval_id && current.approval_status
			? (CLOSED_APPROVAL_NOTE[current.approval_status] ?? null)
			: null
	);

	function fmtDate(v: string | null | undefined): string {
		if (!v) return '';
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString();
	}

	function fmtMoney(amount: number, currency: string): string {
		try {
			return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
		} catch {
			return `${amount} ${currency}`;
		}
	}

	const statusClass: Record<Outline['status'], string> = {
		proposed: 'bg-[var(--color-info-bg)] text-[var(--color-info-text)]',
		superseded: 'bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]',
		approved: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
		rejected: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
	};
</script>

{#snippet deliverableList(items: OutlineDeliverable[], testid: string)}
	<ul class="list-disc pl-5 space-y-1 text-sm text-[var(--color-text)]" data-testid={testid}>
		{#each items as d, i (i)}
			<li>
				<span class="font-medium">{d.title}</span>
				<span class="text-xs text-[var(--color-text-muted)]"> [{d.kind}]</span>
				{#if d.description}<span class="text-[var(--color-text-muted)]"> — {d.description}</span>{/if}
				{#if d.acceptance_criteria?.length}
					<ul class="list-[circle] pl-5 text-xs text-[var(--color-text-muted)]" data-testid="deliverable-acceptance">
						{#each d.acceptance_criteria as c, j (j)}<li>{c}</li>{/each}
					</ul>
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet outlineBody(o: Outline)}
	<div class="space-y-4">
		{#if o.summary}
			<p class="text-sm text-[var(--color-text)]" data-testid="outline-summary">{o.summary}</p>
		{/if}

		<!-- fr#1484: the exact plan the one requester approval agrees to (server-built). -->
		{#if o.plan_view}
			<div data-testid="outline-plan">
				<h4 class="text-sm font-semibold text-[var(--color-text)] mb-1">Proposed plan</h4>
				<ProjectPlanView mode="proposed" proposed={o.plan_view} />
			</div>
		{:else if o.plan_view_error}
			<p class="text-sm text-[var(--color-danger-text)]" role="alert" data-testid="outline-plan-error">
				The proposed plan cannot be shown: {o.plan_view_error}
			</p>
		{/if}

		<div>
			<h4 class="text-sm font-semibold text-[var(--color-text)] mb-1">Deliverables</h4>
			{#if o.deliverables.length}
				{@render deliverableList(o.deliverables, 'outline-deliverables')}
			{:else}
				<p class="text-sm text-[var(--color-text-muted)]">None listed.</p>
			{/if}
		</div>

		{#if o.intermediate_deliverables.length}
			<div>
				<h4 class="text-sm font-semibold text-[var(--color-text)] mb-1">Intermediate deliverables</h4>
				{@render deliverableList(o.intermediate_deliverables, 'outline-intermediate')}
			</div>
		{/if}

		{#if o.milestones.length}
			<div>
				<h4 class="text-sm font-semibold text-[var(--color-text)] mb-1">Milestones</h4>
				<ul class="space-y-1 text-sm text-[var(--color-text)]" data-testid="outline-milestones">
					{#each o.milestones as m, i (i)}
						<li class="flex justify-between gap-4">
							<span>{m.name}</span>
							<span class="text-[var(--color-text-muted)]">{m.target_date ? fmtDate(m.target_date) : 'no target date'}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if o.effort_estimate || o.cost_estimate}
			<dl class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
				{#if o.effort_estimate}
					<div data-testid="outline-effort">
						<dt class="text-[var(--color-text-muted)]">Effort estimate</dt>
						<dd class="text-[var(--color-text)]">
							{o.effort_estimate.value} {o.effort_estimate.unit}
							{#if o.effort_estimate.note}<span class="text-[var(--color-text-muted)]"> — {o.effort_estimate.note}</span>{/if}
						</dd>
					</div>
				{/if}
				{#if o.cost_estimate}
					<div data-testid="outline-cost">
						<dt class="text-[var(--color-text-muted)]">Cost <span class="ml-1 px-1.5 py-0.5 rounded text-xs bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]" data-testid="cost-estimate-label">Estimate — not tracked spend</span></dt>
						<dd class="text-[var(--color-text)]">
							{fmtMoney(o.cost_estimate.amount, o.cost_estimate.currency)}
							{#if o.cost_estimate.basis}<span class="text-[var(--color-text-muted)]"> — {o.cost_estimate.basis}</span>{/if}
						</dd>
					</div>
				{/if}
			</dl>
		{/if}

		{#if o.decision_note}
			<p class="text-sm text-[var(--color-text-muted)]">Decision note: {o.decision_note}</p>
		{/if}
	</div>
{/snippet}

<section class="bg-[var(--color-bg)] rounded-lg shadow p-4 dark:bg-[var(--color-surface)] space-y-4" data-testid="outline-panel">
	<h2 class="text-xl font-semibold text-[var(--color-text)]">Outline</h2>

	{#if !current}
		<p class="text-sm text-[var(--color-text-muted)]" data-testid="outline-empty">No outline yet.</p>
	{:else}
		<div class="space-y-3" data-testid="outline-current">
			<div class="flex flex-wrap items-center gap-3">
				<span class="text-sm font-medium text-[var(--color-text)]">Version {current.version}</span>
				<span class="px-2 py-0.5 rounded-full text-xs font-medium {statusClass[current.status] ?? ''}" data-testid="outline-status">{current.status}</span>
				<span class="text-xs text-[var(--color-text-muted)]">proposed {fmtDate(current.proposed_at)}</span>
				{#if current.status === 'proposed'}
					{#if closedApprovalNote}
						<span class="ml-auto text-sm text-[var(--color-warning-text)]" data-testid="outline-approval-closed">{closedApprovalNote}</span>
					{:else if current.approval_id}
						<a
							href="/approvals/{current.approval_id}"
							class="ml-auto px-3 py-1.5 text-sm bg-[var(--color-primary)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-primary-hover)]"
							data-testid="decide-outline">Decide this outline</a>
					{:else}
						<a href="/approvals" class="ml-auto text-sm text-[var(--color-link)] hover:underline" data-testid="decide-outline">Decide this outline (approvals queue)</a>
					{/if}
				{/if}
			</div>
			{@render outlineBody(current)}
		</div>

		{#if older.length}
			<div class="space-y-2" data-testid="outline-older">
				<h3 class="text-sm font-semibold text-[var(--color-text-muted)]">Older versions</h3>
				{#each older as o (o.id)}
					<details class="border border-[var(--color-border)] rounded-lg p-3" data-testid="outline-older-item">
						<summary class="cursor-pointer text-sm text-[var(--color-text)]">
							Version {o.version}
							<span class="ml-2 px-2 py-0.5 rounded-full text-xs font-medium {statusClass[o.status] ?? ''}">{o.status}</span>
							{#if o.decided_at}<span class="ml-2 text-xs text-[var(--color-text-muted)]">decided {fmtDate(o.decided_at)}</span>{/if}
						</summary>
						<div class="mt-3">{@render outlineBody(o)}</div>
					</details>
				{/each}
			</div>
		{/if}
	{/if}
</section>
