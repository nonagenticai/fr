<!--
  Band ⑤ — BLOCKED gate (read-only).

  Surfaces the card's open (pending) approval(s) when the card is blocked.
  Read-only by design: card approvals raised by n8n
  (POST /api/webhooks/n8n/card-approval) carry NO required-approver rows —
  they are resolved out-of-band via the channel callback_path / recipient
  (Telegram), not the /approvals required-approver flow. (The unified-client's
  approve/reject also POST to routes the backend doesn't register.) So this
  band shows the gate + how it resolves + a deep-link, rather than an inline
  approve/reject that would 404/403 against the real data model.

  Pending approvals are NOT in card.decisions (that feed carries decided
  approvals only) — they come from card.open_approvals, added to the payload
  for this band.

  Also surfaces the conveyor's Runtime State `block_reason` (G-UI-2): why the
  card is blocked / which exit it took, parsed by lib/cards/runtime-state.ts.
  A non-empty reason mounts the band even when the card is not on a BLOCKED
  list (e.g. a `parked:` wait). Text interpolation only — the value is
  producer-written and is never rendered as HTML.
-->
<script lang="ts">
	import type { OpenApproval } from '../types';
	import type { ParsedBlockReason } from '../runtime-state';
	// ⛔ REUSED verbatim from the shared module — not re-implemented, not loosened.
	// This band shows the SAME `approvals.description` the queue and the detail view
	// show; marking it in two of the three places is how a reader concludes the
	// renderer disagrees with itself rather than that the producer emitted garbage.
	import { markUnreadableProducerOutput } from '$lib/approvals/rationale';
	import { moveCardToReady } from '../moveToReady';
	import { isClosedProjectStatus } from '$lib/projects/project-status';

	interface Props {
		blocked: boolean;
		/** null ⇒ the approvals read FAILED — not "there are none". */
		openApprovals: OpenApproval[] | null;
		/** Parsed Runtime State `block_reason`; null/absent ⇒ none recorded. */
		blockReason?: ParsedBlockReason | null;
		/** Planka card + board ids — enable the "no open approval" actions. */
		cardId?: string | null;
		boardId?: string | null;
		/** Owning project's status; closed (archived / delivered) ⇒ no READY press. */
		projectStatus?: string | null;
	}
	let {
		blocked,
		openApprovals,
		blockReason = null,
		cardId = null,
		boardId = null,
		projectStatus = null
	}: Props = $props();

	const projectClosed = $derived(isClosedProjectStatus(projectStatus));

	// UI review 2026-10-07: a BLOCKED card with no open approval used to get
	// copy only — nothing on the page could get it moving again. These actions
	// reuse the EXISTING kanban endpoints (GET board for its lists, POST
	// /api/kanban/cards/:id/move); no new backend surface. The READY list is
	// resolved by NAME from the board at click time — when the board has no
	// READY list the button explains that and the board link remains.
	const boardHref = $derived(boardId ? `/kanban?board=${encodeURIComponent(boardId)}` : '/kanban');
	let moving = $state(false);
	let moveError = $state<string | null>(null);
	let moved = $state(false);

	async function moveBackToReady(): Promise<void> {
		if (moving || !cardId || !boardId || projectClosed) return;
		moving = true;
		moveError = null;
		try {
			const res = await moveCardToReady(cardId, boardId);
			if (res.ok) moved = true;
			else moveError = res.error;
		} finally {
			moving = false;
		}
	}

	// ⚠️ null is UNKNOWN, not empty. The copy below used to state, for a BLOCKED
	// card with an empty list, that it "has no recorded open approval" — an
	// affirmative claim that a failed DB read produced. Unknown gets its own line.
	const unknown = $derived(openApprovals === null);
	const approvals = $derived(openApprovals ?? []);
	// The approval half only speaks when the card is blocked or has an open
	// approval — a reason alone (e.g. a parked wait) must not trigger the
	// "lookup could not be completed" / "on a BLOCKED list" copy.
	const gate = $derived(blocked || approvals.length > 0);
	const show = $derived(gate || blockReason !== null);
	// ⚠️ The conveyor does NOT clear `block_reason` when a card leaves BLOCKED or
	// lands, so a reason on a card that is NOT blocked may be stale. It is shown
	// as HISTORY ("Last block reason" / "Last wait"), never with BLOCKED wording,
	// a Blocked badge or alert styling — that would tell a watcher the card is
	// blocked when it is not. Only `blocked` makes a reason current.
	const historical = $derived(!blocked && blockReason !== null);
	// Neutral band: a historical reason with no open approval to surface.
	const neutral = $derived(historical && !gate);
	// The badge is driven by `blocked` alone; a non-blocked card with an open approval shows 'Approval'.
	const badge = $derived(blocked ? 'Blocked' : approvals.length > 0 ? 'Approval' : 'History');
	const heading = $derived(
		approvals.length > 0 || blockReason === null
			? 'Awaiting approval'
			: historical
				? blockReason.kind === 'wait'
					? 'Last wait'
					: 'Last block reason'
				: blockReason.kind === 'wait'
					? 'Waiting'
					: 'Block reason'
	);

	function fmtExpiry(iso: string | null | undefined): { text: string; overdue: boolean } {
		// NULL = "no deadline, ever". Without this, `new Date(null).getTime()`
		// is 0 — which PASSES the Number.isNaN guard below and renders
		// "expired ~493000h ago". Same defect as the approvals queue.
		if (iso === null || iso === undefined) return { text: 'no deadline', overdue: false };
		const at = new Date(iso).getTime();
		if (Number.isNaN(at)) return { text: iso, overdue: false };
		const diffMs = at - Date.now();
		const overdue = diffMs < 0;
		const hours = Math.round(Math.abs(diffMs) / 3_600_000);
		if (overdue) return { text: `expired ${hours}h ago`, overdue: true };
		if (hours < 48) return { text: `expires in ${hours}h`, overdue: false };
		return { text: `expires ${new Date(iso).toLocaleDateString()}`, overdue: false };
	}
</script>

{#if show}
	<section
		data-testid="blocked-gate"
		class={neutral
			? 'border border-[var(--color-border)] rounded-md bg-[var(--color-surface)]'
			: 'border border-[var(--color-warning)] rounded-md bg-[var(--color-warning-bg)]'}
	>
		<header
			class={neutral
				? 'flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)]'
				: 'flex items-center gap-2 px-4 py-2 border-b border-[var(--color-warning)]'}
		>
			<span
				data-testid="blocked-gate-badge"
				class={neutral
					? 'font-mono text-xs px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] uppercase'
					: 'font-mono text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)] text-[var(--color-on-primary)] uppercase'}
			>
				{badge}
			</span>
			<h3
				data-testid="blocked-gate-heading"
				class={neutral
					? 'text-sm font-medium text-[var(--color-text-muted)]'
					: 'text-sm font-medium text-[var(--color-warning-text)]'}
			>
				{heading}
			</h3>
		</header>
		<div class="px-4 py-3">
			{#if blockReason}
				<div
					data-testid="block-reason"
					data-kind={blockReason.kind}
					data-state={historical ? 'historical' : 'current'}
					class={gate ? 'mb-3' : ''}
				>
					{#if historical}
						<!-- History, not state: no "Blocked" wording (see `historical`). -->
						{#if blockReason.kind === 'unstructured'}
							<p class="text-sm text-[var(--color-text-muted)] whitespace-pre-wrap">
								Reason: <span data-testid="block-reason-raw">{blockReason.raw}</span>
							</p>
						{:else}
							<p class="text-sm text-[var(--color-text-muted)]">
								{#if blockReason.kind === 'wait'}
									Wait: <span class="font-mono" data-testid="block-reason-exit">{blockReason.exit}</span>
								{:else}
									Class: <span class="font-mono" data-testid="block-reason-class">{blockReason.cls}</span>
									· Exit: <span class="font-mono" data-testid="block-reason-exit">{blockReason.exit}</span>
								{/if}
							</p>
							{#if blockReason.detail.trim() !== ''}
								<p
									class="text-xs text-[var(--color-text-muted)] mt-1 whitespace-pre-wrap break-words"
									data-testid="block-reason-detail"
								>{blockReason.detail}</p>
							{/if}
						{/if}
					{:else if blockReason.kind === 'unstructured'}
						<p class="text-sm text-[var(--color-text)] whitespace-pre-wrap">
							Blocked reason: <span data-testid="block-reason-raw">{blockReason.raw}</span>
						</p>
					{:else}
						<p class="text-sm text-[var(--color-text)]">
							{#if blockReason.kind === 'wait'}
								Waiting: <span class="font-mono" data-testid="block-reason-exit">{blockReason.exit}</span>
							{:else}
								Blocked: <span class="font-mono" data-testid="block-reason-class">{blockReason.cls}</span>
								· Exit: <span class="font-mono" data-testid="block-reason-exit">{blockReason.exit}</span>
							{/if}
						</p>
						{#if blockReason.detail.trim() !== ''}
							<p
								class="text-xs text-[var(--color-text-muted)] mt-1 whitespace-pre-wrap break-words"
								data-testid="block-reason-detail"
							>{blockReason.detail}</p>
						{/if}
					{/if}
				</div>
			{/if}
			{#if !gate}
				<!-- reason only: no approval copy -->
			{:else if unknown}
				<p class="text-sm text-[var(--color-text)]">
					The open-approval lookup could not be completed, so this card's gate is
					<strong>unknown</strong> — it may or may not have one.
				</p>
			{:else if approvals.length === 0}
				{#if blockReason === null}
				<p class="text-sm text-[var(--color-text)]">
					This card is on a BLOCKED list but has no recorded open approval. It may
					be waiting on a dependency or a manual gate.
				</p>
				{/if}
				{#if blocked}
					<div class="flex flex-wrap items-center gap-3 mt-3" data-testid="blocked-gate-actions">
						{#if cardId && boardId && !moved && !projectClosed}
							<button
								type="button"
								class="px-3 py-1 text-xs rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[var(--color-text)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
								onclick={moveBackToReady}
								disabled={moving}
								data-testid="blocked-gate-move-ready"
							>
								{moving ? 'Moving…' : 'Move back to READY'}
							</button>
						{/if}
						<a
							href={boardHref}
							class="text-xs text-[var(--color-accent)] hover:underline"
							data-testid="blocked-gate-open-board"
						>
							{cardId && boardId ? 'Open the board →' : 'Open the board to move it →'}
						</a>
					</div>
					{#if moved}
						<p class="text-xs text-[var(--color-text-muted)] mt-2" role="status" data-testid="blocked-gate-moved">
							Moved to READY — this page refreshes within a few seconds.
						</p>
					{/if}
					{#if moveError}
						<p class="text-xs text-[var(--color-danger)] mt-2" role="alert" data-testid="blocked-gate-move-error">
							{moveError}
						</p>
					{/if}
				{/if}
			{:else}
				<ul class="space-y-3">
					{#each approvals as a (a.approval_id)}
						{@const exp = fmtExpiry(a.expires_at)}
						<li class="text-sm border-l-2 border-[var(--color-warning)] pl-3">
							<p class="text-[var(--color-text)]">{markUnreadableProducerOutput(a.description)}</p>
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-[var(--color-text-muted)]">
								{#if a.source}
									<span>source: <span class="font-mono">{a.source}</span></span>
								{/if}
								{#if a.recipient}
									<span>recipient: <span class="font-mono">{a.recipient}</span></span>
								{:else if a.callback_path}
									<span>callback: <span class="font-mono">{a.callback_path}</span></span>
								{/if}
								<span class={exp.overdue ? 'text-[var(--color-danger)] font-medium' : ''}>
									{exp.text}
								</span>
								<a
									href={`/approvals/${encodeURIComponent(a.approval_id)}`}
									class="text-[var(--color-accent)] hover:underline"
								>
									view approval →
								</a>
							</div>
						</li>
					{/each}
				</ul>
				<p class="text-xs text-[var(--color-text-muted)] mt-3 italic">
					Card approvals are resolved out-of-band (channel callback), then n8n
					moves the card off BLOCKED. Use the Approvals view to act on it.
				</p>
			{/if}
		</div>
	</section>
{/if}
