<script lang="ts">
	// The decision bar (demo `.decisionbar`): approve / request-changes / reject
	// + a comment that travels with the work (becomes part of the Decision asset).
	// Presentational + event-emitting; the parent wires the PUT /api/approvals/:id
	// call and any phase advance. Once a decision is made the bar collapses to the
	// outcome line (driven by the `decided` prop).
	//
	// Two layouts, one component. The default is the historic one: three buttons,
	// with an OPTIONAL unlabelled comment box underneath. On a QUESTION approval
	// (`answerRequired`) that layout is the bug — the comment is not commentary
	// there, it IS the answer the callback forwards, and a comment placed below the
	// buttons makes "click Approve" the natural gesture. So when `answerRequired`
	// the box is promoted to a labelled textarea ABOVE the buttons and Approve is
	// held disabled until it validates. Reject / Request changes stay live: a
	// rejection is a legitimate answer to a question and the server exempts it.
	import {
		validateAnswer,
		validateOverrideReason,
		ANSWER_CONTRACT,
		BROKEN_GATE_OVERRIDE_MIN_REASON,
		FIX_ASSERTION_CONTRACT,
		FIX_ASSERTION_ARIA_LABEL,
		FIX_ASSERTION_LABEL,
		FIX_ASSERTION_PLACEHOLDER
	} from '$lib/approvals/question';
	import type { AnswerDemand, QuestionState } from '$lib/approvals/question';
	import type { DecisionNotice } from '$lib/approvals/decision-callback';
	import { reclassifyMoveNotice } from '$lib/approvals/question';
	import { validateReclassify, type ReclassifyChoice } from '$lib/approvals/reclassify';
	import {
		isLinkRef,
		type CoverageArtifact,
		type CoverageChoice,
		type CoverageCriterion,
	} from '$lib/approvals/coverage';

	export type Decision = 'approve' | 'changes' | 'reject';

	interface Props {
		/**
		 * The bar's own generic prompt, e.g. "Do you approve this contract?".
		 * ⛔ This is NOT the system's question on a QUESTION approval — it is
		 * chrome. Do not repurpose it to carry the question being answered.
		 */
		question: string;
		/** When set, the bar renders the resolved outcome instead of the buttons. */
		/**
		 * ⚠️ `notice` is OPTIONAL ON PURPOSE, and its absence is not a success.
		 * On first render the page derives `decided` from the row's stored status
		 * alone — nobody observed a callback, so there is nothing truthful to say
		 * about one. After a decision made HERE, `notice` is always present and is
		 * the only field that knows whether the card actually moved.
		 */
		decided?: { kind: Decision; message: string; notice?: DecisionNotice } | null;
		/** Disable the buttons while the decision request is in flight. */
		busy?: boolean;
		/**
		 * True when approving this row means ANSWERING it — the comment is the
		 * answer, and an empty one strands the card. Promotes the comment to a
		 * labelled textarea above the buttons and gates Approve on it.
		 */
		answerRequired?: boolean;
		/**
		 * The sentence printed above the answer box. Defaults to
		 * {@link ANSWER_CONTRACT}, which says the answer "returns the card to TODO
		 * to be re-driven" — TRUE only where the callback branches on
		 * `deblock_action === 'QUESTION'`.
		 *
		 * ⛔ PASS `null` WHERE THAT SENTENCE WOULD BE A LIE. `answerRequired` is now
		 * the union of "typed QUESTION" and "states a question", so a row that states
		 * a question while proposing NO action also gets this box — and on that row
		 * the text is persisted and forwarded but no card move runs. Printing the
		 * default there would promise a re-drive the wire cannot carry. The caller
		 * states the truth for that shape itself (`UNROUTED_QUESTION_NOTICE`) and
		 * passes `null` so the same claim is not made twice, once wrongly.
		 */
		answerContract?: string | null;
		/**
		 * The row's question shape, so the EMPTY-ANSWER REFUSAL can describe this row.
		 * Undefined keeps the QUESTION-typed wording, which is what every pre-existing
		 * caller means.
		 */
		questionState?: QuestionState;
		/**
		 * WHY the text is demanded (`answerDemandOf`). It selects the WORDING of the
		 * box, never whether it renders — `answerRequired` still decides that.
		 *
		 * ⛔ `'fix_assertion'` (an INFRASTRUCTURE / DEPENDENCY approve, which re-drives
		 * the card to TODO) gets its own label, contract, placeholder and refusal. It
		 * must never inherit the QUESTION copy: nobody asked that row a question, and
		 * "Write the answer…" above it is the wrong-message fall-through. It also
		 * OVERRIDES `answerContract`, so a caller that forwards the QUESTION contract by
		 * default cannot put that sentence above a fix box.
		 */
		answerDemand?: AnswerDemand;
		/**
		 * The asker's proposed answer (`proposedAnswerOf`), or null. When set (and RECLASSIFY
		 * is not chosen) it is shown above the answer box and the primary action becomes
		 * "Accept proposed answer", which approves WITH that text as the comment. A typed
		 * answer replaces it ("Approve with my answer"). The empty-answer warning does not
		 * apply and is not shown.
		 */
		proposedAnswer?: string | null;
		/**
		 * The row's BROKEN gate terms (`brokenGateTermsOf`). Non-empty means the server
		 * refuses every approve on this row unless a super-admin supplies an override
		 * `reason` of at least {@link BROKEN_GATE_OVERRIDE_MIN_REASON} characters.
		 *
		 * ⛔ NOT cosmetic. Before this existed the bar rendered a live Approve button on
		 * these rows, the server 422'd, and the page's own advice pointed the reader at an
		 * override field that existed nowhere in the product. Passing the terms is what
		 * lets the bar refuse the gesture instead of the server refusing the click.
		 */
		brokenGateTerms?: string[];
		/**
		 * What APPROVING does to the CARD, in one sentence — from
		 * `approveConsequenceNotice`, which mirrors
		 * `approval-callback.json :: Resolve Target List`.
		 *
		 * ⛔ IT NEVER DISABLES APPROVE. Agreeing with a row the receiver holds is a
		 * legitimate act; the defect this closes was SILENCE, not the button. Measured
		 * 2026-09-13: 458 human approvals, 73 moved a card — the other 385 were held,
		 * and nothing on screen said so.
		 *
		 * `null` means the receiver's behaviour for this action is not mirrored here.
		 * Say nothing rather than guess.
		 */
		approveConsequence?: string | null;
		/**
		 * Whether the viewer may use that override (`auth.isSuperAdmin`). False renders the
		 * refusal WITHOUT an input — there is no text a non-super-admin can type that the
		 * server would accept, so offering a box would be a second dead end.
		 */
		canOverrideBrokenGate?: boolean;
		/**
		 * ⭐ `overrideReason` IS A THIRD ARGUMENT, NOT A SECOND MEANING FOR `comment`. The
		 * server reads `reason` for the #1064 override and `comment` for the answer, and it
		 * now subtracts a reason it consumed as an override from the persisted answer.
		 * Merging them here would re-create, on the client, the conflation that fix removes.
		 */
		/**
		 * REALIGN R5 — the card-type roster when this row may be RECLASSIFIED, else
		 * null/absent (no control rendered). The caller decides eligibility
		 * (`reclassifyEligible`) and loads the roster (`GET /api/card-types`).
		 */
		reclassifyCardTypes?: readonly string[] | null;
		/** The card's current type, excluded from the picker and refused if chosen. */
		currentCardType?: string | null;
		/**
		 * The text demand once RECLASSIFY is the FINAL action — `answerDemandOf(row,
		 * 'approved', 'RECLASSIFY')`. While RECLASSIFY is chosen it REPLACES
		 * `answerRequired`/`answerDemand`: the server keys the demand on the action it
		 * receives, so a QUESTION row switched to RECLASSIFY owes no answer.
		 */
		reclassifyAnswerDemand?: AnswerDemand;
		/**
		 * ⭐ `reclassify` IS A FOURTH ARGUMENT, present only on an approve with
		 * RECLASSIFY chosen. Reject / request-changes never carry it.
		 */
		/**
		 * COVERAGE (BDD ruling 2026-10-01) — the row's criteria when it is a coverage
		 * sign-off, else null/absent (no list rendered). Each gets a "gap" checkbox.
		 */
		coverageCriteria?: readonly CoverageCriterion[] | null;
		/** The coverage request's artifacts, shown as links beside the criteria. */
		coverageArtifacts?: readonly CoverageArtifact[];
		/**
		 * `coverage` IS A FIFTH ARGUMENT, present on every decision of a COVERAGE row
		 * (approve, reject and request-changes) — the ticked gaps travel with each.
		 */
		onDecide?: (
			kind: Decision,
			comment: string,
			overrideReason?: string,
			reclassify?: ReclassifyChoice,
			coverage?: CoverageChoice,
		) => void;
	}

	let {
		question,
		decided = null,
		busy = false,
		answerRequired = false,
		answerContract = ANSWER_CONTRACT,
		questionState = undefined,
		answerDemand = null,
		proposedAnswer = null,
		brokenGateTerms = [],
		approveConsequence = null,
		canOverrideBrokenGate = false,
		reclassifyCardTypes = null,
		currentCardType = null,
		reclassifyAnswerDemand = null,
		coverageCriteria = null,
		coverageArtifacts = [],
		onDecide,
	}: Props = $props();
	let rejectedCriteria = $state<string[]>([]);
	const coverageChoice = (): CoverageChoice | undefined =>
		coverageCriteria && coverageCriteria.length > 0
			? { rejectedCriterionIds: [...rejectedCriteria] }
			: undefined;
	function toggleRejected(id: string, on: boolean) {
		rejectedCriteria = on
			? [...rejectedCriteria.filter((x) => x !== id), id]
			: rejectedCriteria.filter((x) => x !== id);
	}
	let comment = $state('');
	let overrideReason = $state('');
	let reclassifyOn = $state(false);
	let newCardType = $state('');
	const reclassifyOptions = $derived(
		(reclassifyCardTypes ?? []).filter((t) => t !== currentCardType),
	);
	const reclassifyRefusal = $derived(
		reclassifyOn ? validateReclassify(newCardType, currentCardType, reclassifyCardTypes) : null,
	);
	// Once RECLASSIFY is chosen, the consequence line states the reclassify move rather
	// than the stored action's — that is what approving will now do to the card.
	const shownConsequence = $derived(
		reclassifyOn ? reclassifyMoveNotice(newCardType || null) : approveConsequence,
	);

	// ⭐ THE DEMAND FOLLOWS THE FINAL ACTION, NOT THE STORED ONE. Choosing RECLASSIFY
	// swaps in the demand the server computes for the action it will actually receive.
	const effectiveDemand = $derived(reclassifyOn ? reclassifyAnswerDemand : answerDemand);
	const effectiveAnswerRequired = $derived(
		reclassifyOn ? reclassifyAnswerDemand !== null : answerRequired,
	);

	// Only consulted in the answerRequired layout; the default layout keeps the
	// comment optional exactly as before.
	const answerCheck = $derived(
		effectiveAnswerRequired
			? validateAnswer(comment, questionState, effectiveDemand)
			: { ok: true, reason: null },
	);
	const fixAssertion = $derived(effectiveDemand === 'fix_assertion');
	// A proposal is offered only on the stored action (a RECLASSIFY is a different decision)
	// and only where that action is a QUESTION: a fix assertion (INFRASTRUCTURE/DEPENDENCY)
	// owes a statement of what was fixed, and its contract must never be hidden by a proposal.
	const shownProposal = $derived(
		!reclassifyOn && effectiveDemand === 'question_action' ? proposedAnswer : null,
	);
	// The contract warns that an empty answer spends the approval — not true with a proposal.
	const shownContract = $derived(
		shownProposal ? null : fixAssertion ? FIX_ASSERTION_CONTRACT : answerContract,
	);
	// A broken gate is a property of the ROW, so it gates Approve on its own, independently
	// of whether the row also demands an answer. On this estate the two never coincide
	// (measured 2026-09-13: 174 broken-gate rows, 132 answer-demanding, intersection 0),
	// but the component must not assume that — a row carrying both must satisfy both.
	//
	// ⚠️ ONE-DIRECTIONAL, AND SAFE IN THAT DIRECTION. `BROKEN_GATE_TERMS` here is a SUBSET
	// of the server's (it unions `APPROVAL_BROKEN_GATE_TERMS` from its env, invisible to the
	// browser), so every row this disables IS one the server would refuse. The converse can
	// still happen and still 422s — unchanged, and never presented as "the server will accept".
	const brokenGate = $derived(brokenGateTerms.length > 0);
	const overrideCheck = $derived(
		brokenGate
			? validateOverrideReason(overrideReason, canOverrideBrokenGate)
			: { ok: true, reason: null },
	);
	// ⛔ BOTH gates, independently. An override argument is not an answer and an answer is
	// not an override argument; a row carrying both demands both, and collapsing them to
	// one check would let either satisfy the other.
	const approveBlocked = $derived(
		(effectiveAnswerRequired && !answerCheck.ok) ||
			(brokenGate && !overrideCheck.ok) ||
			reclassifyRefusal !== null,
	);
