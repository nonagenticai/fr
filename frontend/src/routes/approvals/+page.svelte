<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { formatExpiration } from './expiration';
	import { apiClient } from '$lib/api/unified-client';
	import type { Approval, ApprovalStatus } from '$lib/types/api';
	import { auth } from '$lib/stores/auth.svelte';
	// The ACTIVE workspace, not `auth.user.tenant_name` — the latter is written
	// once at login/restore and is never refreshed by switchTenant(), so it
	// names the wrong workspace for exactly the super-admin who switched.
	import { workspaces } from '$lib/stores/workspaces.svelte';
	import { activeProject } from '$lib/stores/activeProject.svelte';
	import { isRealProject } from '$lib/projects/is-real-project';
	import { goto } from '$app/navigation';
	import ApprovalWorkspaceHint from '$lib/components/approvals/ApprovalWorkspaceHint.svelte';
	import NoPushChannelBanner from '$lib/components/approvals/NoPushChannelBanner.svelte';
	import { canActOnApproval } from '$lib/approvals/canAct';
	import { displayName } from '$lib/utils/displayName';
	import EntityRef from '$lib/components/ui/EntityRef.svelte';
	import { humanizeEnum } from '$lib/utils/humanizeEnum';
	// What the decide response says happened DOWNSTREAM. `PUT /api/approvals/:id`
	// returns `callback: { outcome }`, and only `sent` means the card actually
	// moved; this page used to discard the whole response and treat any 200 as a
	// completed decision. See $lib/approvals/decision-callback.
	import { decisionNotice, type DecisionNotice } from '$lib/approvals/decision-callback';
	// ⭐ THE SAME QUESTION, ASKED OF THE PERSISTED ROW INSTEAD OF THE RESPONSE.
	// `decisionNotice` above only exists in the moment the button is pressed; it
	// is gone on the next reload. The three `callback_*` columns survive, were
	// already on the wire, and were read by NOTHING — so a decided row whose
	// onward callback never acked rendered byte-identically to one that moved,
	// with its card still in BLOCKED. See $lib/approvals/callback-state.
	import { callbackRowNotice } from '$lib/approvals/callback-state';
	// `markUnreadableProducerOutput`: the producer's stringified bugs —
	// `[object Object]`, `step undefined` — replaced by a marker that SAYS a
	// producer value was unreadable, with every legible character around them
	// preserved and clean strings returned byte for byte. Measured on prod: 240
	// pending rows carry one of these tokens and 56 carry `step undefined`; the
	// helper shipped wired into three improvement gate panels and nothing else,
	// so this list — the surface those rows are actually read on — still printed
	// them raw. ⛔ It is a FORMATTER, not a classifier: `producerRationale` still
	// owns "is there content here" on the two rationale columns and is still
	// asked first.
	import {
		producerRationale,
		isNoRationaleSupplied,
		markUnreadableProducerOutput,
		NO_RATIONALE_SHORT
	} from '$lib/approvals/rationale';
	// The QUESTION contract, in ONE module shared with the row page and the
	// backend's own wording. A QUESTION approval is answered by the text of the
	// decision itself — `comment` (falling back to `reason`) is the field the n8n
	// callback forwards — so a page that cannot send that text cannot answer one
	// even in principle. This page could not: `approvals.approve(id)` took no body.
	// Measured on prod: 463 of 491 DECIDED question rows carry a NULL comment.
	// Each of those spent its approval (no second decision is accepted from the
	// same approver) and moved no card.
	import {
		isQuestion,
		answerRequired,
		answerDemandOf,
		isFixAssertion,
		validateAnswer,
		brokenGateTermsOf,
		deblockActionOf,
		approveMoveNotice,
		approveConsequenceNotice,
		cardMoveOnApprove,
		parseProposition,
		questionPresentation,
		ANSWER_CONTRACT,
		FIX_ASSERTION_ARIA_LABEL,
		FIX_ASSERTION_CONTRACT,
		FIX_ASSERTION_LABEL,
		FIX_ASSERTION_PLACEHOLDER,
		FIX_ASSERTION_SUBMIT,
		FIX_ASSERTION_TOGGLE,
		answerlessApproveTitle,
		demandedDecisionText,
		BROKEN_GATE_OVERRIDE_MIN_REASON
	} from '$lib/approvals/question';
	import {
		ACTION_BUCKETS,
		actionBucketOf,
		actionFacetLabel,
		type ActionFacet
	} from '$lib/approvals/action-facets';
	import { usePoll, type PollHandle } from '$lib/net/poll';
	import { Skeleton, EmptyState, ErrorState } from '$lib/components/ui';

	// State for approvals across all projects the user can see.
	let allApprovals = $state<(Approval & { projectName: string | null; workspaceName?: string | null })[]>([]);
	let activeTab = $state<ApprovalStatus>('pending');
	let activeKind = $state<KindGroup>('all');

	/**
	 * The `deblock_action` facet — THE lens a decider actually works by, and the
	 * one this page did not have.
	 *
	 * ⛔ UNLIKE `activeKind`, THIS FILTER IS APPLIED BY THE SERVER, and the
	 * difference is the point of the whole change. `activeKind` narrows the rows
	 * the browser already holds, which is workable when the tab fits in a page
	 * and useless when it does not: on the 2026-09-15 drive the pending tab held
	 * 1,294 rows against a 200-row page, so ~299 of the ~395 QUESTION rows were
	 * not merely unfiltered but UNLOADED — no client-side predicate could ever
	 * have reached them. Sending `?deblock_action=` makes the DB stop producing
	 * the other 899 instead, which both puts the subset inside one page and makes
	 * `total` report the SUBSET's size, so "Showing 200 of 395" is a true
	 * sentence about the thing the operator asked for.
	 *
	 * Changing it therefore REFETCHES (`selectAction`), where changing the kind
	 * chip does not.
	 */
	let activeAction = $state<ActionFacet>('all');

	// The three families of `approvals.kind`. The enum is
	// generic | improvement.{design,release,canary_action} | execution.ready_signoff,
	// so grouping on the prefix keeps a newly-added member inside its family
	// instead of vanishing from every filter.
	type KindGroup = 'all' | 'improvement' | 'execution' | 'other';

	const KIND_LABEL: Record<string, string> = {
		generic: 'Request',
		'improvement.design': 'Improvement · design',
		'improvement.release': 'Improvement · release',
		'improvement.canary_action': 'Improvement · canary',
		'execution.ready_signoff': 'Execution · ready sign-off'
	};

	// An improvement approval carries the ASSET DOMAIN (procedure / prompt /
	// workflow) in `metadata`, never in `kind` — the enum has a single
	// `improvement.*` family covering all three. Without reading metadata the
	// page cannot tell a procedure-improvement request from a prompt one, which
	// is exactly the distinction an operator on this page is looking for.
	const DOMAIN_LABEL: Record<string, string> = {
		procedure: 'Procedure',
		procedures: 'Procedure',
		prompt: 'Prompt',
		prompts: 'Prompt',
		workflow: 'Workflow',
		workflows: 'Workflow'
	};

	/**
	 * The family a RAW `approvals.kind` string belongs to.
	 *
	 * ⭐ Split out of `kindGroupOf` so the server aggregate and the loaded rows
	 * are bucketed by ONE implementation. `kind_totals` arrives keyed by the pg
	 * enum member (`improvement.design`, `improvement.release`, …) with no row
	 * attached, so a second prefix rule written next to the aggregate is a second
	 * place for the families to drift — and a facet that disagrees with its own
	 * filter is the defect being fixed, one layer along.
	 */
	function kindGroupOfKind(kind: string): Exclude<KindGroup, 'all'> {
		if (kind.startsWith('improvement.')) return 'improvement';
		if (kind.startsWith('execution.')) return 'execution';
		return 'other';
	}

	function kindGroupOf(approval: Approval): Exclude<KindGroup, 'all'> {
		return kindGroupOfKind(approval.kind ?? 'generic');
	}

	function improvementDomain(approval: Approval): string | null {
		const metadata = (approval.metadata ?? {}) as Record<string, unknown>;
		const raw = metadata.asset_kind ?? metadata.card_type;
		if (typeof raw !== 'string') return null;
		return DOMAIN_LABEL[raw.toLowerCase()] ?? null;
	}

	/**
	 * The machine-proposed way OUT of a BLOCKED card, carried on
	 * `metadata.deblock_action` (minted by the n8n webhook, read back by
	 * `services/n8n-callback.ts :: buildCallbackPayload`; enum at
	 * backend/src/services/n8n.ts:30).
	 *
	 * It is the single most decision-relevant fact on a pending row and it was
	 * nowhere on the page. Measured on the live queue 2026-08-26: of 29 pending
	 * approvals, 19 proposed QUESTION — a HOLDING action, which holds the card
	 * until it is ANSWERED (⚠️ this line used to say "by design moves no card",
	 * and that reading is what produced 463 empty-comment approvals: an answered
	 * QUESTION does move its card) — and exactly 1 proposed RETRY, which releases
	 * work with no answer at all. Without the badge those 20 rows are identical
	 * until you open each one.
	 *
	 * Returns null when the field is absent (9 of the 29 carry none). The badge
	 * then renders NOTHING: a fabricated "Unknown" chip would put a label on
	 * two-thirds of a tab it cannot describe, which is worse than silence.
	 *
	 * ⚠️ The BODY now lives in `$lib/approvals/question` (`deblockActionOf`), so
	 * this page, the row page and the answer validator read the field through one
	 * implementation. The NAME is kept: it is called from `questionSelected`,
	 * `approvableSelected` and the badge below.
	 */
	function deblockAction(approval: Approval): string | null {
		return deblockActionOf(approval);
	}

	// QUESTION parks the card and asks the human something; every other member of
	// the enum ends the block one way or another. That hold/release split is the
	// distinction the operator is scanning for, so it gets the warning tone.
	// Delegates to the shared module for the same reason as above — the carve-out
	// in `questionSelected` and the answer gate on the server must agree on
	// exactly which rows are QUESTIONs, and two spellings of `=== 'QUESTION'`
	// drift.
	//
	// ⚠️ `isQuestion` takes an APPROVAL, not an action string, because it reads
	// `metadata.deblock_action` itself. This helper's callers hold an action they
	// have already extracted (`questionSelected`, `approvableSelected`, the
	// badge), so the string is fed back through a metadata-shaped literal rather
	// than duplicating the `toUpperCase() === 'QUESTION'` comparison here. The
	// signature is kept as `(action: string)` on purpose — changing it would
	// change every call site for no behavioural gain.
	function isHoldingAction(action: string): boolean {
		return isQuestion({ metadata: { deblock_action: action } } as unknown as Approval);
	}

	/**
	 * The row's scope badge. A null `projectName` means a workspace-scoped row
	 * (the n8n improvement loops and the KAG worker raise these), which used to
	 * render as the bare word "Workspace" — naming no workspace, so the
	 * procedure-improvement and prompt-improvement queues were indistinguishable
	 * from the system one in a super-admin's cross-workspace view.
	 */
	function scopeBadge(approval: { projectName: string | null; workspaceName?: string | null }): string {
		if (approval.projectName) return approval.projectName;
		return approval.workspaceName ? `Workspace · ${approval.workspaceName}` : 'Workspace';
	}

	/** Human label for the row chip, e.g. "Procedure improvement · design". */
	function kindLabel(approval: Approval): string {
		const kind = approval.kind ?? 'generic';
		const base = KIND_LABEL[kind] ?? kind;
		const domain = kind.startsWith('improvement.') ? improvementDomain(approval) : null;
		return domain ? base.replace('Improvement', `${domain} improvement`) : base;
	}

	const KIND_FILTERS: { label: string; value: KindGroup }[] = [
		{ label: 'All', value: 'all' },
		{ label: 'Improvement', value: 'improvement' },
		{ label: 'Execution', value: 'execution' },
		{ label: 'Other', value: 'other' }
	];

	// Empty-state body per tab. A `Record<ApprovalStatus, string>` on purpose:
	// this used to be a ternary chain whose final `else` was the "rejected"
	// copy, so when the `expired` tab was added (#779) the Expired tab silently
	// rendered "No approvals have been rejected yet." A Record makes the next
	// added status a COMPILE error instead of wrong copy nobody notices.
	const EMPTY_BODY: Record<ApprovalStatus, string> = {
		pending: 'There are no pending approvals at this time.',
		approved: 'No approvals have been approved yet.',
		rejected: 'No approvals have been rejected yet.',
		expired: 'No approvals have expired. Expired approvals were never decided before their deadline.',
		// ⭐ REACHABLE SINCE THE VOIDED TAB LANDED. This copy sat here unreachable for
		// the whole time the status existed without a tab — the Record is exhaustive BY
		// DESIGN (see above), so migration 110 forced the copy to be written while
		// nothing forced the tab to be added, and 892 voided rows were loaded and then
		// dropped at render (see the `tabs` list). The exhaustive Record did its job:
		// the Voided tab inherited its own wording rather than the Rejected string,
		// which is the exact #779 regression it exists to prevent.
		voided: 'No approvals have been voided. A voided approval was withdrawn without a decision because it could never have been answered \u2014 no approver, no gate terms, no rationale from the producer.',
		// ── E-5 ACTION-BUS LIFECYCLE STATES ──────────────────────────────────────
		// Written by backend domain/engagement/action-approvals.ts, not by a human
		// and not by the expiry clock. The exhaustive Record forced this copy to be
		// written the moment `ApprovalStatus` learned them \u2014 which is the whole
		// point of it being a Record (see above), and is exactly how `voided` got
		// its own wording instead of inheriting Rejected's.
		//
		// ⭐ DELIBERATELY NO TAB, and that is not the #779/110 mistake repeating.
		// Those two were HUMAN approval outcomes with rows on prod and no way to
		// see them. These are an internal action lifecycle, 0 rows on prod
		// (2026-09-13), and the `hiddenCount` guard below is built precisely to
		// count them out loud on the first one the bus writes rather than swallow
		// it \u2014 its own docblock names these three statuses as the case it
		// exists for. Adding three empty operator tabs now would hide that signal
		// behind a tab nobody opens. If the bus ever populates them, hiddenCount
		// says so and the tab is the deliberate next step.
		executing: 'No approvals are executing. An executing approval was approved and its action is still running \u2014 this is a machine state, not something awaiting you.',
		done: 'No approvals are done. A done approval had its action run to completion after approval.',
		failed: 'No approvals have failed. A failed approval was approved but its action could not be completed \u2014 the decision stands, the work did not.'
	};

	// Loading and error states
	let isLoading = $state(true);
	let error = $state<unknown>(null);
	/**
	 * Load state of THE QUEUE READ — three values, not a boolean.
	 *
	 * ⛔ THE DEFECT, AND IT IS THE SHARPEST INSTANCE OF ITS CLASS IN THIS APP.
	 * `{#if error}` (the ErrorState above) and the empty state below were
	 * SIBLING conditionals with no mutual exclusion. On a first-load failure
	 * `error` is set, `isLoading` falls to false and `allApprovals` is still
	 * empty — so both rendered, and the page said, simultaneously, "Error" and
	 * "There are no pending approvals at this time." This is the human-decision
	 * seat of the conveyor: an operator reading the confident half walks away
	 * from a queue that may hold 1,294 rows. A failed read and an empty queue
	 * are different facts and must never be able to co-render.
	 *
	 * ⛔ WHY NOT JUST GATE THE EMPTY STATE ON `error`. `error` is this page's
	 * SHARED error slot — a decide failure, a "decision recorded but the refresh
	 * failed" notice and a rejection with no reason all write it, and none of
	 * those means the queue is unreadable. Gating on it would suppress the empty
	 * state after a validation error, which is a second lie in the other
	 * direction. This field is written by `fetchApprovals` ALONE and answers one
	 * question: did the read that produced these rows succeed?
	 *
	 * ⚠️ DELIBERATELY NOT `pendingApprovalsState`'s "once ready, always ready"
	 * policy, and the difference is load-bearing. That field guards a NUMBER, so
	 * leaving the last known count on screen is the quiet option. This one gates
	 * a SENTENCE in the present tense — "There are no pending approvals at this
	 * time." — which requires a read that just succeeded. See the `catch` in
	 * `fetchApprovals` for the exact condition and the three cases it covers.
	 * The tri-state shape itself is `planState`'s, from `settings/usage`.
	 */
	let queueState = $state<'loading' | 'ready' | 'unreadable'>('loading');
	/**
	 * Which approvals are CURRENTLY being decided.
	 *
	 * Was `string | null` — a single slot, which is exactly one in-flight row.
	 * A bulk decide puts N requests on the wire at once, and a single slot can
	 * only ever spin one of their buttons while silently leaving the other N-1
	 * looking idle and clickable. A Set is the honest shape. Reassigned rather
	 * than mutated (`new Set([...])`) because a raw Set is not deeply reactive —
	 * same convention as `selectedIds` in AssetList.svelte.
	 */
	let actionLoading = $state<Set<string>>(new Set());

	const isActing = (id: string): boolean => actionLoading.has(id);

	function markActing(ids: string[]): void {
		actionLoading = new Set([...actionLoading, ...ids]);
	}

	function clearActing(ids: string[]): void {
		const next = new Set(actionLoading);
		for (const id of ids) next.delete(id);
		actionLoading = next;
	}

	// Reject modal state
	let showRejectModal = $state(false);
	let rejectingApprovalId = $state<string | null>(null);
	// The SAME modal, aimed at the selection instead of one row: one reason is
	// typed once and applied to every selected approval. Deliberately not a
	// second modal — the reason field, its required-ness and its copy would then
	// have two definitions that drift apart.
	let rejectingSelection = $state(false);
	let rejectReason = $state('');

	// ---- Bulk decide -------------------------------------------------------
	// Selection is EPHEMERAL and component-local, per the AssetList precedent
	// (`selected` there; see its comment at :70). It is not in the URL: a link
	// that pre-selects rows for an irreversible decision is a hazard, not a
	// feature.
	let selectedIds = $state<Set<string>>(new Set());
	let bulkPending = $state(false);

	/**
	 * Per-row outcome of the last bulk decide — one entry per attempted row,
	 * `ok` either way.
	 *
	 * N in-flight decisions have N independent outcomes. Collapsing them into
	 * one try/catch (the AssetList `runBulk` shape) reports the FIRST rejection
	 * and loses the rest, so "12 of 20 worked" renders as one error message
	 * naming one row, or — worse, if the catch is skipped — as success. Every
	 * row that failed is named on screen with its reason.
	 */
	let bulkResults = $state<
		{
			id: string;
			description: string;
			ok: boolean;
			message: string;
			/**
			 * ⭐ SEPARATE FROM `ok`, AND THAT SEPARATION IS THE POINT. `ok:false`
			 * puts a row back into `selectedIds` as the retry set. A decision that
			 * WAS recorded but whose callback failed must never land there: the row
			 * is decided-once per approver, so retrying it earns a 422 on a decision
			 * that already exists. So the decision result stays in `ok`, and what
			 * happened downstream is reported here, beside it.
			 */
			notice?: DecisionNotice;
		}[]
	>([]);
	let bulkVerb = $state<'approved' | 'rejected'>('approved');

	/**
	 * What happened to a row the operator just decided — pinned WHERE THAT ROW
	 * WAS, and kept there until they dismiss it.
	 *
	 * ⛔ NOT folded into `error`. `error` renders an ErrorState with a Retry that
	 * re-fetches the queue, and it is the channel for "your decision did not
	 * happen". This is the opposite claim — the decision DID happen — and telling
	 * those apart is the whole reason the server reports `callback.outcome`.
	 *
	 * ⛔ F4 — THIS USED TO BE ONE PAGE-LEVEL SLOT RENDERED ABOVE THE TABS, and
	 * that placement is the product owner's bug report. Decide row 40 of 991:
	 * the only feedback is written a thousand pixels above the viewport, and the
	 * row it is about disappears from the list on the next refresh. The operator
	 * sees a row vanish and no message. Their words were "Approve seemed to
	 * fail" — on the one surface where the decision had in fact been recorded.
	 *
	 * ⛔ AND IT WAS ONLY EVER WRITTEN ON FAILURE. The old assignment was
	 * `notice.delivered ? null : notice`, so the SUCCESS case — the common one —
	 * cleared the slot and rendered nothing at all. "Nothing happened" was
	 * literally the UI's representation of success. Every outcome is recorded
	 * here now, including `sent`, because `$lib/approvals/decision-callback`
	 * exists precisely to distinguish "recorded AND the card moved" from
	 * "recorded, card untouched", and a distinction nobody renders is not one.
	 *
	 * `index` is where the row sat in the rendered list at the moment of the
	 * decision. It is captured BEFORE the refresh because afterwards the row is
	 * gone and nothing can say where it was.
	 */
	interface DecisionReceipt {
		id: string;
		index: number;
		/** The row's own description, so the card is named when the row is gone. */
		title: string;
		notice: DecisionNotice;
	}
	let receipts = $state<DecisionReceipt[]>([]);

	/** The receipt for a row, if it has one. */
	function receiptFor(id: string): DecisionReceipt | undefined {
		return receipts.find((r) => r.id === id);
	}

	/**
	 * Record the outcome of a decision against the row that produced it.
	 *
	 * Called BEFORE `fetchApprovals()` in every decide path, because the index
	 * and the description both come from a row the refresh is about to remove.
	 */
	function noteDecision(approvalId: string, notice: DecisionNotice): void {
		const index = filteredApprovals.findIndex((a) => a.id === approvalId);
		const row = allApprovals.find((a) => a.id === approvalId);
		const receipt: DecisionReceipt = {
			id: approvalId,
			// -1 (the row was not on screen — a bulk run, a stale list) pins the
			// receipt to the top of the list rather than off the end of it.
			index: index < 0 ? 0 : index,
			title: row?.description ?? 'This approval',
			notice,
		};
		receipts = [...receipts.filter((r) => r.id !== approvalId), receipt];
	}

	function dismissReceipt(id: string): void {
		receipts = receipts.filter((r) => r.id !== id);
	}

	/**
	 * The palette for a decision outcome. FOUR tones, not two.
	 *
	 * The old block had an error branch and an else, which was adequate only
	 * because it never rendered a delivered or an informational outcome at all.
	 * `decisionNotice` maps every outcome onto a tone deliberately — `sent` is
	 * the ONLY green, `not-attempted` and `skipped-no-callback-path` are blue
	 * (correct, complete, and no card was owed a move), `timeout-unknown` and
	 * `absent` are amber (nothing observed has failed), `failed` is red — and
	 * collapsing four tones into two would restate as "problem/not problem" a
	 * distinction whose whole value is that it is finer than that.
	 */
	function noticeToneClass(tone: DecisionNotice['tone']): string {
		switch (tone) {
			case 'success':
				return 'border-[var(--color-success)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]';
			case 'error':
				return 'border-[var(--color-danger)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]';
			case 'info':
				return 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)]';
			case 'warning':
			default:
				return 'border-[var(--color-warning)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
		}
	}

	/**
	 * Gap between two consecutive decides, in ms — 100ms of headroom over the
	 * server's own 1000ms per-approver floor.
	 *
	 * ⛔ This is NOT a nicety, and it is not tunable downwards. Measured
	 * 2026-09-09: an operator selected 1206 rows and clicked Approve; the old
	 * `Promise.all` fan-out landed 152 of them in 16 seconds and took 422 on the
	 * other 1054. The server's limiter is CHECK-THEN-ACT with no lock — it does
	 * `select(last decision)` and then `insert(...)` with no transaction and no
	 * unique constraint (fr#1062: 644 decisions observed BELOW the threshold,
	 * median gap 11ms) — so the server cannot bound a concurrent fan-out at all.
	 * A sequential, self-paced client is the only thing that actually bounds it.
	 */
	const BULK_INTERVAL_MS = 1100;

	/**
	 * The limiter's OWN error text. A 422 that says this is a pacing miss and is
	 * worth exactly one retry; every other 422 ("no longer pending", "not an
	 * approver") is a decision the server has already made and retrying it just
	 * spends another interval to be told the same thing.
	 */
	const LIMITER_SIGNATURE = /minimum \d+ms/;

	// Progress of the in-flight run. A 1206-row run is ~22 minutes of wall clock
	// and NOTHING persists it — no job row, no resumable cursor — so the operator
	// has to be told how far it has got and that closing the tab ends it.
	let bulkDone = $state(0);
	let bulkTotal = $state(0);
	let bulkStartedAt = $state(0);
	let bulkCancelled = $state(false);
	/** QUESTION rows deliberately NOT approved — see `questionSelected` below. */
	let bulkSkipped = $state<{ id: string; description: string }[]>([]);

	/**
	 * Cancellation for the in-flight run. A plain `let`, NOT `$state`: it is
	 * control flow, never rendered. Making it reactive would invalidate every
	 * derived that touches it on each run for no visible change.
	 */
	let bulkAbort: AbortController | null = null;

	/**
	 * Sleep that ends EARLY on abort instead of stranding the loop for a full
	 * interval after the operator clicked Cancel. Uses a real `setTimeout` (not a
	 * Date-polling loop) so a faked clock can drive it in tests.
	 */
	function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			const t = setTimeout(resolve, ms);
			signal.addEventListener(
				'abort',
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true }
			);
		});
	}

	/** "~19m left" / "~45s left" — coarse on purpose; it is a pacing floor, not a promise. */
	function formatEta(remainingMs: number): string {
		const seconds = Math.max(0, Math.round(remainingMs / 1000));
		if (seconds < 60) return `~${seconds}s left`;
		return `~${Math.max(1, Math.round(seconds / 60))}m left`;
	}

	// Polling handle — fires fetchApprovals immediately on start, then every
	// 30s; pauses when the tab is hidden, exponential backoff on failure.
	const pollHandle: PollHandle = usePoll(fetchApprovals, { intervalMs: 30_000 });

	// ── Project filter (UI review 2026-10-07) ──────────────────────────────────
	// The page had no way to narrow to one project. `''` = all projects. The
	// initial value is the URL's `?project=` when present (a link from a
	// project's nav must land on THAT project even if the header selection
	// differs), else the header-selected project. Read from `window.location`
	// at init rather than `$page`, because the first poll fires from onMount and
	// must already carry the filter.
	function initialProjectFilter(): string {
		try {
			if (typeof window !== 'undefined') {
				const fromUrl = new URLSearchParams(window.location.search).get('project');
				if (fromUrl) return fromUrl;
			}
		} catch {
			// No URL to read — fall through to the store.
		}
		return activeProject.activeId ?? '';
	}
	let projectFilter = $state<string>(initialProjectFilter());
	const projectOptions = $derived(activeProject.projects.filter(isRealProject));

	function selectProject(id: string): void {
		if (id === projectFilter) return;
		projectFilter = id;
		pageLimit = PAGE_SIZE;
		writeProjectToUrl(id);
		void fetchApprovals();
	}

	/** Reflect the filter in the URL so the view is linkable and survives a reload. */
	function writeProjectToUrl(id: string): void {
		try {
			const u = new URL(window.location.href);
			if (id) u.searchParams.set('project', id);
			else u.searchParams.delete('project');
			void goto(`${u.pathname}${u.search}`, { replaceState: true, noScroll: true, keepFocus: true }).catch(() => {});
		} catch {
			// Router not ready (or no window) — the filter still applies.
		}
	}

	// Derived state - filter approvals by active tab, then by kind family, then
	// by deblock action.
	const byStatus = $derived(allApprovals.filter(approval => approval.status === activeTab));
	const byKind = $derived(
		activeKind === 'all' ? byStatus : byStatus.filter(a => kindGroupOf(a) === activeKind)
	);
	/**
	 * ⭐ A BELT OVER A SERVER FILTER, NOT THE FILTER ITSELF. The rows already
	 * arrive narrowed (`?deblock_action=`), so on a current backend this predicate
	 * removes nothing — which is exactly the state it should be in, and the same
	 * reasoning `byStatus` is kept for one line up ("what keeps the page correct
	 * if a response ever carries a row of another status").
	 *
	 * It is not decoration: an older bundle, or a proxy that drops the query
	 * string, answers an action-filtered request with the WHOLE tab, and the page
	 * would then render 200 unrelated rows under a chip that says QUESTION.
	 * Silently showing the wrong rows is worse than showing none, so the client
	 * enforces the claim its own chip is making. `actionBucketOf` is the mirror of
	 * the server's bucketing CASE — see `$lib/approvals/action-facets`.
	 */
	const filteredApprovals = $derived(
		activeAction === 'all' ? byKind : byKind.filter(a => actionBucketOf(a) === activeAction)
	);

	/**
	 * The rows a bulk decide may touch: visible, still pending, and ones THIS
	 * user may actually decide. Gated on the same `canActOnApproval` as the
	 * per-row buttons, so bulk can never offer a decision the single-row path
	 * refuses — a checkbox on a row the backend will 422 is a dead control.
	 */
	const selectableApprovals = $derived(
		filteredApprovals.filter((a) => a.status === 'pending' && canActOnApproval(a, auth.user))
	);
	const selectedApprovals = $derived(selectableApprovals.filter((a) => selectedIds.has(a.id)));
	const allSelected = $derived(
		selectableApprovals.length > 0 && selectedApprovals.length === selectableApprovals.length
	);
	/**
	 * The list as RENDERED: every row of the active tab, plus a receipt card
	 * standing in the place of each decided row that the refresh has since
	 * removed.
	 *
	 * ⭐ THE SPLICE IS THE POINT. A receipt appended to the end, or hoisted to
	 * the top, is the page-level banner again under another name: the operator
	 * decided row 40 and has to go looking for the answer. Re-inserting at the
	 * row's remembered index puts the outcome where their eyes already are.
	 *
	 * Receipts are inserted in ASCENDING index order so that each insertion
	 * shifts only positions after it, and clamped to the list length so a
	 * receipt for a row near the end of a queue that has since shrunk lands at
	 * the end rather than being dropped.
	 *
	 * A row that is STILL in the list (a `not-attempted` outcome — the approval
	 * needs another approver, so the row stays pending) gets no receipt entry
	 * here: its notice renders inside the row itself, which is nearer still.
	 */
	const displayRows = $derived.by(() => {
		const entries: (
			| { kind: 'row'; key: string; approval: (typeof filteredApprovals)[number] }
			| { kind: 'receipt'; key: string; receipt: DecisionReceipt }
		)[] = filteredApprovals.map((approval) => ({
			kind: 'row' as const,
			key: approval.id,
			approval,
		}));
		const present = new Set(filteredApprovals.map((a) => a.id));
		const orphans = receipts
			.filter((r) => !present.has(r.id))
			.slice()
			.sort((a, b) => a.index - b.index);
		for (const receipt of orphans) {
			entries.splice(Math.min(Math.max(receipt.index, 0), entries.length), 0, {
				kind: 'receipt' as const,
				key: `receipt:${receipt.id}`,
				receipt,
			});
		}
		return entries;
	});

	const bulkFailures = $derived(bulkResults.filter((r) => !r.ok));
	/**
	 * Rows whose DECISION landed and whose CARD did not move.
	 *
	 * Not failures (they are not retryable and must not be re-selected) and not
	 * successes (nothing downstream happened). A run that is entirely this is the
	 * exact case the old green "Approved N approvals." banner mis-reported.
	 */
	const bulkStranded = $derived(bulkResults.filter((r) => r.ok && r.notice));

	/**
	 * Selected rows a bulk APPROVE must refuse to touch — the rows the server
	 * refuses an answerless approve on.
	 *
	 * ⛔ An approved QUESTION with an empty comment does not release its card, it
	 * STRANDS it, and then the gate mints a fresh approval on the same card. The
	 * n8n consumer needs `answerText.length > 0` to move anything, and a bulk
	 * approve records no comment at all. Captured end to end 2026-09-09: approval
	 * `f7dc13c3` approved 05:00:50Z with a null comment → card
	 * `1807363434510026103` still BLOCKED at 05:15:07Z → a NEW approval
	 * `a6da06b5` now open on the same card. 97 cards already carry
	 * `approval_answer_missing`, and the count is still climbing. So a bulk
	 * approve over QUESTION rows does not drain the queue — it MULTIPLIES it.
	 *
	 * ⚠️ NARROW, AND MEASURED — "anything that looks risky" would quietly disable
	 * the feature. `answerRequired` fires on a typed QUESTION or on a row carrying
	 * non-empty `metadata.open_questions`, and nothing else: measured 2026-09-10,
	 * that is 137 + 15 of 1040 pending rows. INFRASTRUCTURE (244), RETRY (442),
	 * SPLIT, DEPENDENCY, DROP, MERGE and every action-less row that states no
	 * question stay bulk-approvable, because none of them owes anyone an answer.
	 *
	 * REJECT is deliberately not filtered: rejecting a QUESTION is a real answer
	 * (the reason text is recorded), so the reject path takes the whole selection.
	 */
	// ⛔ THE SAME PREDICATE AS THE PER-ROW GATE AND AS THE SERVER, not a second
	// spelling of `=== 'QUESTION'`. A bulk approve records NO comment, so any row the
	// server refuses an answerless approve on is a row this button cannot decide —
	// and a checkbox on a row the backend will 422 is a dead control. `answerRequired`
	// is the union of "typed QUESTION" (the receiver's rule) and "states a question"
	// (`metadata.open_questions`, 15 of 1040 pending rows on 2026-09-10), so the 15
	// rows that actually ask a human something now leave the bulk-approve set too,
	// where before they were bulk-approved with no answer at all.
	const questionSelected = $derived(
		selectedApprovals.filter((a) => answerRequired(a, 'approved'))
	);
	// ⛔ Since 2026-09-14 `answerRequired` also covers INFRASTRUCTURE / DEPENDENCY (an
	// approve re-drives the card and must state the fix). Those rows are in the set
	// above, and the banner must not call them QUESTIONs — so it is told how many.
	const fixSelectedCount = $derived(questionSelected.filter((a) => isFixAssertion(a)).length);
	/**
	 * Selected rows whose gate is BROKEN. The server refuses every approve on these
	 * (#1064), so a bulk approve that included them would fire one doomed request per
	 * row and report each as a failure.
	 *
	 * ⛔ THE SECOND CARVE-OUT, AND IT WAS MISSING. `approvableSelected` subtracted only
	 * the QUESTION rows, so on 2026-09-13 a select-all bulk approve would have sent 174
	 * requests that could not succeed — measured against production: 974 pending, 174
	 * carrying a broken gate term. Per-row Approve is now disabled on these, and this is
	 * the same rule applied to the bulk path so the two cannot disagree.
	 */
	const brokenGateSelected = $derived(
		selectedApprovals.filter((a) => brokenGateTermsOf(a).length > 0)
	);
	/**
	 * The complement — the rows a bulk approve may actually decide.
	 *
	 * ⚠️ BOTH carve-outs subtract, and they can OVERLAP: a row may be a broken gate AND
	 * an answer demand. Filtering with both predicates (rather than subtracting two counts)
	 * is what keeps this correct if that intersection ever stops being 0, which it is today.
	 */
	const approvableSelected = $derived(
		selectedApprovals.filter(
			(a) => !answerRequired(a, 'approved') && brokenGateTermsOf(a).length === 0
		)
	);
	const bulkEta = $derived(formatEta(Math.max(0, bulkTotal - bulkDone) * BULK_INTERVAL_MS));

	function toggleRow(id: string): void {
		const next = new Set(selectedIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedIds = next;
	}

	function toggleAllRows(): void {
		selectedIds = allSelected ? new Set() : new Set(selectableApprovals.map((a) => a.id));
	}

	function clearSelection(): void {
		selectedIds = new Set();
	}

	// Ephemeral by design: changing the status tab, either filter or the
	// workspace re-populates the list under the operator, and a selection made
	// against the old population would decide rows they can no longer see.
	//
	// ⛔ `activeAction` BELONGS HERE AND IS THE STRONGEST CASE OF THE FOUR. It
	// refetches from the server, so the rows are replaced outright rather than
	// merely re-filtered; a surviving tick would be a decision aimed at a row
	// that is no longer on the page at all.
	$effect(() => {
		void activeTab;
		void activeKind;
		void activeAction;
		void workspaces.scopeKey;
		// ⛔ …but NEVER out from under a run that is already going. A paced bulk
		// decide takes minutes, and its selection IS its work queue: wiping it
		// mid-flight would leave the loop deciding rows the page no longer shows
		// as selected, and would destroy the never-attempted set the operator
		// needs after a cancel. Read UNTRACKED on purpose — a tracked read would
		// make the `bulkPending` false-flip at the end of the run re-fire this
		// effect and erase the report and the retry set it just wrote.
		if (untrack(() => bulkPending)) return;
		selectedIds = new Set();
		bulkResults = [];
	});

	/**
	 * Status-tab count. Deliberately IGNORES the kind filter.
	 *
	 * It used to honour it, on the theory that a tab should agree with the list
	 * under it. Measured in the live drive 2026-08-26: on a workspace holding 33
	 * expired approvals, selecting the Improvement filter made every tab read
	 * `Pending 0 Approved 0 Rejected 0 Expired 0` — so the page said, in the
	 * loudest numbers on the screen, that the workspace was empty. It is not;
	 * those 33 are one chip away. The two rows answer different questions and
	 * only one of them is navigation: the status tabs say where approvals LIVE
	 * (stable, so you can still find them), the kind chips lens the tab you are
	 * on. The empty state already explains the gap between them.
	 *
	 * ⭐ IT NOW COUNTS THE POPULATION, NOT THE LOADED ROWS, AND THAT IS THE WHOLE
	 * POINT OF THIS CHANGE. `allApprovals` used to be every row of every status
	 * because the fetch was unbounded, so counting it was accidentally the same
	 * as counting the population. The moment the fetch is bounded (`PAGE_SIZE`)
	 * and scoped to the active tab, a loaded-row count would read `Pending 200`
	 * beside a sidebar badge reading `991` — the very disagreement this change
	 * exists to end, reintroduced on the other surface. `statusTotals` holds
	 * each status's `total` as the endpoint reported it.
	 *
	 * ⚠️ The fallback is NOT defensive padding. A pre-#855 server sends no
	 * `total`, and every existing unit test mocks `listAll` with a bare
	 * `{ items }`; in both cases the only number available is the loaded one,
	 * and printing nothing there would be worse than printing a count that
	 * happens to be complete. It is last-resort, and it is why this change is
	 * inert against a payload that cannot support it.
	 */
	function statusCount(status: ApprovalStatus): number {
		const total = statusTotals[status];
		if (typeof total === 'number') return total;
		return allApprovals.filter((a) => a.status === status).length;
	}

	/**
	 * A pill count, or `—` when the read that would have produced it never
	 * succeeded.
	 *
	 * ⛔ WITHOUT THIS THE MUTUAL EXCLUSION BELOW IS COSMETIC. `statusCount`,
	 * `kindCount` and `actionCount` all fall back to counting `allApprovals`,
	 * which is `[]` on a failed first load — so the tab would read "Pending 0"
	 * and the chips "Improvement 0" directly above a panel saying the queue
	 * could not be read. "Pending 0" IS the claim that the queue is empty, just
	 * written as a number instead of a sentence, and it is the same defect the
	 * unreadable branch exists to delete.
	 *
	 * Only the never-read case is blanked: once rows have landed the counts are
	 * measured and stay, exactly like the rows themselves.
	 */
	function countLabel(n: number): string {
		return queueState === 'unreadable' ? '—' : String(n);
	}

	/**
	 * Is this list actually showing more than the named workspace?
	 *
	 * READ FROM THE RESPONSE, not from the rows. A super-admin whose active
	 * workspace is their own gets a deliberate cross-workspace read (see the
	 * `superAdminHome` note in backend/src/routes/approvals.ts), and the endpoint
	 * now STATES which population it covered (#855).
	 *
	 * ⚠️ The vocabulary WIDENED on 2026-09-22 and this comment used to name the
	 * old two values. The scope is now one of the backend's `APPROVAL_SCOPE`
	 * (`backend/src/lib/approval-roster-lane.ts`): `all`, `tenant` (the
	 * `/api/approvals/all` default since P1-TEAM-a — the tenant lane, every
	 * project of the active tenant), `tenant_owned_or_rostered` (still emitted by
	 * `GET /api/approvals`, and what a rollback image emits here), `tenant_rostered`,
	 * `project`.
	 *
	 * ⭐ Only `'all'` is load-bearing HERE. Every other value means "one tenant",
	 * which is exactly what `crossWorkspace === false` should say, so the
	 * comparison below needed no change when the vocabulary grew — only this
	 * TYPE did. That is the whole reason to widen it rather than to re-derive
	 * the question: an equality against the ONE value that matters degrades
	 * correctly for values it has never heard of.
	 *
	 * ⛔ This used to sniff the rows — `some(row.workspaceName !== active.name)`.
	 * That was already the weaker test, because an unscoped query whose rows
	 * happen to be homogeneous is indistinguishable from a scoped one, and it
	 * became untenable when #855 paginated this endpoint: `items` is now ONE
	 * PAGE, so the header would confidently print "in <workspace>" over a
	 * cross-workspace result whose first page happened to be uniform. Two
	 * mechanisms answering one question, and the authoritative one is the flag.
	 *
	 * Undefined before the first response, and on a pre-#855 payload, both of
	 * which correctly read as "not cross-workspace" rather than flickering.
	 */
	let listScope = $state<
		'all' | 'tenant' | 'tenant_owned_or_rostered' | 'tenant_rostered' | 'project' | undefined
	>(undefined);
	const crossWorkspace = $derived(listScope === 'all');

	/**
	 * Size of the WHOLE matching population, as the endpoint reported it —
	 * `total`, which since #855 counts the full query and NOT the page in
	 * `items` (backend/src/routes/approvals.ts: "`total` counts the WHOLE
	 * matching population, not the page").
	 *
	 * ⛔ It exists here for ONE purpose: to admit that the loaded rows may be a
	 * subset. It must never be the number next to a bulk button. Select-all can
	 * only ever select rows that are IN `items`, so a control labelled with
	 * `total` would offer a decision over rows the page does not have — the
	 * selection-count form of the header bug: never infer a property of the QUERY from the SAMPLE
	 * it returned. A page can be the whole population, or one slice of it, and
	 * the rows themselves cannot tell you which.
	 *
	 * Undefined before the first response and on a payload without `total`,
	 * both of which read as "no truncation claim" rather than "nothing hidden".
	 */
	let loadedTotal = $state<number | undefined>(undefined);
	const hiddenCount = $derived(
		loadedTotal === undefined ? 0 : Math.max(0, loadedTotal - allApprovals.length)
	);

	/**
	 * ⛔ F5 — THE FETCH WAS UNBOUNDED, AND THE SERVER DOES NOT BOUND IT FOR YOU.
	 * `listAll()` was called with no `status` and no `limit`, and
	 * `handleListAllApprovals` skips `.limit()` entirely when `limit` is absent.
	 * So every 30s tick pulled EVERY row of EVERY status — for a super-admin in
	 * their home view, of every tenant — each one roster-enriched,
	 * decision-enriched and identity-resolved. Measured on prod 2026-09-13:
	 * 3,992 rows. The page then rendered at most one status of them.
	 *
	 * ⭐ 200 IS A PAGE, NOT A CEILING. `hiddenCount` states the gap out loud and
	 * `loadMore` raises the window. This number is chosen so the FIRST screen is
	 * cheap, not so the queue is small: the working set on prod is 963 pending,
	 * which is five presses of Load more, or one press of Load all.
	 */
	const PAGE_SIZE = 200;

	/**
	 * The server's own clamp (`MAX_APPROVALS_PAGE_SIZE`, backend
	 * routes/approvals.ts). Asking for more is not an error — it is silently
	 * clamped — so the button that would ask for more must not pretend it did.
	 * `hiddenCount` keeps reading the truth either way, because `total` is
	 * counted from the whole population and never from the page.
	 */
	const MAX_PAGE_SIZE = 1000;

	let pageLimit = $state(PAGE_SIZE);
	const atServerPageCeiling = $derived(pageLimit >= MAX_PAGE_SIZE);

	function loadMore(): void {
		if (atServerPageCeiling) return;
		pageLimit = Math.min(MAX_PAGE_SIZE, pageLimit + PAGE_SIZE);
		void fetchApprovals();
	}

	/**
	 * Switch status tab.
	 *
	 * ⛔ A REFETCH IS NOW MANDATORY, where a bare `activeTab = …` used to be
	 * enough. The rows are one page of ONE status, so the new tab's rows are not
	 * in `allApprovals` and nothing else would go and get them until the 30s
	 * tick — an empty Approved tab on a workspace holding 1,984 approved rows.
	 * `pageLimit` resets with it: "load more" was an act about the tab being
	 * left, and carrying it across would silently make the first read of a new
	 * tab five times more expensive than the last.
	 */
	function selectTab(status: ApprovalStatus): void {
		if (status === activeTab) return;
		activeTab = status;
		pageLimit = PAGE_SIZE;
		void fetchApprovals();
	}

	/**
	 * Population size per status — `total` from a `status=X&limit=1` probe.
	 *
	 * ⛔ WHY A PROBE PER TAB RATHER THAN ONE BIG READ, which is what this page
	 * used to do. The tab pills are the page's loudest numbers and the docblock
	 * on `statusCount` records what happens when they lie. Their old source was
	 * "count the rows we happen to have loaded", which was only ever correct
	 * because the fetch loaded everything — the defect and the instrument were
	 * the same line of code. There is no endpoint that returns per-status counts
	 * in one call (see the note in the handoff: that is the one server change
	 * this page wants), so until there is, each pill costs one request that
	 * returns ONE row and a `count(*)`. That is a far smaller read than the
	 * ~4,000 fully-enriched rows it replaces, and every pill answers the same
	 * question as every other pill and as the sidebar badge.
	 *
	 * Empty until the first response, and left empty by any payload without a
	 * numeric `total` — `statusCount` then falls back to the loaded rows.
	 */
	let statusTotals = $state<Partial<Record<ApprovalStatus, number>>>({});

	/**
	 * Population size across ALL statuses — `total` from a probe with no status
	 * filter. Its only consumer is `unsurfacedCount`, which used to be able to
	 * see an untabbed status only if a row of it happened to be loaded. Now the
	 * page fetches ONE status at a time, so a loaded-row test could never see an
	 * untabbed status again; comparing this against the sum of the tab totals
	 * detects it at population scale instead, which is strictly stronger.
	 */
	let allStatusTotal = $state<number | undefined>(undefined);

	/**
	 * Per-`kind` population counts for the CURRENT status tab — `kind_totals`
	 * from the rows request, which carries `?kind_counts=1`.
	 *
	 * ⛔ THE FACETS USED TO COUNT THE LOADED PAGE WHILE THE PILLS ABOVE THEM
	 * COUNTED THE POPULATION. Measured in a live browser 2026-09-15: the page
	 * said "Pending 997 … Showing 200 of 997" and, on the next line,
	 * `All 200 / Improvement 19 / Execution 8 / Other 173` — a set summing to
	 * exactly the page. The true figures are improvement 37, execution 136,
	 * other 824. Two numbers on one screen, five-fold apart, because one read
	 * `total` and the other read `byStatus`. This is the same defect
	 * `statusCount`'s docblock records, one row of chips lower, and it is fixed
	 * the same way: read the number the server counted.
	 *
	 * The aggregate is ONE `GROUP BY` over the SAME `where` as `total`
	 * (backend/src/routes/approvals.ts), so `sum(kind_totals) === total` by
	 * construction — the facets and the pill they sit under cannot disagree.
	 *
	 * ⚠️ Undefined before the first response, on a pre-aggregate server, and on
	 * every existing test's bare `{ items }` mock. `kindCount` then falls back to
	 * the loaded rows exactly as before, which is why this change is INERT
	 * against a payload that cannot support it — the same last-resort reasoning
	 * as `statusTotals`. Printing 0 there would be worse than the page-local
	 * count it replaces.
	 */
	let kindTotals = $state<Record<string, number> | undefined>(undefined);

	/**
	 * Kind-chip count within the CURRENT status tab — "Improvement 0" is the answer.
	 *
	 * Bucketed with `kindGroupOfKind`, the same prefix rule the filter itself
	 * uses, so the three `improvement.*` enum members land in the one Improvement
	 * chip and a member added server-side stays inside its family instead of
	 * vanishing from every count.
	 */
	function kindCount(group: KindGroup): number {
		const totals = kindTotals;
		if (totals) {
			let n = 0;
			for (const [kind, value] of Object.entries(totals)) {
				if (typeof value !== 'number') continue;
				if (group === 'all' || kindGroupOfKind(kind) === group) n += value;
			}
			return n;
		}
		return group === 'all' ? byStatus.length : byStatus.filter(a => kindGroupOf(a) === group).length;
	}

	/**
	 * Per-`deblock_action` population counts for the CURRENT status tab —
	 * `action_totals` from the rows request, which carries `?action_counts=1`.
	 *
	 * ⛔ IT MUST COME FROM THE SERVER, and a client-side recomputation is the
	 * defect, not a simplification. 104 of the 200 loaded rows on the 2026-09-15
	 * drive were QUESTION while ~395 exist; a chip reading "QUESTION 104" over a
	 * 1,294-row tab asserts that 104 is what there is to do. This codebase has
	 * shipped exactly that shape before — `kindTotals`' docblock above records
	 * the five-fold version of it, and `statusCount`'s records the first.
	 *
	 * ⚠️ COUNTED WITHOUT THE ACTION FILTER APPLIED (the server uses
	 * `whereWithoutAction`). So while QUESTION is selected these chips still read
	 * their real sizes and stay navigable, instead of every unselected chip
	 * collapsing to 0 — a facet conditioned on itself is not navigation. The
	 * consequence to know: `sum(actionTotals) !== loadedTotal` under a filter, by
	 * design; the invariant that DOES hold is
	 * `actionTotals[activeAction] === loadedTotal`.
	 *
	 * ⚠️ Undefined before the first response, on a pre-aggregate server, and on
	 * every sibling test's bare `{ items }` mock — `actionCount` then falls back
	 * to the loaded rows, exactly as `kindCount` does, so this change is INERT
	 * rather than zeroing against a payload that cannot support it.
	 *
	 * Assigned on EVERY response, never merged: a retained value would keep the
	 * previous tab's or workspace's counts under the new one's rows.
	 */
	let actionTotals = $state<Record<string, number> | undefined>(undefined);

	/** The chip row, All first. Derived from `ACTION_BUCKETS`, never retyped. */
	const ACTION_FACETS: readonly ActionFacet[] = ['all', ...ACTION_BUCKETS];

	/** Action-chip count within the CURRENT status tab. */
	function actionCount(facet: ActionFacet): number {
		const totals = actionTotals;
		if (totals) {
			let n = 0;
			for (const [bucket, value] of Object.entries(totals)) {
				if (typeof value !== 'number') continue;
				if (facet === 'all' || bucket === facet) n += value;
			}
			return n;
		}
		// Last resort only. `byStatus` is the loaded page, so this is a count of a
		// sample — it is here so a pre-aggregate bundle keeps working, never as an
		// equal alternative to the number above.
		return facet === 'all'
			? byStatus.length
			: byStatus.filter((a) => actionBucketOf(a) === facet).length;
	}

	/**
	 * Switch the action facet. A REFETCH, not a reassignment.
	 *
	 * `pageLimit` resets for the same reason `selectTab` resets it: "load more"
	 * was an act about the subset being left, and carrying it into a subset that
	 * may be a fifth the size would make the first read of the new one needlessly
	 * expensive. The selection is dropped by the existing `$effect` below, which
	 * tracks `activeAction` — a checkbox must not survive into rows it was not
	 * ticked against.
	 */
	function selectAction(facet: ActionFacet): void {
		if (facet === activeAction) return;
		activeAction = facet;
		pageLimit = PAGE_SIZE;
		void fetchApprovals();
	}

	// Format timestamp to readable format
	function formatTimestamp(timestamp: string | Date): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 60) {
			return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
		} else if (diffHours < 24) {
			return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
		} else if (diffDays < 7) {
			return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
		} else {
			return date.toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
			});
		}
	}

	// Fetch the approvals the user can see across all projects
	// (GET /api/approvals/all) — replaces the previous per-project fan-out
	// (projects.list() → N× /api/projects/:id/approvals, refired every 30s).
	//
	// ⭐ THE ROWS ARE NOW ONE BOUNDED PAGE OF ONE STATUS, and the counts come
	// from `total` rather than from the rows. See `PAGE_SIZE` and `statusTotals`
	// for why. `byStatus` still filters client-side and is deliberately NOT
	// removed: it is what keeps the page correct if a response ever carries a
	// row of another status, and it costs nothing when every row already matches.
	// Monotonic id of the most recent `fetchApprovals` call. Scope alone cannot
	// order two requests issued in the SAME workspace (a tab/chip/filter change,
	// a decision refresh and a poll tick all race), so an older response that
	// settles last would repaint rows for a lens the operator has already left.
	// Plain `let`, not `$state`: it is bookkeeping, never rendered.
	let fetchSeq = 0;

	async function fetchApprovals() {
		const seq = ++fetchSeq;
		// The workspace this request is being issued FOR. `stop()` cancels timers,
		// not an in-flight fetch, so without this a switch that lands mid-request
		// lets the PREVIOUS workspace's response settle last and repaint its rows
		// under the new workspace's name — the exact confusion this page's scope
		// handling is meant to end. Every write below is gated on it.
		const scopeAtStart = workspaces.scopeKey;
		const stale = () => workspaces.scopeKey !== scopeAtStart || seq !== fetchSeq;

		// ⛔ D1 — A BACKGROUND REFRESH MUST NOT ENTER THE LOADING STATE. This was
		// set on EVERY tick of the 30s poll, and the list below is rendered
		// behind `{#if isLoading}`, so a poll landing while someone was typing
		// swapped the whole list for a Skeleton: the answer textarea was
		// UNMOUNTED and came back a different node. The draft text survives
		// (drafts are id-keyed and the textarea is value-controlled) but the
		// caret, the selection, the scroll offset and any IME composition are
		// destroyed mid-word — a multi-paragraph answer is unwritable while a
		// poll can land. The skeleton belongs to the GENUINE first/empty load,
		// where there is nothing on screen to preserve.
		//
		// ⭐ The template gate (`isLoading && allApprovals.length === 0`) is a
		// SECOND belt on the same rule, because a refresh issued from a decision
		// path rather than the poll must be equally incapable of unmounting the
		// list.
		if (allApprovals.length === 0) isLoading = true;
		error = null;

		// The status the ROWS are being fetched for. Captured once: `activeTab`
		// is reactive and a tab switch landing mid-flight would otherwise file
		// this response's `total` under the wrong pill.
		const statusAtStart = activeTab;
		// Same capture, same reason, for the action facet: a chip click landing
		// mid-flight must not file this response's rows and `total` under the
		// facet the operator has since moved to.
		const actionAtStart = activeAction;
		// Same capture for the project filter.
		const projectAtStart = projectFilter || undefined;

		try {
			// ⭐ ONE page request + one count probe per OTHER tab + one unfiltered
			// probe. `Promise.all`, not a sequence: the probes are independent and
			// a serial chain would put five round-trips in front of the first row.
			// A probe that REJECTS must not fail the page — the rows are the
			// product, the pills are a lens on it — so each probe is caught
			// individually and leaves its pill on the fallback path.
			//
			// ⛔ WHEN AN ACTION FILTER IS ACTIVE THE ACTIVE TAB GETS A PROBE TOO,
			// and skipping it would be the `statusCount` defect in a new costume.
			// The rows request now carries `?deblock_action=`, so ITS `total` is the
			// size of the FILTERED subset (395, not 1,294). Filing that under the
			// Pending pill would make the page's loudest number read "Pending 395"
			// — a count of the lens, printed where the operator reads "where do
			// approvals LIVE". `statusCount`'s docblock records the live drive where
			// a filter drove every pill to 0 and the page declared an occupied
			// workspace empty; this is the same mistake, one filter later. The pill
			// keeps counting the population; `loadedTotal` (below) carries the
			// subset's size to the truncation note, which is where it belongs.
			const probeStatuses = tabs
				.map((t) => t.value)
				.filter((s) => s !== statusAtStart || actionAtStart !== 'all');
			const [response, probes, allProbe] = await Promise.all([
				// ⭐ `kindCounts` ONLY here. This is the one request that renders
				// the facet row, and the flag costs the server a second scan of the
				// population (see `parseKindCountsFlag`). Putting it on the five
				// `limit=1` probes below would sextuple that cost on a 30s poll to
				// serve a number none of them reads — which is precisely why the
				// backend made the aggregate opt-in rather than always-on.
				apiClient.approvals.listAll({
					status: statusAtStart,
					limit: pageLimit,
					kindCounts: true,
					// Same one-request rule as `kindCounts`, and for the same cost
					// reason — the aggregate is a second scan of the population and
					// only this request renders chips.
					actionCounts: true,
					// `undefined` for 'all' so the parameter is absent rather than sent
					// as a literal "all", which the server would 400 as an unknown
					// bucket — deliberately, since a filter that quietly declines to
					// filter is the defect `parseDeblockActionFilter` exists to refuse.
					deblockAction: actionAtStart === 'all' ? undefined : actionAtStart,
					...(projectAtStart ? { projectId: projectAtStart } : {})
				}),
				Promise.all(
					probeStatuses.map(async (s) => {
						try {
							const r = await apiClient.approvals.listAll({
								status: s,
								limit: 1,
								...(projectAtStart ? { projectId: projectAtStart } : {})
							});
							return [s, typeof r.total === 'number' ? r.total : undefined] as const;
						} catch {
							return [s, undefined] as const;
						}
					}),
				),
				apiClient.approvals
					.listAll({ limit: 1, ...(projectAtStart ? { projectId: projectAtStart } : {}) })
					.then((r) => (typeof r.total === 'number' ? r.total : undefined))
					.catch(() => undefined),
			]);
			if (stale()) return;
			// Same staleness gate as the rows: a scope from the PREVIOUS workspace
			// landing late would relabel this one.
			listScope = response.scope;
			// Same staleness gate again. Read defensively: a payload without a
			// numeric `total` must leave this undefined, not coerce to 0 — a 0
			// would render as "every row is loaded" on exactly the stale bundle
			// that cannot promise it.
			loadedTotal = typeof response.total === 'number' ? response.total : undefined;
			// ⚠️ REPLACED WHOLE, never merged into the previous object. A merge
			// would keep a count from the workspace the operator just left — the
			// stale-scope bug this function's `scopeAtStart` gate exists to stop,
			// re-entered through a field the gate does not cover.
			const nextTotals: Partial<Record<ApprovalStatus, number>> = {};
			// ⛔ ONLY when no action filter is active. Under one, `loadedTotal` is
			// the size of the FILTERED subset and the active tab has its own
			// unfiltered probe above; writing it here would put the lens's count in
			// the pill — see the probe-list note. The explicit condition is
			// deliberate rather than relying on the probe loop below to overwrite
			// it: an ordering accident is not a rule.
			if (loadedTotal !== undefined && actionAtStart === 'all') {
				nextTotals[statusAtStart] = loadedTotal;
			}
			for (const [s, n] of probes) if (n !== undefined) nextTotals[s] = n;
			statusTotals = nextTotals;
			// ⚠️ ASSIGNED ON EVERY RESPONSE, including the ones that carry no
			// aggregate — never merged, never left standing. A retained value would
			// keep the previous STATUS TAB's or the previous WORKSPACE's facet
			// counts on screen under the new one's rows, which is the stale-scope
			// bug `scopeAtStart` exists to stop, re-entered through a field the
			// gate does not cover. Same reasoning as `statusTotals` above.
			kindTotals = response.kind_totals;
			// Same rule, same reason: assigned on every response, never merged, so a
			// previous tab's or workspace's chip counts cannot stand under these rows.
			actionTotals = response.action_totals;
			allStatusTotal = allProbe;
			allApprovals = (response.items ?? [])
				// Belt for the project filter: a server that does not (yet) honour
				// `?project_id=` must not put another project's rows under it.
				.filter((approval) => !projectAtStart || approval.project_id === projectAtStart)
				// Preserve a null projectName (workspace-scoped / null-project rows,
				// e.g. worker-initiated KAG ingest) — the badge renders it as the
				// workspace name. Coercing to '' here would blank the badge.
				.map((approval) => ({ ...approval, projectName: approval.projectName ?? null }))
				.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
			// These rows were READ. Whatever the empty state says from here on, it
			// is saying it about an answer the server actually gave.
			queueState = 'ready';
		} catch (err) {
			if (stale()) return;
			console.error('Failed to fetch approvals:', err);
			error = err;
			// ⛔ THE RULE, AND IT IS NOT "ONCE READY ALWAYS READY". Rows that were
			// genuinely read STAY on screen — they are real, and the ErrorState
			// above says the refresh failed. What may never happen is an ABSENCE
			// being claimed on the strength of a failed read. So the state turns
			// 'unreadable' whenever this tab has no rows to show, which covers
			// three cases with one condition: the first load, a poll failing over
			// an empty tab, and — the one a `queueState !== 'ready'` guard would
			// have missed — a TAB SWITCH whose read fails, where the previous tab's
			// rows are still in `allApprovals` but none of them belong to the tab
			// now on screen, so the page would have printed that tab's empty state.
			if (byStatus.length === 0) queueState = 'unreadable';
		} finally {
			// Only the request that is still current may clear the skeleton — a
			// stale one settling would uncover an empty list while the live fetch
			// is still running.
			if (!stale()) isLoading = false;
		}
	}

	/** Best-effort human text for a failed decision — ApiError carries `message`. */
	function messageOf(err: unknown): string {
		if (err instanceof Error && err.message) return err.message;
		if (err && typeof err === 'object' && 'message' in err) {
			const m = (err as { message?: unknown }).message;
			if (typeof m === 'string' && m.length > 0) return m;
		}
		try {
			return String(err);
		} catch {
			return 'Unknown error';
		}
	}

	/**
	 * Approve an approval request, optionally CARRYING THE ANSWER.
	 *
	 * ⛔ The `comment` parameter is the whole defect this function used to have.
	 * `approvals.approve(id, data?)` has always put `{ status: 'approved',
	 * ...data }` and `UpdateApprovalSchema` has always accepted `comment`, but
	 * this call site passed no body at all — so the approvals LIST could not send
	 * an answer even in principle, only the row page could. For a QUESTION row
	 * the answer IS the decision: the backend refuses an approve whose
	 * `(comment || reason).trim()` is empty (backend/src/routes/approvals.ts,
	 * "This approval is a QUESTION…"), with NO override, and the n8n callback
	 * releases the card only on non-empty answer text.
	 *
	 * ⭐ The empty case sends ONE argument, not `(id, undefined)`. That is not
	 * style: an explicit trailing `undefined` is an arity mismatch. Same bytes
	 * on the wire either way — `{ ...undefined }` and no second argument both
	 * produce `{ status: 'approved' }` — so the branch costs nothing and keeps
	 * every existing no-comment call site behaving exactly as before.
	 *
	 * ⛔ RETURNS ITS OWN OUTCOME — `true` iff the DECISION was recorded. Callers
	 * used to read the shared `error` afterwards to decide whether the approve
	 * worked, and `fetchApprovals()` (awaited below) sets that same `error` in
	 * its OWN catch. So a decision the server accepted, followed by a refresh
	 * that failed, read as a FAILED DECISION: the row stayed on screen, the
	 * answer box stayed open with the draft in it, and the operator resubmitted
	 * — into a 422 they cannot interpret, on an approval already spent. Shared
	 * mutable state cannot answer "did MY call succeed"; a return value can.
	 */
	async function handleApprove(approvalId: string, comment?: string): Promise<boolean> {
		markActing([approvalId]);
		error = null;

		// Trim here, once, and send the TRIMMED text: the server trims before
		// measuring emptiness and the n8n consumer trims before measuring
		// `answerText.length > 0`, so a whitespace-only answer is empty at BOTH
		// ends. Sending it untrimmed would pass this page's own check and be
		// refused (or, worse, accepted and strand the card) downstream.
		const answer = comment?.trim() ?? '';

		try {
			// ⭐ The DECISION, and only the decision, is what this catch reports.
			let res: unknown;
			try {
				if (answer.length > 0) {
					res = await apiClient.approvals.approve(approvalId, { comment: answer });
				} else {
					res = await apiClient.approvals.approve(approvalId);
				}
			} catch (err) {
				console.error('Failed to approve request:', err);
				error = err;
				return false;
			}

			// ⛔ THE RESPONSE BODY IS READ, NOT DISCARDED. A 200 says the decision
			// was recorded; `callback.outcome` says whether the card moved, and
			// they are different facts. This page reported the first as though it
			// were the second — the row simply vanished from the queue on the next
			// refresh, which reads as "done" for a card still sitting in BLOCKED.
			// ⭐ RECORDED BEFORE THE REFRESH, AND FOR EVERY OUTCOME. `fetchApprovals`
			// below removes this row from the pending page, so the index and the
			// description that let the receipt render where the row was are only
			// available on this side of the call. `delivered` no longer decides
			// whether anything is shown — only which tone and which sentence.
			noteDecision(approvalId, decisionNotice('Your decision was recorded.', res));

			// ⛔ PAST THIS LINE THE DECISION IS SPENT AND CANNOT BE RETAKEN — the
			// row is decided-once per approver. Whatever the refresh does, it can
			// never make this a failed decision, and must never be presented as
			// one: telling the operator "that failed" here is telling them to
			// resubmit something the server will 422.
			await fetchApprovals();
			if (error) {
				// The refresh genuinely failed, so the list on screen IS stale and
				// saying nothing would leave the answered row sitting there looking
				// undecided — the same invitation to resubmit, by omission. Say what
				// happened in the right order: decision recorded, list not refreshed.
				error = new Error(
					`Your decision was recorded. The approvals list could not be refreshed afterwards (${messageOf(error)}), so what is shown below may be out of date — reload the page for the current queue.`
				);
			}
			return true;
		} finally {
			clearActing([approvalId]);
		}
	}

	// ---- Answering a QUESTION ----------------------------------------------
	//
	// Per-row, keyed by approval id. A single `openAnswerId` slot would be the
	// same mistake `actionLoading` already had to unlearn (:152): one slot means
	// one row, and a queue where 19 of 29 rows are QUESTIONs is a queue where the
	// operator wants to draft more than one. Plain `$state` records — Svelte 5
	// proxies them deeply, so `answerOpen[id] = true` is reactive without the
	// reassign-the-whole-Set dance `selectedIds` needs.
	let answerOpen = $state<Record<string, boolean>>({});
	let answerDraft = $state<Record<string, string>>({});

	const answerTextOf = (id: string): string => answerDraft[id] ?? '';

	function toggleAnswerBox(id: string): void {
		answerOpen[id] = !answerOpen[id];
	}

	/**
	 * Answer a QUESTION and approve it, in the one request the server treats as
	 * one act. Refuses locally on an empty answer rather than spending the
	 * approval on a 422 — the row is decided-once per approver, so a refused
	 * attempt is cheap but a WRONG accepted one is terminal.
	 *
	 * The draft is cleared only when the DECISION was recorded. On a failed
	 * decision the typed text stays exactly where the operator left it: wiping
	 * the box on the one path where they need to retry would destroy the answer
	 * they just wrote.
	 */
	async function submitAnswer(approvalId: string): Promise<void> {
		// ⛔ FIRST LINE, AND IMPERATIVE — `disabled=` is not a guard. It is
		// applied on the next Svelte flush, so two clicks landing in the SAME
		// tick both reach this function; measured, that sent TWO approves. The
		// server's per-approver limiter is check-then-act with no lock, so it
		// cannot bound a duplicate — it can only 422 the loser, on a row that
		// was already decided. The client is the only thing that can prevent it.
		// Both sibling surfaces guard the same way
		// (`approvals/[id]/+page.svelte:118`,
		// `projects/[id]/approve/[approvalId]/+page.svelte:111`).
		if (isActing(approvalId) || bulkPending) return;

		// The refusal text must describe THIS row: an unrouted row is not a QUESTION
		// and never reaches the `approval_answer_missing` branch the other wording names.
		const verdictRow = allApprovals.find((a) => a.id === approvalId);
		const verdict = validateAnswer(
			answerTextOf(approvalId),
			verdictRow ? questionPresentation(verdictRow).state : undefined,
			verdictRow ? answerDemandOf(verdictRow) : undefined,
		);
		if (!verdict.ok) return;

		// ⭐ Branch on what THIS call reported, never on the shared `error`.
		// `handleApprove` refreshes the list after a successful decision and
		// `fetchApprovals` sets `error` in its own catch, so reading `error`
		// here reported an ACCEPTED decision as a failure whenever the refresh
		// behind it failed — box left open, draft left in it, resubmit invited.
		const recorded = await handleApprove(approvalId, answerTextOf(approvalId));
		if (!recorded) return;

		answerDraft[approvalId] = '';
		answerOpen[approvalId] = false;
	}

	/**
	 * Decide every selected approval through the EXISTING per-row endpoint
	 * (PUT /api/approvals/:id, N calls). No bulk route: that handler re-checks
	 * `status !== 'pending'` per call (422 rather than a double decision) and
	 * owns roster/consensus/n8n-callback logic a second endpoint would have to
	 * duplicate.
	 *
	 * ⛔ SEQUENTIAL AND SELF-PACED, not `Promise.all`. See BULK_INTERVAL_MS: the
	 * server's per-approver limiter is check-then-act with no lock, so it cannot
	 * bound a concurrent fan-out — it can only 422 the losers after the fact.
	 * Fanning 1206 rows out at once produced 152 decisions and 1054 rejections.
	 * The client is the only place the interval can actually be enforced.
	 *
	 * ⭐ The delay goes AFTER the awaited call RETURNS, never on a fixed-rate
	 * schedule. The server compares its own `Date.now()` to the stored
	 * `decided_at` — two clocks — so a fixed-rate sender lets one slow response
	 * compress the NEXT gap below the floor and 422 a row the client had paced
	 * correctly. Measuring the gap from completion can only ever overshoot.
	 *
	 * Every call is individually caught, so one rejection cannot cancel the rest
	 * or hide them. The outcome is reported PER ROW; rows that failed stay
	 * selected so the operator can retry exactly those, and so do the rows the
	 * loop never reached after a cancel.
	 */
	async function decideSelected(decision: 'approved' | 'rejected', reason?: string) {
		// APPROVE excludes the QUESTION rows (see `questionSelected`); REJECT does
		// not — a rejection carries the operator's reason, which IS an answer.
		const targets: typeof selectedApprovals =
			decision === 'approved' ? approvableSelected : selectedApprovals;
		// Skipped = every selected row the approve path will not touch, from BOTH carve-outs,
		// de-duplicated: a row that is a broken gate AND a question must be reported once,
		// not twice. REJECT skips nothing — a rejection carries the operator's reason and is
		// never blocked by either rule.
		const skipped: typeof selectedApprovals =
			decision === 'approved'
				? selectedApprovals.filter(
						(a) => answerRequired(a, 'approved') || brokenGateTermsOf(a).length > 0
					)
				: [];
		if ((targets.length === 0 && skipped.length === 0) || bulkPending) return;

		bulkPending = true;
		bulkVerb = decision;
		bulkResults = [];
		bulkCancelled = false;
		bulkSkipped = skipped.map((a) => ({ id: a.id, description: a.description }));
		bulkDone = 0;
		bulkTotal = targets.length;
		bulkStartedAt = Date.now();
		error = null;

		const abort = new AbortController();
		bulkAbort = abort;
		// A 30s poll landing mid-run would replace `allApprovals` under the loop
		// and repaint rows this run is still deciding. It is restarted (and so
		// re-fetches) in the finally below.
		pollHandle.stop();

		const ids = targets.map((a) => a.id);
		markActing(ids);

		const acc: { id: string; description: string; ok: boolean; message: string }[] = [];

		try {
			for (let index = 0; index < targets.length; index += 1) {
				const approval = targets[index];
				if (abort.signal.aborted) {
					bulkCancelled = true;
					break;
				}

				// ONE bounded retry, and ONLY on the limiter's own signature. Bounded
				// because an unbounded retry against a limiter is just the fan-out
				// again, spread thinner.
				let retried = false;
				for (;;) {
					try {
						const res =
							decision === 'approved'
								? await apiClient.approvals.approve(approval.id)
								: await apiClient.approvals.reject(approval.id, { reason: reason ?? '' });
						// `ok: true` — the DECISION landed, and this row must not be
						// re-selected for a retry. `notice` carries what happened after
						// it; a run of 200 recorded decisions whose callbacks all failed
						// used to render as a plain green "Approved 200 approvals."
						const notice = decisionNotice('', res);
						acc.push({
							id: approval.id,
							description: approval.description,
							ok: true,
							message: '',
							...(notice.delivered ? {} : { notice }),
						});
						break;
					} catch (err) {
						const message = messageOf(err);
						if (LIMITER_SIGNATURE.test(message) && !retried) {
							retried = true;
							// Double the interval rather than repeating it: the row 422'd at
							// one interval, so retrying at the same spacing asks the same
							// question.
							await sleepOrAbort(BULK_INTERVAL_MS * 2, abort.signal);
							if (abort.signal.aborted) {
								bulkCancelled = true;
								break;
							}
							continue;
						}
						console.error(`Failed to ${decision.slice(0, -1)} approval ${approval.id}:`, err);
						acc.push({
							id: approval.id,
							description: approval.description,
							ok: false,
							message
						});
						break;
					}
				}

				if (bulkCancelled) break;
				bulkDone = acc.length;
				if (index < targets.length - 1) await sleepOrAbort(BULK_INTERVAL_MS, abort.signal);
			}
		} finally {
			bulkResults = acc;
			// The retry set, and nothing else that landed. Three populations stay
			// selected: the rows that FAILED, the QUESTION rows this run refused to
			// approve, and — after a cancel — every row the loop never reached.
			// Dropping that last group would silently discard the operator's own
			// selection of thousands of rows the moment they clicked Cancel.
			selectedIds = new Set([
				...acc.filter((r) => !r.ok).map((r) => r.id),
				...skipped.map((s) => s.id),
				...targets.slice(acc.length).map((a) => a.id)
			]);
			clearActing(ids);
			bulkPending = false;
			bulkAbort = null;
			// Restarting the poll re-fetches immediately (initialDelayMs: 0), which
			// is the post-decide refresh.
			pollHandle.start();
		}
	}

	// Open reject modal for ONE row
	function openRejectModal(approvalId: string) {
		rejectingApprovalId = approvalId;
		rejectingSelection = false;
		rejectReason = '';
		showRejectModal = true;
	}

	// Open the SAME modal for the whole selection — one reason, applied to all.
	function openBulkRejectModal() {
		rejectingApprovalId = null;
		rejectingSelection = true;
		rejectReason = '';
		showRejectModal = true;
	}

	// Close reject modal
	function closeRejectModal() {
		showRejectModal = false;
		rejectingApprovalId = null;
		rejectingSelection = false;
		rejectReason = '';
	}

	// Reject an approval request with reason
	async function handleReject() {
		if (!rejectReason.trim()) {
			error = new Error('Please provide a reason for rejection');
			return;
		}

		if (rejectingSelection) {
			const reason = rejectReason;
			closeRejectModal();
			await decideSelected('rejected', reason);
			return;
		}

		if (!rejectingApprovalId) return;
		const approvalId = rejectingApprovalId;

		markActing([approvalId]);
		error = null;

		try {
			let res: unknown;
			try {
				res = await apiClient.approvals.reject(approvalId, { reason: rejectReason });
			} catch (err) {
				console.error('Failed to reject request:', err);
				error = err;
				return;
			}
			closeRejectModal();
			// Same split as the approve path: the decision is recorded, and whether
			// the card moved is a separate fact the response reports. A rejection
			// whose callback failed leaves the card blocked exactly as an approval
			// does — it is the callback that moves it, not the verdict.
			noteDecision(approvalId, decisionNotice('Your rejection was recorded.', res));
			// ⛔ PAST THIS LINE THE REJECTION IS SPENT — same rule as handleApprove.
			// `fetchApprovals` reports its own failure through `error`, and a bare
			// "failed to load" under a just-recorded rejection reads as "the
			// rejection failed" and invites a resubmit the server will 422.
			await fetchApprovals();
			if (error) {
				error = new Error(
					`Your rejection was recorded. The approvals list could not be refreshed afterwards (${messageOf(error)}), so what is shown below may be out of date — reload the page for the current queue.`
				);
			}
		} finally {
			clearActing([approvalId]);
		}
	}

	// Initialize on mount — usePoll fires fetchApprovals immediately on
	// start() (initialDelayMs: 0), so no separate fetchApprovals() call is
	// needed; that would double-fetch.
	onMount(() => {
		pollHandle.start();
		// The project filter's options. The store is shared with the header
		// switcher, so it is usually already loaded.
		if (!activeProject.loaded) void activeProject.load();
	});

	// Re-fetch when the operator switches workspace (SYS → EXEC → *_IMPROVEMENT).
	//
	// This page holds its rows in component-local `$state` filled by a poll
	// started in onMount, and `switchTenant()` re-keys only kanban / activity /
	// navCounts — its `invalidateAll()` is a no-op here because there is no
	// `load()`. So a scope switch left the SYS rows on screen and the page kept
	// answering for a workspace the switcher was no longer showing, until the
	// 30s tick happened to land (indefinitely while the tab was hidden, since
	// the poll pauses then). Keyed on `scopeKey`, not `activeId`: `activeId` is
	// undefined until the store hydrates, so it reports a spurious
	// `undefined -> id` change on every cold load and would fire a second,
	// identical request for a scope that never changed.
	let renderedScope = $state<string | undefined>(undefined);
	let scopeInitialised = false;
	$effect(() => {
		const scope = workspaces.scopeKey;
		if (!scopeInitialised) {
			scopeInitialised = true;
			renderedScope = scope;
			return;
		}
		if (scope === renderedScope) return;
		renderedScope = scope;
		// Drop the previous workspace's rows BEFORE the new fetch lands, so the
		// page never shows another scope's approvals under this scope's name.
		allApprovals = [];
		// …and its SCOPE with them. A stale 'all' surviving a switch would print
		// the cross-workspace header over a freshly scoped, single-workspace list.
		listScope = undefined;
		// …and its TOTAL. `allApprovals` is now empty, so a surviving total would
		// momentarily claim every row of the previous workspace is hidden here.
		loadedTotal = undefined;
		// …and every PER-STATUS total with it, for exactly the same reason one
		// layer down: the tab pills are the loudest numbers on the page and a
		// survivor would print the previous workspace's population over this
		// one's rows. `pageLimit` goes back to one page because "load more" was
		// an act about a queue that is no longer on screen.
		statusTotals = {};
		allStatusTotal = undefined;
		pageLimit = PAGE_SIZE;
		// …and every DECISION RECEIPT. A receipt names a row by id and describes
		// what happened to its card; the ids belong to the workspace being left,
		// so a survivor would pin an outcome card into a queue it is not about.
		receipts = [];
		// …and every OPEN ANSWER BOX with its draft. These are keyed by approval
		// id and the previous workspace's ids are gone from the list, so a
		// surviving entry is invisible state that (a) silently re-opens a box
		// with old text in it if the operator switches back, and (b) never
		// shrinks — both records grow for the lifetime of the page. The drafts
		// belong to rows this scope does not contain; dropping them with the
		// rows is the same rule the lines above follow.
		answerOpen = {};
		answerDraft = {};
		// …and the PROJECT FILTER: project ids are workspace-scoped, so the
		// previous workspace's project would filter this one down to nothing.
		if (untrack(() => projectFilter)) {
			projectFilter = '';
			writeProjectToUrl('');
		}
		error = null;
		pollHandle.stop();
		pollHandle.start();
	});

	// Clean up on destroy
	onDestroy(() => {
		pollHandle.stop();
	});

	// Roster chips used to render the bare approver UUID, which told a reader
	// nothing about WHICH human is being waited on. The API may enrich each
	// required_approvers row with `name`/`email` — but the field can legitimately
	// be null, and a response minted before that change omits it entirely — so
	// read it structurally (not off the declared RequiredApprover type) and fall
	// back to the id. Precedence: name, then email, then the id.
	//
	// ⛔ THIS USED TO BE `a.name ?? a.email ?? a.user_id.slice(0, 8)` — fr#1192's
	// class, in the one place it does the most damage. `??` skips `null`/
	// `undefined` only, so an enriched row carrying `name: ''` (or `'   '`) WON
	// the chain: the chip and the "Awaiting sign-off from …" note both rendered
	// EMPTY, i.e. a gate that states it is waiting on nobody at all. Routed
	// through the shared trim-then-test helper, nested to keep precedence.
	//
	// The `slice(0, 8)` is gone on purpose, and not merely for consistency: the
	// documented harm of this fallback (see `approverUnresolvable` below) is that
	// `3f2a1c9d` READS AS A PERSON who exists and is merely slow. A full uuid
	// cannot be mistaken for a username, so the untruncated id is the honest
	// fallback here. The chip also keeps `title={approver.user_id}`, so the two
	// now agree instead of showing a prefix and a whole id for one approver.
	type ApproverLike = { user_id: string; name?: string | null; email?: string | null };

	function approverLabel(a: ApproverLike): string {
		return displayName(a.name, displayName(a.email, a.user_id));
	}

	// Who the gate is actually waiting on, as a short human list for the
	// read-only note. Prefers the approvers who have NOT yet signed off; falls
	// back to the full roster when every row is already marked approved (the
	// approval is then pending for some other reason and the whole roster is
	// the honest answer). Capped at two names so the note stays one line.
	function outstandingApprovers(approval: Approval): string {
		const all = approval.required_approvers ?? [];
		const outstanding = all.filter((a) => !a.approved);
		const names = (outstanding.length > 0 ? outstanding : all).map(approverLabel);
		if (names.length === 0) return '';
		if (names.length <= 2) return names.join(' and ');
		return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
	}

	/**
	 * The roster names ONE approver and that approver cannot be resolved to a
	 * person — no `name`, no `email`, only a uuid.
	 *
	 * ⚠️ This is not a cosmetic gap in a chip. Measured on the pending QUESTION
	 * cohort: every row names a uuid that 404s in Keycloak. `approverLabel()`
	 * falls back to the raw `user_id`, so the read-only note reads "Awaiting
	 * sign-off from 3f2a1c9d-…" — a string nobody can act on. (It used to fall
	 * back to `user_id.slice(0, 8)`, which was worse: an 8-character prefix looks
	 * like a person who exists and is merely slow.) Nobody is coming. The row is decidable only by someone
	 * holding the required ROLE (`canActOnApproval` matches `user_id` OR `role`),
	 * and saying so is the difference between waiting and acting.
	 *
	 * Scoped to a SINGLE-approver roster on purpose. On a multi-approver row a
	 * resolvable colleague may still be able to sign off, so "no named person can
	 * act" would be false; a stronger claim on a weaker fact is how a note like
	 * this stops being trusted.
	 */
	function approverUnresolvable(approval: Approval): boolean {
		const required = (approval.required_approvers ?? []) as ApproverLike[];
		if (required.length !== 1) return false;
		const only = required[0];
		// ⚠️ BLANK-AWARE ON PURPOSE, through the SAME helper the label uses. With
		// `(only.name ?? null) === null` this predicate called a row with
		// `name: ''` resolvable while `approverLabel` fell through to the id — so
		// the note said "Awaiting sign-off from <uuid>" and then SUPPRESSED the
		// "cannot be resolved" disclosure that uuid is the whole evidence for.
		// Label and predicate must answer "is there a usable name here?" the same
		// way; sharing the helper is what makes that structural rather than
		// remembered.
		return displayName(only.name, '') === '' && displayName(only.email, '') === '';
	}

	/** The role that CAN still decide an unresolvable-approver row, if one is named. */
	function requiredRoleOf(approval: Approval): string | null {
		const required = (approval.required_approvers ?? []) as (ApproverLike & { role?: string | null })[];
		const role = required.find((r) => !!r.role)?.role;
		return typeof role === 'string' && role.length > 0 ? role : null;
	}

	// Tab configuration
	const tabs: { label: string; value: ApprovalStatus; color: string }[] = [
		{ label: 'Pending', value: 'pending', color: 'yellow' },
		{ label: 'Approved', value: 'approved', color: 'green' },
		{ label: 'Rejected', value: 'rejected', color: 'red' },
		// Timed out with no decision. Its own tab, not folded into Rejected:
		// nobody decided these, and the correct operator action is to re-raise
		// the gate, not to read them as a "no". Without this tab an expired
		// approval matches no filter and disappears from the page.
		{ label: 'Expired', value: 'expired', color: 'red' },
		// ⛔ THE SAME DEFECT AS EXPIRED, ONE STATUS LATER, AND IT WAS LIVE FOR 892
		// ROWS. Migration 110 added `voided` after this list was written and
		// nothing brought the list forward, so a voided row matched NO tab:
		// `byStatus` (:339) compares `approval.status === activeTab` and no tab
		// equalled 'voided', so every voided row was fetched, roster-enriched and
		// Keycloak-identity-resolved on every 30s poll and then silently dropped at
		// render. Measured against prod 2026-09-13 (worker4, db `fr`): 3,992 rows,
		// of which the four tabs above accounted for 3,100 — the missing 892 are
		// exactly the voided ones, and `hiddenCount` read 0 the whole time because
		// the rows WERE loaded, so the page positively asserted nothing was hidden.
		//
		// ⭐ NEUTRAL, NOT RED. A void is the WITHDRAWAL of an unanswerable ask, not
		// a decision — it writes no `approval_decisions` row precisely so it can
		// never be counted as someone having answered (migration 110). Giving it the
		// danger palette the Rejected and Expired tabs share would restate, in the
		// one signal an operator reads at a glance, exactly the conflation the
		// separate status exists to prevent.
		{ label: 'Voided', value: 'voided', color: 'neutral' }
	];

	/**
	 * Loaded rows that NO tab above will ever show.
	 *
	 * ⛔ THIS EXISTS BECAUSE THE SAME BUG HAS NOW HAPPENED TWICE — `expired` (#779)
	 * and `voided` (migration 110, 892 rows). Both times a status was added on the
	 * server, both times this list was not extended, and both times the page's own
	 * numbers covered it up: `statusCount` only ever counts a status a tab NAMES,
	 * and `hiddenCount` (:522) measures `total − loaded`, which is 0 when the rows
	 * were loaded and then dropped at render. So the page summed 3,100 of 3,992
	 * rows across its tabs while stating that nothing was hidden.
	 *
	 * ⚠️ NOT theoretical for the next one: `approvals.status` has no CHECK and no
	 * enum (backend schema.ts), and `parseApprovalStatusFilter`
	 * (backend/src/routes/approvals.ts) already admits `executing` / `done` /
	 * `failed` from the E-5 action bus — legal, unpopulated on prod today, and
	 * untabbed here. When the bus writes its first one this counts it out loud
	 * instead of swallowing it.
	 *
	 * Derived from `tabs` itself, not from a second hand-written status list: a
	 * second list is a third place to forget.
	 *
	 * ⭐ IT NOW MEASURES THE POPULATION, BECAUSE THE OLD TEST COULD NO LONGER
	 * FIRE. It counted LOADED rows whose status matched no tab — which worked
	 * only while the fetch pulled every status. The fetch is now one status at
	 * a time, and that status is always a tab's, so a loaded-row test would
	 * report 0 forever: a detector that cannot fire, left in place, reads as a
	 * clean bill of health. `allStatusTotal` (an unfiltered `total`) minus the
	 * sum of the per-tab totals is the same question asked of the whole
	 * population, and it would have caught the 892 voided rows on the first
	 * poll rather than on the first render.
	 *
	 * Falls back to the loaded-row test when the totals are not available (a
	 * pre-#855 payload, or a probe that failed) — weaker, and still better than
	 * silence.
	 */
	const unsurfacedCount = $derived.by(() => {
		const tabTotals = tabs.map((t) => statusTotals[t.value]);
		if (allStatusTotal !== undefined && tabTotals.every((n) => typeof n === 'number')) {
			const summed = tabTotals.reduce((acc: number, n) => acc + (n as number), 0);
			return Math.max(0, allStatusTotal - summed);
		}
		return allApprovals.filter((a) => !tabs.some((t) => t.value === a.status)).length;
	});

	/**
	 * The void audit trail for a row — `voided_at` / `voided_reason` / `voided_by`,
	 * added by backend migration 110 and returned verbatim by
	 * `GET /api/approvals/all` (the handler selects the whole `approvals` row and
	 * `toApprovalResponse` spreads it). All three are populated on all 892 voided
	 * rows on prod (measured 2026-09-13), so the reason is real text, not a NULL
	 * column rendered as a hopeful label.
	 *
	 * ⚠️ Cast, not a typed field: `Approval` in `$lib/types/api.ts` declares the
	 * status but not these three columns, and widening that shared type is a change
	 * to a file this page does not own. The read is defensive on every field so a
	 * payload without them renders nothing rather than "undefined".
	 */
	function voidedNote(
		approval: Approval
	): { reason: string | null; by: string | null; at: string | Date | null } | null {
		if (approval.status !== 'voided') return null;
		const row = approval as Approval & {
			voided_at?: string | Date | null;
			voided_reason?: string | null;
			voided_by?: string | null;
		};
		const reason = typeof row.voided_reason === 'string' && row.voided_reason.trim().length > 0
			? row.voided_reason.trim()
			: null;
		const by = row.voided_by_name
			? row.voided_by_name
			: typeof row.voided_by === 'string' && row.voided_by.trim().length > 0
				? row.voided_by.trim()
				: null;
		return { reason, by, at: row.voided_at ?? null };
	}