</script>

{#if decided}
	<!--
		⛔ RENDER THE NOTICE, NOT THE INTENT, WHEN THEY DISAGREE.
		`decided.message` states what the decision MEANT ("Approved — the system
		advances the phase."). `decided.notice` states what actually HAPPENED. They
		agree on the happy path and diverge exactly when it matters.
		An audit caught this one layer below the toast fix: the failure toast
		expires after 12s, and once it did, this line was the ONLY text left on
		screen — still asserting the card had moved. A message that outlives its
		correction is worse than no message.
	-->
	{@const undelivered = decided.notice && !decided.notice.delivered}
	<div
		class="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] border p-3.5 text-sm shadow-[var(--shadow-sm)] {undelivered
			? 'border-[var(--color-warning-border,var(--color-border-strong))] bg-[var(--color-warning-bg,var(--color-bg))]'
			: 'border-[var(--color-border-strong)] bg-[var(--color-bg)]'}"
		data-testid="decisionbar-outcome"
		data-delivered={decided.notice ? String(decided.notice.delivered) : 'unobserved'}
	>
		<span
			class={undelivered ? 'font-bold text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}
		>{undelivered ? decided.notice!.message : decided.message}</span>
	</div>
{:else}
	<div
		class="flex flex-wrap items-center gap-2.5 rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-bg)] p-3.5 shadow-[var(--shadow-sm)]"
	>
		{#if brokenGate}
			<!--
				FIRST in the bar, above even the answer box, because it is the gate that
				decides whether any of the rest can succeed. This panel replaces prose that
				used to sit on the QUEUE page telling the reader an override existed and
				linking them here — where no such field had ever been built.
			-->
			<div
				class="basis-full space-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-3 text-left"
				data-testid="decisionbar-broken-gate"
				data-terms={brokenGateTerms.join(',')}
			>
				<p class="text-sm font-bold text-[var(--color-danger-text)]">
					Broken gate — approving is refused
				</p>
				<p class="text-xs text-[var(--color-danger-text)]">
					Its gate terms ({brokenGateTerms.join(', ')}) describe a defect in the process that
					raised this approval, not a decision anyone can take. Rejecting it with a reason is
					the correct terminal and is never blocked.
				</p>
				{#if canOverrideBrokenGate}
					<label class="block space-y-1.5 pt-1">
						<span class="block text-xs font-bold text-[var(--color-danger-text)]">
							Super-admin override — state why ({BROKEN_GATE_OVERRIDE_MIN_REASON}+ characters)
						</span>
						<textarea
							bind:value={overrideReason}
							disabled={busy}
							rows="2"
							aria-label="Reason for overriding this broken gate"
							aria-invalid={!overrideCheck.ok}
							data-testid="decisionbar-override-input"
							placeholder="Why you are signing off on a gate that could not be constructed. Recorded on the approval against your name."
							class="block w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-2 text-sm"
						></textarea>
					</label>
				{/if}
				{#if !overrideCheck.ok && overrideCheck.reason}
					<p class="text-xs text-[var(--color-danger-text)]" data-testid="decisionbar-override-refusal">
						{overrideCheck.reason}
					</p>
				{/if}
			</div>
		{/if}
		{#if shownProposal}
			<!-- The asker's proposed answer, ABOVE the answer box: accepting it is the primary action. -->
			<div
				class="basis-full space-y-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3"
				data-testid="decisionbar-proposed-answer"
			>
				<p class="text-sm font-bold text-[var(--color-text)]">Proposed answer</p>
				<p class="whitespace-pre-wrap text-sm text-[var(--color-text)]">{shownProposal}</p>
				<p class="text-xs text-[var(--color-text-muted)]">
					Accepting sends this text as your answer. To answer differently, write it below.
				</p>
			</div>
		{/if}
		{#if effectiveAnswerRequired}
			<!-- ABOVE the buttons, deliberately: the answer is the decision. -->
			<label class="basis-full space-y-1.5" data-answer-demand={effectiveDemand ?? 'unspecified'}>
				<span class="block text-sm font-bold text-[var(--color-text)]" data-testid="decisionbar-answer-label"
					>{shownProposal
						? 'Or write a different answer'
						: fixAssertion
							? FIX_ASSERTION_LABEL
							: 'Your answer'}</span
				>
				{#if shownContract}
					<span class="block text-xs text-[var(--color-text-muted)]" data-testid="decisionbar-answer-contract"
						>{shownContract}</span
					>
				{/if}
				<textarea
					bind:value={comment}
					disabled={busy}
					rows="3"
					aria-label={fixAssertion ? FIX_ASSERTION_ARIA_LABEL : 'Your answer to this question'}
					aria-invalid={approveBlocked}
					data-testid="decisionbar-answer-input"
					placeholder={fixAssertion
						? FIX_ASSERTION_PLACEHOLDER
						: 'Write the answer — this is what is sent back and what releases the card.'}
					class="block w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-2 text-sm"
				></textarea>
			</label>
			{#if approveBlocked && answerCheck.reason && !shownProposal}
				<p
					class="basis-full text-xs text-[var(--color-danger-text)]"
					data-testid="decisionbar-answer-refusal"
				>
					{answerCheck.reason}
				</p>
			{/if}
		{/if}
		{#if reclassifyCardTypes && reclassifyCardTypes.length > 0}
			<!-- REALIGN R5: choose RECLASSIFY and the new card type. Approve stays disabled
			     until a known type other than the current one is picked. -->
			<div class="basis-full space-y-1.5" data-testid="decisionbar-reclassify">
				<label class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
					<input
						type="checkbox"
						bind:checked={reclassifyOn}
						disabled={busy}
						data-testid="decisionbar-reclassify-toggle"
					/>
					Reclassify — change this card's type and send it back to TODO
				</label>
				{#if reclassifyOn}
					<select
						bind:value={newCardType}
						disabled={busy}
						aria-label="New card type"
						aria-invalid={reclassifyRefusal !== null}
						data-testid="decisionbar-reclassify-select"
						class="block w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-sm"
					>
						<option value="">Choose a card type…</option>
						{#each reclassifyOptions as t (t)}
							<option value={t}>{t}</option>
						{/each}
					</select>
					{#if reclassifyRefusal}
						<p class="text-xs text-[var(--color-danger-text)]" data-testid="decisionbar-reclassify-refusal">
							{reclassifyRefusal}
						</p>
					{/if}
				{/if}
			</div>
		{/if}
		{#if coverageCriteria && coverageCriteria.length > 0}
			<!-- COVERAGE (BDD ruling 2026-10-01): approve = covered, reject = a gap, per
			     criterion. Ticked criteria are sent as rejected_criterion_ids on any decision. -->
			<div class="basis-full space-y-1.5" data-testid="decisionbar-coverage">
				<p class="text-sm font-semibold text-[var(--color-text)]">
					Coverage sign-off — tick each criterion that is a GAP
				</p>
				<ul class="space-y-1">
					{#each coverageCriteria as c (c.criterion_id)}
						<li class="text-sm">
							<label class="flex items-start gap-2">
								<input
									type="checkbox"
									checked={rejectedCriteria.includes(c.criterion_id)}
									onchange={(e) => toggleRejected(c.criterion_id, e.currentTarget.checked)}
									disabled={busy}
									data-testid="decisionbar-coverage-reject"
									data-criterion-id={c.criterion_id}
								/>
								<span>
									<span class="font-mono text-xs">{c.criterion_id}</span>
									{#if c.text}— {c.text}{/if}
									<span class="block text-xs text-[var(--color-text-muted)]">
										scenario: {c.scenario_id ?? 'none'}{#if c.reason_not_computed}
											· not computed: {c.reason_not_computed}{/if}
									</span>
								</span>
							</label>
						</li>
					{/each}
				</ul>
				{#if coverageArtifacts.length > 0}
					<ul class="text-xs" data-testid="decisionbar-coverage-artifacts">
						{#each coverageArtifacts as art (art.ref)}
							<li>
								{art.kind ?? 'artifact'}:
								{#if isLinkRef(art.ref)}
									<a href={art.ref} target="_blank" rel="noopener noreferrer" class="underline">{art.ref}</a>
								{:else}
									<span class="font-mono">{art.ref}</span>
								{/if}
								{#if art.sha}<span class="font-mono"> @{art.sha}</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}
		{#if shownConsequence}
			<!--
				⛔ IN THE SHARED CONTAINER, NOT INSIDE `{#if answerRequired}`, and ABOVE
				the button row — the whole point is that it is read BEFORE the click.
				Both layouts show it; neither gates on it. It states what approving does
				to the CARD, which no surface on this page said at all.
			-->
			<p
				class="basis-full text-xs text-[var(--color-text-muted)]"
				data-testid="decision-approve-consequence"
			>
				{shownConsequence}
			</p>
		{/if}
		<span class="mr-auto text-sm font-bold">{question}</span>
		{#if shownProposal}
			<button
				type="button"
				disabled={busy || (brokenGate && !overrideCheck.ok)}
				data-testid="decisionbar-accept-proposal"
				onclick={() =>
					coverageChoice()
						? onDecide?.(
								'approve',
								shownProposal,
								brokenGate ? overrideReason : undefined,
								undefined,
								coverageChoice(),
							)
						: onDecide?.('approve', shownProposal, brokenGate ? overrideReason : undefined)}
				class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
			>
				✓ Accept proposed answer
			</button>
		{/if}
		<button
			type="button"
			disabled={busy || approveBlocked}
			onclick={() =>
				// The fourth argument exists ONLY on a reclassify — every other approve keeps
				// its three-argument shape, so callers matching on arity are unaffected.
				reclassifyOn
					? onDecide?.('approve', comment, brokenGate ? overrideReason : undefined, {
							newCardType,
						})
					: coverageChoice()
						? onDecide?.(
								'approve',
								comment,
								brokenGate ? overrideReason : undefined,
								undefined,
								coverageChoice(),
							)
						: onDecide?.('approve', comment, brokenGate ? overrideReason : undefined)}
			class={shownProposal
				? 'inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold hover:bg-[var(--color-surface)] disabled:opacity-50'
				: 'inline-flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50'}
		>
			{shownProposal && effectiveAnswerRequired ? '✓ Approve with my answer' : '✓ Approve'}
		</button>
		<button
			type="button"
			disabled={busy}
			onclick={() =>
				coverageChoice()
					? onDecide?.('changes', comment, undefined, undefined, coverageChoice())
					: onDecide?.('changes', comment)}
			class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold hover:bg-[var(--color-surface)] disabled:opacity-50"
		>
			Request changes
		</button>
		<button
			type="button"
			disabled={busy}
			onclick={() =>
				coverageChoice()
					? onDecide?.('reject', comment, undefined, undefined, coverageChoice())
					: onDecide?.('reject', comment)}
			class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold text-[var(--color-danger-text)] hover:bg-[var(--color-danger-bg)] disabled:opacity-50"
		>
			Reject
		</button>
		{#if !effectiveAnswerRequired}
			<input
				bind:value={comment}
				disabled={busy}
				placeholder="Add a comment — your reasoning travels with the work (becomes part of the Decision)"
				class="basis-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-2 text-sm"
			/>
		{/if}
	</div>
{/if}