</script>

<div class="space-y-6">
	<div>
		<h1 class="text-3xl font-bold text-[var(--color-text)] dark:text-[var(--color-text)]">Approvals</h1>
		<p class="mt-2 text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
			{#if crossWorkspace}
				Review and approve workflow requests across
				<strong class="font-medium text-[var(--color-text)]" data-testid="approvals-scope-name"
					>every workspace</strong
				> — you are a super-admin in your home workspace, so this queue is not limited to
				<strong class="font-medium text-[var(--color-text)]">{workspaces.active?.name}</strong>.
				Each row is badged with the workspace it belongs to.
			{:else}
				Review and approve workflow requests across all projects in
				<strong class="font-medium text-[var(--color-text)]" data-testid="approvals-scope-name"
					>{workspaces.active?.name ?? 'this workspace'}</strong
				>.
			{/if}
		</p>
	</div>

	<!-- P1-TEAM-b: approvals/questions go to every member — say so when this one cannot be pushed to. -->
	<NoPushChannelBanner />

	<!-- Project filter (UI review 2026-10-07). -->
	<div class="flex flex-wrap items-center gap-2">
		<label for="approvals-project-filter" class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Project</label>
		<select
			id="approvals-project-filter"
			data-testid="approvals-project-filter"
			class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)]"
			value={projectFilter}
			disabled={bulkPending}
			onchange={(e) => selectProject((e.currentTarget as HTMLSelectElement).value)}
		>
			<option value="">All projects</option>
			{#each projectOptions as p (p.id)}
				<option value={p.id}>{displayName(p.name, p.id)}</option>
			{/each}
			{#if projectFilter && !projectOptions.some((p) => p.id === projectFilter)}
				<!-- A `?project=` the list has not (or cannot) load — keep it selectable
				     rather than silently showing "All projects" over filtered rows. -->
				<option value={projectFilter}>{projectFilter}</option>
			{/if}
		</select>
	</div>

	<!-- Error Display -->
	{#if error}
		<ErrorState error={error} title="Error" onRetry={() => { error = null; void fetchApprovals(); }} />
	{/if}

	<!-- ⛔ THE DECISION NOTICE USED TO LIVE HERE, AND THAT WAS DEFECT F4. It is
	     now rendered against the row that produced it — inside the row while the
	     row survives the decision, and as a receipt card standing in the row's
	     place once the refresh removes it. See `displayRows` and `noteDecision`.
	     It is still deliberately NOT an ErrorState: this is not a failed
	     decision and must never offer a retry, because the row is decided-once
	     per approver and a second attempt earns a 422. -->

	<!-- Tabs -->
	<div class="border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
		<nav class="-mb-px flex space-x-8">
			{#each tabs as tab}
				<!-- Locked during a bulk run: switching the tab re-populates the list
				     and would strand a selection the loop is still working through. -->
				<button
					onclick={() => selectTab(tab.value)}
					disabled={bulkPending}
					class="
						{activeTab === tab.value
							? 'border-[var(--color-accent)] text-[var(--color-accent)]'
							: 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-border-strong)] dark:text-[var(--color-text-muted)] dark:hover:text-[var(--color-text-muted)] dark:hover:border-[var(--color-border-strong)]'}
						whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors dark:text-[var(--color-text-muted)] dark:hover:text-[var(--color-text-muted)]"
				>
					{tab.label}
					<span class="
						ml-2 py-0.5 px-2 rounded-full text-xs font-medium
						{activeTab === tab.value
							? tab.color === 'yellow' ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]' : tab.color === 'green' ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]' : tab.color === 'neutral' ? 'bg-[var(--color-surface-strong)] text-[var(--color-text)]' : 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
							: 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]'}
					">
						{countLabel(statusCount(tab.value))}
					</span>
				</button>
			{/each}
		</nav>
	</div>

	<!-- Kind filter. `approvals.kind` was on the wire but nowhere on the page,
	     so an improvement request was indistinguishable from any other row and
	     could not be filtered to. Counts are within the ACTIVE status tab, so a
	     "Improvement 0" chip is a direct answer to "are there any?". -->
	<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by request type">
		<span class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Type</span>
		{#each KIND_FILTERS as filter}
			<button
				type="button"
				data-testid="approval-kind-filter-{filter.value}"
				aria-pressed={activeKind === filter.value}
				onclick={() => (activeKind = filter.value)}
				disabled={bulkPending}
				class="
					rounded-full border px-3 py-1 text-xs font-medium transition-colors
					{activeKind === filter.value
						? 'border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]'
						: 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
			>
				{filter.label}
				<span class="ml-1 opacity-70">{countLabel(kindCount(filter.value))}</span>
			</button>
		{/each}
	</div>

	<!-- ⭐ ACTION FILTER — the facet a decider works by, and the one this page did
	     not have. Measured in a live browser 2026-09-15: the queue offered ONE
	     lens, by `kind`, while every ROW badged its `deblock_action`; 104 of the
	     200 loaded rows were QUESTION out of ~395 estate-wide, and there was no
	     way to ask for them.

	     ⛔ THE COUNTS ARE THE SERVER'S (`action_totals`, one GROUP BY over the
	     population) and THE FILTER IS THE SERVER'S (`?deblock_action=`). Both
	     halves are load-bearing: counting here would print "QUESTION 104" over a
	     1,294-row tab, and filtering here would only ever narrow the 200 rows
	     that happen to be loaded, leaving the other ~299 questions unreachable by
	     any click on this page. -->
	<div
		class="flex flex-wrap items-center gap-2"
		role="group"
		aria-label="Filter by proposed action"
	>
		<span class="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Action</span>
		{#each ACTION_FACETS as facet}
			<button
				type="button"
				data-testid="approval-action-filter-{facet}"
				aria-pressed={activeAction === facet}
				onclick={() => selectAction(facet)}
				disabled={bulkPending}
				class="
					rounded-full border px-3 py-1 text-xs font-medium transition-colors
					{activeAction === facet
						? 'border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]'
						: 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}"
			>
				{actionFacetLabel(facet)}
				<span class="ml-1 opacity-70">{countLabel(actionCount(facet))}</span>
			</button>
		{/each}
	</div>

	<!-- Bulk decide result. Rendered OUTSIDE the isLoading branch on purpose: a
	     bulk decide ends with a refetch, which raises the skeleton, and a report
	     that disappears behind the skeleton is a report the operator never read.
	     Partial failure is reported ROW BY ROW — the summary refuses to say
	     "approved N" when some of the N did not land. -->
	{#if bulkResults.length > 0}
		<div
			data-testid="bulk-decide-result"
			role={bulkFailures.length > 0 ? 'alert' : 'status'}
			data-stranded={bulkStranded.length}
			class="rounded-lg border px-4 py-3 text-sm
			{bulkFailures.length > 0
				? 'border-[var(--color-danger)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
				: bulkStranded.length > 0
					? 'border-[var(--color-warning)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]'
					: 'border-[var(--color-success)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]'}"
		>
			<p class="font-medium" data-testid="bulk-decide-summary">
				{#if bulkFailures.length > 0}
					{bulkVerb === 'approved' ? 'Approved' : 'Rejected'}
					{bulkResults.length - bulkFailures.length} of {bulkResults.length} —
					{bulkFailures.length}
					{bulkFailures.length === 1 ? 'approval' : 'approvals'} could not be {bulkVerb} and
					{bulkFailures.length === 1 ? 'is' : 'are'} still selected.
				{:else if bulkStranded.length > 0}
					<!-- ⛔ NOT "Approved N approvals." A decision whose callback never
					     landed did not move its card, and a run made entirely of those
					     used to render as an unqualified green success — the same
					     claim-without-verification this whole surface is being fixed for. -->
					Recorded {bulkResults.length}
					{bulkResults.length === 1 ? 'decision' : 'decisions'} —
					{bulkStranded.length}
					{bulkStranded.length === 1 ? 'was' : 'were'} not delivered onward, so
					{bulkStranded.length === 1 ? 'that card has' : 'those cards have'} not moved.
					{bulkStranded.length === 1 ? 'It is' : 'They are'} recorded and must not be decided
					again.
				{:else}
					{bulkVerb === 'approved' ? 'Approved' : 'Rejected'}
					{bulkResults.length}
					{bulkResults.length === 1 ? 'approval' : 'approvals'}.
				{/if}
			</p>

			<!-- Named, not just counted — the operator has to know WHICH cards to
			     chase, and the reason differs per row (refused receiver vs. a send
			     that failed vs. an outcome fr never learned). -->
			{#if bulkStranded.length > 0}
				<ul class="mt-2 space-y-1">
					{#each bulkStranded as stranded (stranded.id)}
						<li
							data-testid="bulk-decide-stranded"
							data-approval-id={stranded.id}
							data-callback-outcome={stranded.notice?.state}
						>
							<span class="font-medium">{stranded.description}</span>
							<span class="opacity-80"> — {stranded.notice?.message}</span>
						</li>
					{/each}
				</ul>
			{/if}
			<!-- Cancelled runs. The count that matters is the one NOT attempted:
			     those rows were never sent, are still pending, and are still
			     selected — so the operator can restart from exactly where the run
			     stopped rather than re-selecting from scratch. -->
			{#if bulkCancelled}
				<p class="mt-1" data-testid="bulk-decide-cancelled">
					Cancelled. {bulkTotal - bulkResults.length}
					{bulkTotal - bulkResults.length === 1 ? 'approval was' : 'approvals were'} not attempted
					and {bulkTotal - bulkResults.length === 1 ? 'is' : 'are'} still selected.
				</p>
			{/if}
			{#if bulkFailures.length > 0}
				<ul class="mt-2 space-y-1">
					{#each bulkFailures as failure (failure.id)}
						<li data-testid="bulk-decide-failure" data-approval-id={failure.id}>
							<span class="font-medium">{failure.description}</span>
							<span class="opacity-80"> — {failure.message}</span>
						</li>
					{/each}
				</ul>
			{/if}
			<!-- The QUESTION rows this run deliberately did not approve. Named, not
			     just counted: "3 skipped" is not something an operator can act on. -->
			{#if bulkSkipped.length > 0}
				<div class="mt-2" data-testid="bulk-decide-skipped">
					<p>
						{bulkSkipped.length}
						{bulkSkipped.length === 1 ? 'approval was' : 'approvals were'} not approved — a bulk
						approve sends no text, and each of these needs some: a QUESTION needs its written
						answer, and an INFRASTRUCTURE or DEPENDENCY hold needs {demandedDecisionText('fix_assertion')}
						(a broken-gate row cannot be bulk-approved at all). Decide
						{bulkSkipped.length === 1 ? 'it' : 'them'} on the row page:
					</p>
					<ul class="mt-1 space-y-1">
						{#each bulkSkipped as skippedRow (skippedRow.id)}
							<li data-approval-id={skippedRow.id}>
								<a href={`/approvals/${skippedRow.id}`} class="underline"
									>{skippedRow.description}</a
								>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			<button
				type="button"
				onclick={() => (bulkResults = [])}
				data-testid="bulk-decide-dismiss"
				disabled={bulkPending}
				class="mt-2 text-xs underline opacity-80 hover:opacity-100 disabled:opacity-40"
			>
				Dismiss
			</button>
		</div>
	{/if}

	<!-- Bulk decide bar. The queue is expensive to work row by row (every row has
	     to be opened), so the same decision can be taken over a selection. It
	     calls the ordinary per-row endpoint once per selected row. -->
	{#if selectableApprovals.length > 0}
		<div
			data-testid="approvals-bulk-bar"
			class="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--color-surface)] px-4 py-2 dark:bg-[var(--color-surface)]"
		>
			<!-- ⛔ "loaded" is not padding. `selectableApprovals` is derived from the
			     rows THIS PAGE HOLDS, and the endpoint's `total` can be larger. The
			     word, the number and the action all come from that one array, so the
			     label cannot promise a reach the click does not have. -->
			<label class="flex items-center gap-2 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
				<input
					type="checkbox"
					data-testid="approval-select-all"
					aria-label="Select all {selectableApprovals.length} loaded decidable approvals"
					checked={allSelected}
					disabled={bulkPending}
					onchange={toggleAllRows}
					class="cursor-pointer"
				/>
				<span data-testid="approvals-select-all-label"
					>Select all {selectableApprovals.length} loaded</span
				>
			</label>

			<span class="text-sm text-[var(--color-text-muted)]" data-testid="approvals-bulk-count">
				{selectedApprovals.length} selected
			</span>

			<!-- ⛔ Also disabled when the selection is ALL QUESTION rows: the click
			     would then decide nothing, and a control that does nothing reads as
			     a broken page rather than as a refusal. The number on the button is
			     `approvableSelected` for the same reason the select-all label is
			     `selectableApprovals`: the count on a
			     control must be the rows the click actually touches. -->
			<button
				type="button"
				data-testid="approvals-bulk-approve"
				onclick={() => decideSelected('approved')}
				disabled={bulkPending || selectedApprovals.length === 0 || approvableSelected.length === 0}
				class="px-3 py-1.5 rounded-lg bg-[var(--color-success)] text-[var(--color-text)] text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{bulkPending ? 'Deciding…' : `Approve ${approvableSelected.length} selected`}
			</button>
			<button
				type="button"
				data-testid="approvals-bulk-reject"
				onclick={openBulkRejectModal}
				disabled={bulkPending || selectedApprovals.length === 0}
				class="px-3 py-1.5 rounded-lg bg-[var(--color-danger)] text-[var(--color-on-primary)] text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
			>
				Reject selected
			</button>
			<!-- ⛔ The ONE control in this bar that is NOT disabled during a run. A
			     1206-row run is ~22 minutes; without a way out the operator's only
			     option is to close the tab, which ends the run at an unknown row
			     and tells them nothing about where it stopped. -->
			{#if bulkPending}
				<button
					type="button"
					data-testid="bulk-decide-cancel"
					onclick={() => bulkAbort?.abort()}
					class="px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
				>
					Cancel
				</button>
			{/if}

			{#if selectedApprovals.length > 0}
				<button
					type="button"
					data-testid="approvals-bulk-clear"
					onclick={clearSelection}
					disabled={bulkPending}
					class="ml-auto text-xs text-[var(--color-text-muted)] hover:underline"
				>
					Clear
				</button>
			{/if}

			<!-- Progress. The run is PACED (one decide per BULK_INTERVAL_MS), so a
			     large selection is minutes of wall clock with no visible change
			     unless it is counted out. Nothing persists the run — there is no
			     job row and no resumable cursor — so closing the tab ends it at
			     whatever row it had reached, and the operator has to be told that
			     BEFORE they walk away, not after. -->
			{#if bulkPending}
				<div
					data-testid="bulk-decide-progress"
					role="status"
					aria-live="polite"
					class="basis-full text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]"
				>
					<p>
						<span class="font-medium">{bulkDone} / {bulkTotal}</span>
						{bulkVerb === 'approved' ? 'approved' : 'rejected'} · {bulkEta}
					</p>
					<p class="text-xs text-[var(--color-text-muted)]">
						Paced at one decision every {(BULK_INTERVAL_MS / 1000).toFixed(1)}s — the server
						refuses a faster approver. Keep this tab open: nothing on the server remembers this
						run, so closing or navigating away stops it at the row it has reached. Started
						{new Date(bulkStartedAt).toLocaleTimeString()}.
					</p>
				</div>
			{/if}

			<!-- ⛔ The QUESTION carve-out, stated where the click happens. Approving
			     a QUESTION with no written answer does not release its card; the
			     n8n consumer needs `answerText.length > 0`, so the card stays
			     BLOCKED and the gate raises a NEW approval on it. Bulk-approving
			     these grows the queue instead of draining it. -->
			{#if questionSelected.length > 0}
				<div
					data-testid="bulk-question-excluded"
					class="basis-full rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
				>
					<p>
						{#if fixSelectedCount < questionSelected.length}
							{questionSelected.length - fixSelectedCount}
							{questionSelected.length - fixSelectedCount === 1 ? 'selected approval proposes' : 'selected approvals propose'}
							QUESTION and will NOT be approved by this button. Approving a QUESTION without a
							written answer does not release its card — it strands the card and the gate raises a
							new approval on it, so a bulk approve here grows the queue rather than draining it.
						{/if}
						{#if fixSelectedCount > 0}
							{fixSelectedCount}
							{fixSelectedCount === 1 ? 'selected approval is an' : 'selected approvals are'}
							INFRASTRUCTURE or DEPENDENCY hold and will NOT be approved by this button: approving
							one re-drives its card to TODO, which requires {demandedDecisionText('fix_assertion')}.
						{/if}
						Decide {questionSelected.length === 1 ? 'it' : 'them'} one at a time on the row page:
					</p>
					<ul class="mt-1 space-y-1">
						{#each questionSelected as questionRow (questionRow.id)}
							<li data-approval-id={questionRow.id}>
								<a href={`/approvals/${questionRow.id}`} class="underline"
									>{questionRow.description}</a
								>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<!-- ⛔ The BROKEN-GATE carve-out, stated where the click happens, for the same
			     reason as the QUESTION one above it. These rows cannot be approved by
			     anyone through this button: the server refuses them outright (#1064).
			     Leaving them in the bulk set produced one guaranteed 422 per row and a
			     failure list the operator had to read to discover a rule the UI already
			     knew. A super-admin can override them individually on the row page. -->
			{#if brokenGateSelected.length > 0}
				<div
					data-testid="bulk-broken-gate-excluded"
					class="basis-full rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger-text)]"
				>
					<p>
						{brokenGateSelected.length}
						{brokenGateSelected.length === 1
							? 'selected approval carries a broken gate'
							: 'selected approvals carry a broken gate'}
						and will NOT be approved by this button. Their gate terms describe a defect in the
						process that raised them, not a decision anyone can take, so the server refuses
						every approve on them. Reject {brokenGateSelected.length === 1 ? 'it' : 'them'}
						with a reason, or — as a super-admin — override
						{brokenGateSelected.length === 1 ? 'it' : 'them'} one at a time on the row page:
					</p>
					<ul class="mt-1 space-y-1">
						{#each brokenGateSelected as brokenRow (brokenRow.id)}
							<li data-approval-id={brokenRow.id}>
								<a href={`/approvals/${brokenRow.id}`} class="underline">{brokenRow.description}</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{/if}

	<!-- What "loaded" is measured against. Renders ONLY when the endpoint said
	     the population is bigger than the page it handed over, and states in
	     words that those rows are out of reach of the buttons above — a bare
	     "549" printed near a bulk control is read as a selection size. -->
	{#if hiddenCount > 0}
		<div
			data-testid="approvals-page-truncation-note"
			class="flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
		>
			<p>
				<!-- ⭐ UNDER AN ACTION FILTER `loadedTotal` IS THE SUBSET'S SIZE, not
				     the tab's, because the server applied the filter before counting.
				     Naming the action is what keeps the sentence true: "Showing 200 of
				     395" beside a Pending pill reading 1,294 is incoherent without it,
				     and it is the sentence that tells the operator the subset is now
				     within reach of one Load more rather than seven. -->
				Showing {allApprovals.length} of {loadedTotal}
				{activeAction === 'all' ? '' : `${actionFacetLabel(activeAction)} `}{activeTab} approvals.
				The remaining {hiddenCount}
				{hiddenCount === 1 ? 'is' : 'are'} not loaded on this page and cannot be selected or
				decided from here.
				{#if atServerPageCeiling}
					<!-- ⛔ SAID OUT LOUD RATHER THAN HIDDEN BEHIND A DEAD BUTTON. The
					     server clamps one page at MAX_PAGE_SIZE, so past that point
					     "Load more" cannot deliver and offering it would be the silent
					     narrowing this note exists to prevent. -->
					This page loads at most {MAX_PAGE_SIZE} rows of a status at once — decide or filter
					down what is loaded, and the rest come into reach.
				{/if}
			</p>
			{#if !atServerPageCeiling}
				<button
					type="button"
					data-testid="approvals-load-more"
					onclick={loadMore}
					disabled={isLoading || bulkPending}
					class="rounded-lg border border-[var(--color-border-strong)] px-3 py-1 font-medium text-[var(--color-text)] hover:bg-[var(--color-surface)] disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Load {Math.min(PAGE_SIZE, hiddenCount)} more
				</button>
			{/if}
		</div>
	{/if}

	<!-- ⛔ THE OTHER WAY A ROW GOES MISSING, and the one that used to be SILENT.
	     The note above only ever admits rows the server did not send. A row that
	     WAS sent and whose status matches no tab is dropped at render by
	     `byStatus`, and every number on this page — the tab pills and
	     `hiddenCount` alike — reads as if it did not exist. That was the state of
	     this page for 892 voided rows. If it ever renders again, a status exists
	     that this page does not know about. -->
	{#if unsurfacedCount > 0}
		<p
			data-testid="approvals-unsurfaced-note"
			class="text-xs text-[var(--color-warning-text)]"
		>
			{unsurfacedCount}
			{unsurfacedCount === 1 ? 'approval holds a status' : 'approvals hold statuses'}
			that no tab above shows, so {unsurfacedCount === 1 ? 'it is' : 'they are'} not counted in any
			tab. This is a gap in this page, not in your queue — please report it.
		</p>
	{/if}

	<!-- Loading State.
	     ⛔ `allApprovals.length === 0` is load-bearing, not defensive. The
	     skeleton REPLACES the list, so any refresh allowed to reach it unmounts
	     every row — including the answer textarea a human is typing into. Gated
	     on there being nothing to show, it can only ever cover a first/empty
	     load. -->
	{#if isLoading && allApprovals.length === 0}
		<div class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]">
			<div class="p-6">
				<Skeleton variant="text" count={5} height="3rem" />
			</div>
		</div>
	{:else if queueState === 'unreadable'}
		<!-- ⛔ THIS BRANCH IS THE MUTUAL EXCLUSION, AND IT IS THE WHOLE FIX. The
		     ErrorState above and the empty state below used to be siblings, so a
		     first-load failure rendered "Error" and "There are no pending
		     approvals at this time." on one screen. The empty states are now
		     unreachable while the read has never succeeded, so this surface can
		     no longer tell an operator the decision queue is clear on the
		     strength of a request that failed.

		     The ErrorState above keeps the diagnosis and the Retry; this says
		     what the operator must NOT conclude from it. -->
		<div
			class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]"
			data-testid="approvals-unreadable"
			role="alert"
		>
			<div class="p-6">
				<h3 class="text-sm font-semibold text-[var(--color-text)]">
					The approvals queue could not be read
				</h3>
				<p class="mt-2 text-sm text-[var(--color-text-muted)]">
					This is <strong class="font-medium text-[var(--color-text)]">not</strong> a statement
					that there is nothing to decide. How many approvals are waiting — in
					{activeTab}
					or any other tab — is unknown right now. Retry above, or reload the page.
				</p>
			</div>
		</div>
	{:else}
		<!-- Approvals List -->
		<div class="bg-[var(--color-bg)] rounded-lg shadow dark:bg-[var(--color-surface)]">
			<!-- ⛔ `displayRows`, NOT `filteredApprovals`. Decide the last pending row
			     and `filteredApprovals` is empty while a receipt is still standing:
			     gating on it would swap the outcome of the decision the operator
			     just took for "No pending approvals" — the disappearing-feedback
			     defect, produced by the empty state instead of by the refresh. -->
			{#if displayRows.length === 0}
				<!-- ⛔ THE ACTION BRANCH IS FIRST, AND ITS BODY MAY NOT USE
				     `byStatus.length`. Under an action filter the server sent back
				     only that bucket's rows, so `byStatus` is the EMPTY filtered
				     page, not the tab — the kind branch's "N approvals are hidden"
				     sentence would read "0 approvals are hidden" and tell the
				     operator their tab is empty when the tab holds 1,294 rows.
				     `statusCount` is the population number and is the only honest
				     one here; the chip counts beside it say where the rows went. -->
				{#if activeAction !== 'all'}
					<EmptyState
						title="No {actionFacetLabel(activeAction)} approvals in {activeTab}"
						body="Nothing in the {activeTab} queue proposes {actionFacetLabel(activeAction)}. The other {statusCount(activeTab)} {activeTab} {statusCount(activeTab) === 1 ? 'approval is' : 'approvals are'} still there — choose All, or another action chip, to reach them."
					/>
				{:else if activeKind !== 'all' && byStatus.length > 0}
					<EmptyState
						title="No {activeKind} approvals in {activeTab}"
						body="{byStatus.length} {activeTab} {byStatus.length === 1 ? 'approval is' : 'approvals are'} hidden by the {activeKind} type filter. Choose All to see them."
					/>
				{:else}
					<EmptyState
						title="No {activeTab} approvals"
						body={EMPTY_BODY[activeTab]}
					/>
					<!-- fr row 14d: the queue reads the ACTIVE workspace only, so an
					     empty pending tab may mean the work is one switch away. The
					     hint lists PLATFORM workspaces with pending work (super-admin
					     only; never a customer) and renders nothing otherwise. -->
					{#if activeTab === 'pending' && statusCount('pending') === 0}
						<ApprovalWorkspaceHint />
					{/if}
				{/if}
			{:else}
				<div
					data-testid="approvals-list"
					class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]"
				>
					{#each displayRows as entry (entry.key)}
						{#if entry.kind === 'receipt'}
							<!-- ⭐ THE ROW IS GONE AND ITS OUTCOME IS NOT. This card stands
							     exactly where the decided row stood, names the card it was
							     about, and stays until dismissed — a decision the operator
							     took is not something the next 30s poll gets to erase. -->
							<div
								data-testid="approval-callback-notice"
								data-approval-id={entry.receipt.id}
								data-callback-outcome={entry.receipt.notice.state}
								data-callback-delivered={entry.receipt.notice.delivered ? 'true' : 'false'}
								role={entry.receipt.notice.tone === 'error' ? 'alert' : 'status'}
								class="px-6 py-4 border-l-4 text-sm {noticeToneClass(entry.receipt.notice.tone)}"
							>
								<p class="font-medium" data-testid="approval-callback-notice-title">
									{entry.receipt.title}
								</p>
								<p class="mt-1">{entry.receipt.notice.message}</p>
								<button
									type="button"
									onclick={() => dismissReceipt(entry.receipt.id)}
									data-testid="approval-callback-notice-dismiss"
									class="mt-2 text-xs underline opacity-80 hover:opacity-100"
								>
									Dismiss
								</button>
							</div>
						{:else}
						{@const approval = entry.approval}
						{@const rowReceipt = receiptFor(approval.id)}
						{@const expiration = formatExpiration(approval.expires_at)}
						<!-- ⚠️ Hoisted to the top of the `{#each}` because Svelte 5 only
						     accepts `{@const}` as the IMMEDIATE child of a block, not part
						     way down the markup where each value is used. -->
						{@const proposition = parseProposition(approval.description)}
						{@const brokenTerms = brokenGateTermsOf(approval)}
						<!-- Null on every non-voided row; hoisted for the same Svelte 5
						     reason as the lines above. -->
						{@const voided = voidedNote(approval)}
						<!-- What the PERSISTED callback columns say happened to this decision
						     downstream. `null` on every pending row and on every row that
						     resolved cleanly ('moved' / benign), so the chip's mere presence
						     is the signal — same discipline as the deblock chip below, which
						     renders nothing rather than a placeholder when absent. Hoisted
						     for the same Svelte 5 reason as the lines above. -->
						{@const callbackNotice = callbackRowNotice(approval)}
						<!-- ⭐ `'approved'`, not the row's status: `answerRequired` is a
						     property of the DECISION about to be taken, not of the row. The
						     server demands answer text only on approve
						     (`status === 'approved'`), and rejecting a question you cannot
						     answer is a legitimate terminal that is never blocked — which is
						     why the Reject button below is never gated on this. -->
						{@const needsAnswer = answerRequired(approval, 'approved')}
						<!-- ⛔ WHY the text is demanded selects the WORDING below. A fix-assertion
						     row (INFRASTRUCTURE / DEPENDENCY approve → TODO) is not a question and
						     must never be labelled, placeholdered or refused as one. -->
						{@const demand = answerDemandOf(approval)}
						{@const answerVerdict = validateAnswer(answerTextOf(approval.id), questionPresentation(approval).state, demand)}
						<!-- ⛔ THE QUESTION ITSELF, which this page has never read. THE SHAPE,
						     not a count: `deblock_action = QUESTION` (what makes `answerRequired`
						     true) and `metadata.open_questions` (the only field holding question
						     TEXT) have an EMPTY INTERSECTION — no row fr demands an answer from
						     states a question, and no row that states one is typed QUESTION. Two
						     instruments at two scopes (psql over pending; the approvals API as the
						     triage seat, both 2026-09-10) disagreed on every population count and
						     agreed exactly on that. So the answer box was offered on exactly the
						     rows with no question in them, and withheld from the only rows that
						     ask one. `questionPresentation` reports which of the four shapes this
						     row is; it deliberately does NOT widen `isQuestion`, which mirrors the
						     server's answer-demanded rule and gates bulk approve. -->
						{@const question = questionPresentation(approval)}
						<!-- The answer affordance is offered on a stated question too, not only
						     on a typed QUESTION. The server accepts and delivers that text:
						     `persistedComment` is written unconditionally
						     (backend/src/routes/approvals.ts:1510,1580) and forwarded
						     unconditionally (services/n8n-callback.ts:193). What it does NOT do
						     is move the card — see UNROUTED_QUESTION_NOTICE, which is stated
						     beside the box so the offer is not a promise the wire cannot keep. -->
						{@const answerOffered = brokenTerms.length === 0 && (needsAnswer || question.state === 'unrouted')}
						<!-- ⭐ fr#1080. Until now this page rendered ONE undifferentiated
						     "Approve" for every action except QUESTION, so a RETRY row — 410 of
						     840 pending — looked exactly like a sign-off while approving it is A
						     REAL CARD MOVE back to TODO. Nine such rows were opened and three
						     pointed at cards already finalized=true, verdict=pass, 13/13 steps.
						     The destination comes from `approval-callback.json ::
						     Resolve Target List`'s own ACTION_TARGET map, not from a UI guess. -->
						{@const moveNotice = approveMoveNotice(approval)}
						{@const moveTarget = cardMoveOnApprove(approval)}
						<!-- ⭐ The consequence of clicking Approve was ALREADY computed on this
						     row and then shown only as a `title=` hover tooltip — which is
						     `null`, i.e. absent entirely, on every HELD action. Measured
						     2026-09-13: of 458 human Approve clicks only 73 (16%) moved a card;
						     INFRASTRUCTURE (161), DEPENDENCY (6) and unanswered QUESTION (213)
						     rows are held by the receiver and said so nowhere on screen. This
						     const states it in the row itself. `null` renders nothing BY
						     DESIGN: QUESTION rows already carry ANSWER_CONTRACT/question.notice
						     beside the answer box, and an unmodelled action must not be given a
						     sentence the wire has not promised. -->
						{@const consequence = approveConsequenceNotice(approval)}
						<div
							data-testid="approval-row"
							data-approval-id={approval.id}
							class="px-6 py-4 hover:bg-[var(--color-surface)] transition-colors dark:hover:bg-[var(--color-surface-strong)]"
						>
							<div class="flex items-start justify-between gap-4">
								<!-- Bulk-select checkbox. Only on rows this user may actually
								     decide (same gate as the Approve/Reject buttons below). -->
								{#if approval.status === 'pending' && canActOnApproval(approval, auth.user)}
									<input
										type="checkbox"
										data-testid="approval-select-{approval.id}"
										aria-label="Select approval: {approval.description}"
										checked={selectedIds.has(approval.id)}
										disabled={bulkPending}
										onchange={() => toggleRow(approval.id)}
										class="mt-1.5 flex-shrink-0 cursor-pointer"
									/>
								{/if}
								<div class="flex-1 min-w-0">
									<!-- Project Badge. Null projectName = a workspace-scoped
									     (null-project) approval, e.g. a worker-initiated KAG ingest. -->
									<div class="flex items-center gap-2 mb-2">
										<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]">
											{scopeBadge(approval)}
										</span>
										<span
											data-testid="approval-kind-chip"
											class="inline-flex items-center rounded-full border border-[var(--color-border)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-text-muted)]"
										>
											{kindLabel(approval)}
										</span>
										<!-- Proposed way out of the block. Absent on ~a third of
										     the queue; renders nothing at all when absent. -->
										<!-- ⛔ The QUESTION tooltip used to end "Deciding this moves no
										     card; it asks the requester something." Both halves were
										     wrong in the direction that costs the most. It is not the
										     REQUESTER who is asked — the question is put to the
										     approver, and it has no field of its own anywhere on the
										     row (the proposition block below is the closest thing to
										     it). And deciding it CAN move the card: the answer text is
										     the payload the n8n callback forwards, and an approve
										     carrying one returns the card to TODO to be re-driven.
										     What moves nothing is an approve with an EMPTY answer,
										     which the server now refuses outright and which, before it
										     did, spent the row and stranded the card in BLOCKED with
										     `approval_answer_missing`. A tooltip saying "deciding moves
										     no card" teaches the operator that the empty click is
										     harmless. It is the harmful one. -->
										{#if deblockAction(approval)}
											{@const action = deblockAction(approval)!}
											<span
												data-testid="approval-deblock-chip"
												title={isHoldingAction(action)
													? 'Proposed action: QUESTION — a holding action: the card stays BLOCKED until this is answered. Your written answer is what moves it — approving WITH an answer forwards that text to the n8n callback, which returns the card to TODO to be re-driven. Approving with no answer moves nothing.'
													: `Proposed action: ${action} — this decision releases the blocked card.`}
												class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium
												{isHoldingAction(action)
													? 'border-[var(--color-warning)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]'
													: 'border-[var(--color-border)] text-[var(--color-text-muted)]'}"
											>
												{action}
											</span>
										{/if}
										<!-- ⭐ WHAT HAPPENED AFTER THE DECISION — the half of the row
										     that was on the wire and on screen NOWHERE. Absent on
										     every pending row and on every cleanly-moved one (see
										     `callbackRowNotice`), exactly like the deblock chip above.
										     ⛔ The tone is a correctness rule, not styling: only
										     `send_exhausted` / `card_unreadable` are red. "Not
										     confirmed" and "unknown" are WARNINGS and carry no failure
										     word, because fr not knowing is not the receiver refusing
										     — backend/src/db/schema.ts ~1119 makes that distinction
										     and this chip must not undo it. -->
										{#if callbackNotice}
											<span
												data-testid={callbackNotice.testId}
												data-callback-state={callbackNotice.state}
												title={callbackNotice.message}
												class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium {noticeToneClass(callbackNotice.tone)}"
											>
												{callbackNotice.label}
											</span>
										{/if}
										<span class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{formatTimestamp(approval.created_at)}</span>
										<!-- ⛔ EVERY row links to its own page, not only the rows
										     carrying a `document`. The gate used to be
										     `{#if approval.document}`, which is a test of whether
										     there is an attachment to preview — not of whether there
										     is a page to open. There always is: /approvals/[id]
										     renders the full proposition, the decision history and
										     the answer box for any id. Most of this queue is
										     worker-minted and carries no document at all, so the old
										     condition hid the only route to the detail view on
										     exactly the rows an operator most needs to open, and the
										     bulk-skip list two screens up already links to that same
										     page unconditionally. The LABEL still branches, because
										     "Review document" would be a promise of an attachment
										     that isn't there. -->
										<a
											href={`/approvals/${approval.id}`}
											class="ml-auto text-xs font-semibold text-[var(--color-accent-strong)] hover:underline"
											data-testid="approval-review-link"
										>
											{approval.document ? 'Review document →' : 'Open approval →'}
										</a>
									</div>

									<!-- ⭐ THE QUESTION, when the producer actually asked one. Rendered
									     ABOVE the block context on purpose: it is the one thing on the
									     row a human is being asked to respond to, and it used to be
									     nowhere — `open_questions` had no reader on this surface at all.
									     Plain `{...}` interpolation, never `{@html}`, for the same
									     reason the proposition below uses it: producer text passes
									     through VERBATIM. -->
									{#if question.questions.length > 0}
										<div
											data-testid="approval-open-questions"
											class="mb-2 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-bg)] p-3"
										>
											<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent-text)]">
												{question.questions.length === 1 ? 'Question for you' : `Questions for you (${question.questions.length})`}
											</p>
											<ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--color-text)]">
												{#each question.questions as openQuestion}
													<li class="whitespace-pre-line">{openQuestion}</li>
												{/each}
											</ul>
										</div>
									{/if}

									<!-- Description / block context.
									     ⚠️ CORRECTED 2026-09-10. This used to open "There is NO
									     question field anywhere on an approval — not in the columns,
									     not in `metadata`", and that was the premise for treating the
									     description as the closest thing to the question. It is FALSE:
									     `metadata.open_questions` is a real field carrying real,
									     answerable English sentences on a minority of rows, and
									     nothing on this surface read it. It is now read above. The
									     paragraph below still holds for the majority of rows, which
									     carry no such field. For a QUESTION row the
									     block context packed into `description` IS the closest thing
									     to the question being asked, and it arrived here as one
									     unbroken blob: a BLOCK REASON, a VERDICT and an ISSUES list
									     run together in a single `<h3>`, which is how a row that
									     does state its problem still reads as unanswerable. Two
									     description formats are in circulation and only the newer
									     one is structured, so this branches on what
									     `parseProposition` could actually parse — never on a guess
									     from the row's age or kind.
									     ⭐ `parsed === false` renders the raw description EXACTLY as
									     before. A parser that invents headings for text it did not
									     understand would put fr's structure on a producer's words,
									     which is the same defect `$lib/approvals/rationale` exists to
									     prevent one field over. -->
									{#if proposition.parsed}
										<h3 class="font-semibold text-[var(--color-text)] mb-1 dark:text-[var(--color-text)]">{markUnreadableProducerOutput(proposition.title || approval.description)}</h3>
										<div
											data-testid="approval-proposition"
											class="mt-2 space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
										>
											{#if proposition.blockReason}
												<div>
													<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Block reason</p>
													<p class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{markUnreadableProducerOutput(proposition.blockReason)}</p>
												</div>
											{/if}
											{#if proposition.verdict}
												<div>
													<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Verdict</p>
													<p class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{markUnreadableProducerOutput(proposition.verdict)}</p>
												</div>
											{/if}
											{#if proposition.issues && proposition.issues.length > 0}
												<div>
													<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
														Issues ({proposition.issues.length})
													</p>
													<ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
														{#each proposition.issues as issue}
															<li>{markUnreadableProducerOutput(issue)}</li>
														{/each}
													</ul>
												</div>
											{/if}
											<!-- ⛔ THE PRODUCER'S OWN STATEMENT OF WHAT EACH DECISION DOES.
											     `parseProposition` extracts these, and while `parsed` rows
											     stopped printing the raw description they were rendered
											     NOWHERE — so the `ON APPROVE: your decision comment is taken
											     as the ANSWER…` / `ON REJECT: the card stays in BLOCKED.`
											     lines, which WERE on screen before that change, went missing
											     from exactly the QUESTION rows that need them. Only the newer
											     description format carries them, which is why the UI also
											     states {ANSWER_CONTRACT} beside the box in its OWN words: that
											     is the floor for every row, and this is the producer's words
											     for the rows that supply them. Neither replaces the other. -->
											{#if proposition.onApprove}
												<div>
													<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">On approve</p>
													<p class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{markUnreadableProducerOutput(proposition.onApprove)}</p>
												</div>
											{/if}
											{#if proposition.onReject}
												<div>
													<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">On reject</p>
													<p class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{markUnreadableProducerOutput(proposition.onReject)}</p>
												</div>
											{/if}
											<!-- ⛔ Prose that followed the legacy trailer and belongs to NO
											     label. The parser used to DISCARD it; it now reports it, and
											     a template that did not render it would move the same drop
											     one layer down — the human still never sees it. Headed
											     neutrally on purpose: no label claimed this text, so naming
											     it a section would attribute the producer's words to a
											     structure they never asserted. Plain `{...}` interpolation,
											     never `{@html}`: real descriptions carry a literal
											     `[object Object]`, JSON fragments with `<`/`>`, and text
											     truncated mid-word, all of which pass through VERBATIM
											     because they are the only visible evidence of the defect
											     upstream. -->
											{#if proposition.trailing}
												<div>
													<p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Also in the description</p>
													<p class="whitespace-pre-line text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{markUnreadableProducerOutput(proposition.trailing)}</p>
												</div>
											{/if}
										</div>
									{:else}
										<h3 class="font-semibold text-[var(--color-text)] mb-1 dark:text-[var(--color-text)]">{markUnreadableProducerOutput(approval.description)}</h3>
									{/if}

									<!-- Requester. Worker/n8n-minted approvals carry no requester_id,
									     which used to render as an empty gap that read like a loading
									     bug. Say nothing was recorded rather than naming a person. -->
									<p class="text-sm text-[var(--color-text)] mb-2 dark:text-[var(--color-text-muted)]">
										Requested by:
										{#if approval.requester_id}
											<span class="font-medium"><EntityRef id={approval.requester_id} name={displayName(approval.requester_name, displayName(approval.requester_email, '')) || null} kind="user" /></span>
										{:else}
											<span class="font-medium text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]" title="No requester was recorded on this approval (system-initiated).">—</span>
										{/if}
									</p>

									<!-- Change Summary — ⛔ THREE states, not two, and this list is the
									     renderer the whole change was written for. Since 2026-09-03 the
									     backend writes a MARKED ABSENCE instead of NULL when a producer
									     supplies no rationale, so `{#if approval.change_summary}` became
									     ALWAYS TRUE: every row of the pending cohort grew a titled
									     "Change Summary:" panel holding ~333 characters of fr boilerplate,
									     styled identically to a worker's own prose. That is a governance
									     surface presenting fr's own words as the producer's.
									     Same treatment as $lib/components/workspace/NeedsYouQueue.svelte:
									     producer text verbatim in the panel; an absence said in ONE short
									     line taken from the shared constant (never a string built from the
									     row — a governance surface must not fabricate) and deliberately
									     WITHOUT the panel chrome, so it can never read as content; legacy
									     NULL/'' rows still render nothing, as before. That legacy case is
									     not extinct. See $lib/approvals/rationale.ts. -->
									{#if producerRationale(approval.change_summary)}
										<div class="mt-2 bg-[var(--color-surface)] rounded-md p-3 dark:bg-[var(--color-bg)]">
											<p class="text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Change Summary:</p>
											<p class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{markUnreadableProducerOutput(approval.change_summary)}</p>
										</div>
									{:else if isNoRationaleSupplied(approval.change_summary)}
										<p
											class="mt-2 text-sm italic text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
											data-testid="approvals-list-no-rationale-change-summary"
										>
											{NO_RATIONALE_SHORT}
										</p>
									{/if}

									<!-- Impact Analysis — same three states, same reasoning as the block
									     above. NO_RATIONALE_SHORT is the shared constant for both fields
									     on purpose: it is the only absence wording that is not derived
									     from this row. -->
									{#if producerRationale(approval.impact_analysis)}
										<div class="mt-2 bg-[var(--color-surface)] rounded-md p-3 dark:bg-[var(--color-bg)]">
											<p class="text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Impact Analysis:</p>
											<p class="text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{markUnreadableProducerOutput(approval.impact_analysis)}</p>
										</div>
									{:else if isNoRationaleSupplied(approval.impact_analysis)}
										<p
											class="mt-2 text-sm italic text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
											data-testid="approvals-list-no-rationale-impact-analysis"
										>
											{NO_RATIONALE_SHORT}
										</p>
									{/if}

									<!-- Expiration -->
									<div class="mt-2 flex items-center gap-2">
										<svg class="w-4 h-4 {expiration.isExpired ? 'text-[var(--color-danger)]' : expiration.isExpiringSoon ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]'}" fill="currentColor" viewBox="0 0 20 20">
											<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" />
										</svg>
										<span class="text-sm {expiration.isExpired ? 'text-[var(--color-danger)] font-medium' : expiration.isExpiringSoon ? 'text-[var(--color-warning)] font-medium' : 'text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]'}">
											{expiration.text}
										</span>
									</div>

									<!-- Required Approvers -->
									{#if approval.required_approvers && approval.required_approvers.length > 0}
										<div class="mt-3">
											<p class="text-sm font-medium text-[var(--color-text)] mb-2 dark:text-[var(--color-text-muted)]">Required Approvers:</p>
											<div class="flex flex-wrap gap-2">
												{#each approval.required_approvers as approver}
													<span
														class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
														{approver.approved ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]' : 'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]'}"
														title={approver.user_id}
													>
														{approverLabel(approver)}
														{#if approver.role}
															<span class="ml-1 text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">({approver.role})</span>
														{/if}
														{#if approver.approved}
															<svg class="ml-1 w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
																<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
															</svg>
														{/if}
													</span>
												{/each}
											</div>
										</div>
									{/if}

									<!-- Decisions -->
									{#if approval.decisions && approval.decisions.length > 0}
										<div class="mt-3">
											<p class="text-sm font-medium text-[var(--color-text)] mb-2 dark:text-[var(--color-text-muted)]">Decisions:</p>
											<div class="space-y-2">
												{#each approval.decisions as decision}
													<div class="flex items-start gap-2 text-sm">
														<span class="
															inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
															{decision.decision === 'approved' ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]' : 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'}
														">
															{humanizeEnum(decision.decision)}
														</span>
														<div class="flex-1">
															<span class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]"><EntityRef id={decision.approver_id} name={displayName(decision.approver_name, displayName(decision.approver_email, '')) || null} kind="user" /></span>
															{#if decision.comment}
																<span class="text-[var(--color-text)] dark:text-[var(--color-text-muted)]">- {decision.comment}</span>
															{/if}
															<span class="text-[var(--color-text-muted)] ml-2 dark:text-[var(--color-text-muted)]">{formatTimestamp(decision.decided_at)}</span>
														</div>
													</div>
												{/each}
											</div>
										</div>
									{/if}

									<!-- ⭐ A VOID IS NOT A DECISION, and this block is deliberately NOT part of
									     the Decisions list above. A voided row writes NO `approval_decisions`
									     row at all — backend migration 110 states the reason in as many words:
									     so the quorum tally and every decision reader stay truthful about who
									     decided what. Rendering a void through the decision path would have to
									     invent an approver and a verdict for an ask nobody answered. The audit
									     trail lives on the approvals row itself (`voided_at` / `voided_reason`
									     / `voided_by`, all three populated on all 892 voided rows on prod,
									     measured 2026-09-13) and that is what is shown.
									     Neutral palette and the word "withdrawn", never "rejected": the entire
									     point of a fifth status is that an operator's housekeeping act must not
									     be reported as a human decision. -->
									{#if voided}
										<div
											data-testid="approval-voided-note"
											class="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-3 text-sm"
										>
											<p class="font-medium text-[var(--color-text)]">Withdrawn without a decision</p>
											<p class="mt-1 text-[var(--color-text-muted)]">
												An operator withdrew this request because it could not be answered. Nobody
												approved or rejected it.
											</p>
											{#if voided.reason}
												<p class="mt-2 text-[var(--color-text)]" data-testid="approval-voided-reason">
													Reason: {voided.reason}
												</p>
											{:else}
												<!-- Stated as missing rather than filled in optimistically — the same
												     discipline migration 110 applies to the columns themselves. Only a
												     writer other than backend/src/lib/void-approvals.ts can reach this. -->
												<p class="mt-2 text-[var(--color-text-muted)]">No reason was recorded.</p>
											{/if}
											<p class="mt-1 text-xs text-[var(--color-text-muted)]">
												{#if voided.by}Voided by {voided.by}{:else}Voided{/if}{#if voided.at} · {formatTimestamp(voided.at)}{/if}
											</p>
										</div>
									{/if}

									<!-- ⭐ THE DECIDED ROW WHOSE CARD MAY STILL BE BLOCKED. Placed
									     beside the void note and NOT inside the Decisions list
									     above, for the same reason the void note is not: this is
									     not something an approver decided, it is what happened to
									     the delivery afterwards.

									     ⛔ NO RE-DECIDE CONTROL, EVER. The decision is spent — the
									     `approval_decisions` row and the completing UPDATE both land
									     before the callback is even attempted, and a second decision
									     from the same approver is refused with a 422. The only
									     action offered is opening the card, and the copy says so.
									     The existing "Open approval →" link on this row is the route;
									     no card URL is on this wire, so none is invented here. -->
									{#if callbackNotice}
										<div
											data-testid="approval-callback-note"
											data-callback-state={callbackNotice.state}
											class="mt-3 rounded border p-3 text-sm {noticeToneClass(callbackNotice.tone)}"
										>
											<p class="font-medium">{callbackNotice.label}</p>
											<p class="mt-1">{callbackNotice.message}</p>
										</div>
									{/if}
								</div>

								<!-- Action controls (pending only). The backend gates the
								     decision to the approval's registered required approvers —
								     a non-approver (or someone who already decided) just gets a
								     422 on click. Gate on the SAME rule (canActOnApproval, the
								     helper the NEEDS YOU queue + review page use) so the human
								     never sees a dead button; show honest status instead. -->
								{#if approval.status === 'pending'}
									{#if canActOnApproval(approval, auth.user)}
										<div class="flex flex-col items-stretch gap-2 flex-shrink-0 {answerOffered && answerOpen[approval.id] ? 'w-80' : ''}">
											<!-- ⛔ A BROKEN GATE IS NOT A QUESTION, and the answer box must
											     not be offered on one. `gate_terms` naming a defect describe
											     a fault in the process that RAISED the row, not a
											     proposition anyone can answer, and the server refuses the
											     approve outright (#1064). Letting an operator type a careful
											     answer into a row no answer can release is the cruellest
											     available dead control — and the override that row would
											     need reads `reason` ONLY, never the `comment` this box
											     sends, so even a super-admin's text would land in the field
											     the guard does not read.

											     ⭐ THE OVERRIDE NOW EXISTS. Until 2026-09-13 this panel
											     told the reader a super-admin could override and sent them
											     to the approval page — where `DecisionBar` sent only
											     `comment`, so there was no `reason` field on EITHER
											     surface. The advice was a dead end that read as help, and
											     a user following it hit the same 422 twice. The control is
											     now on the detail page (`DecisionBar :: brokenGateTerms` +
											     `canOverrideBrokenGate`), so the link below leads
											     somewhere. Keep the two in step: if the control moves, this
											     sentence is wrong again. -->
											{#if brokenTerms.length > 0}
												<div
													data-testid="approval-broken-gate"
													class="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 text-left text-xs text-[var(--color-danger-text)]"
												>
													<p class="font-medium">Broken gate — no answer can release this row.</p>
													<p class="mt-1">
														Its gate terms ({brokenTerms.join(', ')}) describe a defect in the
														process that raised this approval, not a decision anyone can take,
														so approving it is refused. Rejecting it with a reason is the
														correct terminal and is never blocked. A super-admin can override it
														on the
														<a href={`/approvals/${approval.id}`} class="underline">approval page</a>,
														which has a dedicated override field — it takes a
														<code>reason</code> of at least {BROKEN_GATE_OVERRIDE_MIN_REASON}
														characters, separate from any answer, and records it on the approval
														against your name.
													</p>
												</div>
											{:else if answerOffered}
												<!-- ⛔ THE HONEST STATE FOR A ROW THAT ASKS NOTHING. Every
												     measured QUESTION row carries no `open_questions`, and
												     many carry an instrument report
												     (`watchdog_stall_unspecified`) where a question would be.
												     The row is NOT hidden and NOT auto-decided: the server's
												     refusal of an empty approve is real and a human may still
												     be able to answer from the block context. What this says
												     is only what is true — the producer supplied no question,
												     so nothing on the row is answerable on its face, and
												     rejecting with a reason is never blocked. -->
												{#if question.notice}
													<div
														data-testid="approval-question-notice"
														class="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-left text-xs text-[var(--color-warning-text)]"
													>
														{question.notice}
													</div>
												{/if}
												<!-- The answer affordance. State is keyed by approval id
												     (`answerOpen` / `answerDraft`), so opening one drafting
												     box does not open nineteen. -->
												<button
													type="button"
													data-testid="approval-answer-toggle"
													aria-expanded={!!answerOpen[approval.id]}
													aria-controls="approval-answer-{approval.id}"
													onclick={() => toggleAnswerBox(approval.id)}
													disabled={isActing(approval.id) || bulkPending}
													class="px-4 py-2 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
												>
													<!-- ⛔ The label must not assert a question that is not there.
													     On an `unstated` row the notice directly above says the
													     producer asked nothing; calling the control "Answer this
													     question" over that sentence contradicts it. -->
													{answerOpen[approval.id]
														? (demand === 'fix_assertion' ? 'Cancel' : 'Cancel answer')
														: demand === 'fix_assertion'
															? FIX_ASSERTION_TOGGLE
															: question.state === 'unstated'
																? 'Write a response anyway'
																: 'Answer this question'}
												</button>
											{/if}

											{#if answerOffered && answerOpen[approval.id]}
												<div class="text-left">
													<label
														for="approval-answer-{approval.id}"
														class="block text-xs font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
													>
														{demand === 'fix_assertion' ? FIX_ASSERTION_LABEL : 'Your answer'} <span class="text-[var(--color-danger)]">*</span>
													</label>
													<textarea
														id="approval-answer-{approval.id}"
														data-testid="approval-answer-input"
														aria-label="{demand === 'fix_assertion' ? FIX_ASSERTION_ARIA_LABEL : 'Answer'} for approval: {approval.description}"
														rows="4"
														value={answerTextOf(approval.id)}
														oninput={(e) => (answerDraft[approval.id] = e.currentTarget.value)}
														disabled={isActing(approval.id) || bulkPending}
														placeholder={demand === 'fix_assertion'
															? FIX_ASSERTION_PLACEHOLDER
															: 'Answer the question in full sentences — this text is what the card is re-driven with.'}
														class="w-full px-3 py-2 text-sm border border-[var(--color-border-strong)] rounded-md shadow-sm focus:outline-none focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
													></textarea>
													<!-- ⛔ The contract is stated HERE, beside the box, and it
													     comes from the shared constant — never from the row.
													     Only the newer of the two description formats carries
													     anything resembling it, so a reader told to "see the
													     request" is being sent to a field that, on most of this
													     queue, says nothing about what an answer has to contain. -->
													<!-- ⛔ ANSWER_CONTRACT ONLY WHERE IT IS TRUE. It says the answer
													     "returns the card to TODO to be re-driven", which is the
													     QUESTION callback's behaviour and nothing else's. On an
													     `unrouted` row (a stated question with no deblock_action)
													     the text is persisted and forwarded but no card action
													     runs, so printing this sentence there would promise a
													     re-drive the wire cannot carry. That row gets
													     `question.notice` instead, which states exactly what does
													     and does not happen. -->
													<!-- ⛔ `question.answerDemanded`, NOT `needsAnswer`. `needsAnswer`
													     is now the UNION of "typed QUESTION" and "states a question",
													     and ANSWER_CONTRACT's re-drive claim is true only for the
													     first: `answerDemanded` is exactly the receiver's
													     `deblock_action === 'QUESTION'` rule. Printing the contract
													     on an `unrouted` row would promise a card move the wire
													     cannot carry — the exact thing the block below explains. -->
													{#if demand === 'fix_assertion'}
														<p
															data-testid="approval-fix-contract"
															class="mt-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
														>
															{FIX_ASSERTION_CONTRACT}
														</p>
													{:else if question.answerDemanded}
														<p class="mt-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
															{ANSWER_CONTRACT}
														</p>
													{:else if question.notice}
														<p class="mt-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
															{question.notice}
														</p>
													{/if}
													{#if !answerVerdict.ok}
														<p
															data-testid="approval-answer-refusal"
															role="status"
															class="mt-2 text-xs text-[var(--color-warning-text)]"
														>
															{answerVerdict.reason}
														</p>
													{/if}
												</div>
											{/if}

											{#if consequence}
												<p
													data-testid="approval-move-consequence"
													class="mb-2 text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
												>
													{consequence}
												</p>
											{/if}

											<div class="flex gap-2">
												<!-- ⭐ The Approve button KEEPS the exact label "Approve" on
												     every non-QUESTION row: on those rows
												     nothing about the decision has changed. Only the QUESTION
												     row's button is relabelled, because on that row the click
												     genuinely does something else: it carries the answer. -->
												{#if answerOffered && answerOpen[approval.id]}
													<button
														type="button"
														data-testid="approval-answer-submit"
														onclick={() => submitAnswer(approval.id)}
														disabled={isActing(approval.id) || bulkPending || !answerVerdict.ok}
														class="flex-1 px-4 py-2 bg-[var(--color-success)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-success)] transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
													>
														{#if isActing(approval.id)}
															<svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
																<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
																<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
															</svg>
														{/if}
														{demand === 'fix_assertion' ? FIX_ASSERTION_SUBMIT : 'Answer & approve'}
													</button>
												{:else}
													<!-- ⛔ Disabled, not hidden, on an unopened QUESTION row. The
													     server refuses an empty-answer approve on these with no
													     override, so this button cannot succeed; leaving it
													     live would offer a click whose only outcome is a 422 —
													     and before that server rule existed, the same click
													     SPENT the approval and stranded the card in BLOCKED
													     with `approval_answer_missing`. 463 of 491 decided
													     QUESTION rows carry a NULL comment for exactly this
													     reason. The title says where the working control is.

													     ⭐ A BROKEN GATE NOW DISABLES IT TOO, AND THAT IS THE CLICK THE
													     BUG REPORT CAME FROM. The old condition was `needsAnswer &&
													     brokenTerms.length === 0`, so on a broken-gate row the whole
													     clause was FALSE and this button stayed live — its only
													     possible outcome a 422. A user clicked exactly this, read the
													     refusal, followed its advice to the approval page, and found no
													     override field there either. Both halves are fixed: the button
													     no longer offers an impossible gesture, and the override it
													     names now exists on the detail page. -->
													<button
														onclick={() => handleApprove(approval.id)}
														disabled={isActing(approval.id) || brokenTerms.length > 0 || needsAnswer}
														data-testid="approval-approve"
														title={brokenTerms.length > 0
															? `This row's gate terms (${brokenTerms.join(', ')}) describe a defect in the process that raised it, so the server refuses every approve on it. Reject it with a reason, or — as a super-admin — override it on the approval page, which has a dedicated override field.`
															: demand !== null
															? answerlessApproveTitle(demand)
															: (moveNotice ?? consequence)}
														class="px-4 py-2 bg-[var(--color-success)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-success)] transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
													>
														{#if isActing(approval.id)}
															<svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
																<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
																<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
															</svg>
														{/if}
														{moveTarget ? `Approve — move to ${moveTarget}` : 'Approve'}
													</button>
												{/if}
												<button
													onclick={() => openRejectModal(approval.id)}
													disabled={isActing(approval.id)}
													class="px-4 py-2 bg-[var(--color-danger)] text-[var(--color-on-primary)] rounded-lg hover:opacity-90 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
												>
													Reject
												</button>
											</div>
										</div>
									{:else}
										{@const myDecision = (approval.decisions ?? []).find(d => d.approver_id === auth.user?.id)}
										<div class="flex-shrink-0 max-w-[16rem] text-right" data-testid="approval-readonly-note">
											<p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
												{#if myDecision}
													You've {myDecision.decision === 'rejected' ? 'rejected' : 'approved'} this — awaiting the other approver(s).
												{:else}
													Awaiting sign-off from {outstandingApprovers(approval) || 'the assigned approver(s)'}.
														<span class="block mt-1" data-testid="approval-readonly-identity">
															Signed in as {auth.user?.name ?? auth.user?.email ?? 'this account'} · workspace {workspaces.active?.name ?? 'unknown'} — not on this roster.
														</span>
														<!-- ⛔ "Awaiting sign-off from 3f2a1c9d" reads as a
														     colleague who is merely slow. On this cohort it is
														     nobody: every pending QUESTION row names a uuid
														     that 404s in Keycloak, and `approverLabel()` falls
														     back to that uuid — formerly to its first 8
														     characters, which is what manufactured the
														     impression of a person.
														     Waiting is then the one action guaranteed not to
														     work, and the note has to say so — the row is not
														     stuck, it is misaddressed, and `canActOnApproval`
														     matches on ROLE as well as user id, so a role
														     holder can still decide it. -->
														{#if approverUnresolvable(approval)}
															{@const requiredRole = requiredRoleOf(approval)}
															<span class="block mt-1" data-testid="approval-approver-unresolvable">
																The assigned approver's account cannot be resolved — the roster
																carries a user id with no name and no email behind it, so no
																named person can act on this row and waiting for one will not
																clear it. It is decidable only by someone holding the required
																role{requiredRole ? ` (${requiredRole})` : ''}.
															</span>
														{/if}
												{/if}
											</p>
										</div>
									{/if}
								{/if}
							</div>

							<!-- ⭐ THE ROW SURVIVED ITS OWN DECISION, so the outcome belongs
							     INSIDE it rather than in a receipt standing where it used to
							     be. This is the `not-attempted` case above all: the approval
							     needs another approver, so the row is still pending and still
							     on screen, and "the card has not moved" has to be read next to
							     the row it is true of. Same testid as the receipt — one
							     outcome channel, two placements. -->
							{#if rowReceipt}
								<div
									data-testid="approval-callback-notice"
									data-approval-id={approval.id}
									data-callback-outcome={rowReceipt.notice.state}
									data-callback-delivered={rowReceipt.notice.delivered ? 'true' : 'false'}
									role={rowReceipt.notice.tone === 'error' ? 'alert' : 'status'}
									class="mt-3 rounded-lg border px-4 py-3 text-sm {noticeToneClass(
										rowReceipt.notice.tone
									)}"
								>
									<p>{rowReceipt.notice.message}</p>
									<button
										type="button"
										onclick={() => dismissReceipt(approval.id)}
										data-testid="approval-callback-notice-dismiss"
										class="mt-2 text-xs underline opacity-80 hover:opacity-100"
									>
										Dismiss
									</button>
								</div>
							{/if}
						</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Reject Modal -->
{#if showRejectModal}
	<div class="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
		<!-- Background overlay -->
		<div class="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
			<div
				class="fixed inset-0 bg-[var(--color-surface-strong)] bg-opacity-75 transition-opacity"
				aria-hidden="true"
				onclick={closeRejectModal}
			></div>

			<!-- Center modal -->
			<span class="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

			<div class="inline-block align-bottom bg-[var(--color-bg)] rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full dark:bg-[var(--color-surface)]">
				<div class="bg-[var(--color-bg)] px-4 pt-5 pb-4 sm:p-6 sm:pb-4 dark:bg-[var(--color-surface)]">
					<div class="sm:flex sm:items-start">
						<div class="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-[var(--color-danger-bg)] sm:mx-0 sm:h-10 sm:w-10 dark:bg-[var(--color-danger-bg)]/30">
							<svg class="h-6 w-6 text-[var(--color-danger)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
							</svg>
						</div>
						<div class="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left flex-1">
							<h3 class="text-lg leading-6 font-medium text-[var(--color-text)] dark:text-[var(--color-text)]" id="modal-title">
								{#if rejectingSelection}
									Reject {selectedApprovals.length}
									{selectedApprovals.length === 1 ? 'Approval Request' : 'Approval Requests'}
								{:else}
									Reject Approval Request
								{/if}
							</h3>
							{#if rejectingSelection}
								<p class="mt-1 text-sm text-[var(--color-text-muted)]" data-testid="reject-modal-bulk-note">
									This one reason is recorded on every selected request.
								</p>
							{/if}
							<div class="mt-4">
								<label for="reject-reason" class="block text-sm font-medium text-[var(--color-text)] mb-2 dark:text-[var(--color-text-muted)]">
									Reason for rejection <span class="text-[var(--color-danger)]">*</span>
								</label>
								<textarea
									id="reject-reason"
									bind:value={rejectReason}
									rows="4"
									class="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-md shadow-sm focus:outline-none focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
									placeholder="Please provide a detailed reason for rejecting this request..."
								></textarea>
								<p class="mt-2 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
									This reason will be visible to the requester and other approvers.
								</p>
							</div>
						</div>
					</div>
				</div>
				<div class="bg-[var(--color-surface)] px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse gap-3 dark:bg-[var(--color-bg)]">
					<button
						type="button"
						data-testid="reject-modal-confirm"
						onclick={handleReject}
						disabled={!rejectReason.trim() || actionLoading.size > 0 || bulkPending}
						class="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-[var(--color-danger)] text-base font-medium text-[var(--color-on-primary)] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-danger)] sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{#if actionLoading.size > 0}
							<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-[var(--color-text)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
							</svg>
						{/if}
						Reject Request
					</button>
					<button
						type="button"
						onclick={closeRejectModal}
						disabled={actionLoading.size > 0 || bulkPending}
						class="mt-3 w-full inline-flex justify-center rounded-md border border-[var(--color-border-strong)] shadow-sm px-4 py-2 bg-[var(--color-bg)] text-base font-medium text-[var(--color-text)] hover:bg-[var(--color-surface)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--color-accent)] sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed dark:border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
					>
						Cancel
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
