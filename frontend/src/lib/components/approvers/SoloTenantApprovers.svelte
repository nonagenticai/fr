<script lang="ts" module>
	import type { TenantMember } from '$lib/api/tenant-members';

	// ── ONE GOVERNANCE RULE, ONE FILE ────────────────────────────────────────────
	//
	// George, verbatim: "if a tenant has one member, that tenant member is the
	// default god of that tenant. period."
	//
	// ⛔ THIS FILE IS THE ONLY PLACE THAT RULE MAY BE SPELLED. It used to live in
	// `project-request/ApproverPicker.svelte` alone, correctly, while THREE other
	// approver surfaces — the procedure-lens QueueSignoffDialog (since deleted),
	// `improvement/workflows/WorkflowPromotionDialog` and
	// `improvement/workflows/WorkflowCanaryActionDialog` — each read
	// `listTenantMembers()` for themselves and each carried a comment saying the
	// vocabulary had been "taken verbatim" from ApproverPicker. Three verbatim
	// copies of a governance rule is three places for it to drift, and the three
	// dialogs had ALREADY drifted: none of them applied the rule at all, so a solo
	// tenant was shown an unticked roster of one and its Submit refused with
	// "Select at least one approver."
	//
	// ⚠️ The four surfaces are NOT one picker and must not be forced into one. The
	// three dialogs carry a hand-entered-user-id escape hatch and a four-state
	// (loading / unreadable / empty / ready) directory contract, both of which are
	// repairs with their own tests and their own documented defects; ApproverPicker
	// has neither and ProjectForm must not grow them. So what is shared is THE
	// RULE — the predicate, the chosen ids, and the visible control that states
	// them — not the whole component.

	/** True iff the tenant has at least two DISTINCT members. */
	export function shouldShowApprovers(members: TenantMember[]): boolean {
		return new Set(members.map((m) => m.id)).size >= 2;
	}

	/**
	 * True iff the directory named EXACTLY ONE distinct member — George's case.
	 *
	 * ⚠️ Deliberately NOT `!shouldShowApprovers(...)`: that is also true for ZERO
	 * members, which is a different fact. ApproverPicker treats zero as "you, the
	 * caller" because its form has no other way to name an approver; the three
	 * improvement dialogs treat zero as a directory that named nobody and offer
	 * the paste-a-user-id hatch. One member is the only case
	 * on which all four agree, so it is the only case that is shared.
	 */
	export function isSoloTenant(members: TenantMember[]): boolean {
		return new Set(members.map((m) => m.id)).size === 1;
	}

	/**
	 * WHO signs off when there is nobody to route to.
	 *
	 * Exactly one member ⇒ that member, because the directory named them and an id
	 * the tenant does not contain is an approver nobody can ever discharge. Nobody
	 * named ⇒ the caller, who is still the one deciding. Nobody named and no
	 * caller ⇒ nothing, never a fabricated id.
	 */
	export function soloApproverIds(members: TenantMember[], currentUserId: string): string[] {
		const ids = [...new Set(members.map((m) => m.id))];
		if (ids.length === 1) return ids;
		if (currentUserId) return [currentUserId];
		return [];
	}

	/** name, else email, else `<id> (unresolved)`. */
	export function labelFor(m: TenantMember): string {
		if (m.name && m.name.trim()) return m.name;
		if (m.email && m.email.trim()) return m.email;
		return `${m.id} (unresolved)`;
	}
</script>

<script lang="ts">
	interface Props {
		/** The roster AS THE DIRECTORY GAVE IT. Zero or one distinct member. */
		members: TenantMember[];
		/** The viewer, for the `(you)` marker and the zero-member fallback row. */
		currentUserId?: string;
		/**
		 * The fieldset's own heading, or `null` when the CALLER already labels the
		 * group. The three improvement dialogs render their own "Required
		 * approvers" span above this control, and a second legend underneath it
		 * would label the same field twice.
		 */
		legend?: string | null;
	}

	let { members, currentUserId = '', legend = 'Approvers' }: Props = $props();
</script>

<!-- ── THE SOLO TENANT SEES THE PICKER, WITH A COMMERCIAL NUDGE ───────────────────
     This used to be `<span hidden data-testid="approvers-single-user"></span>`: the
     roster was force-set to the caller and the user was shown NOTHING, so the one
     field on the form that decides who signs off was invisible and unexplained.

     ⛔ THIS IS NOT A WARNING, AND THE WORDING IS THE POINT. A tenant with one member
     means that member is BOTH the tenant-admin and the tenant-user, so there is no
     second party to route to and nothing whatsoever to caution them about. Copy that
     said "this tenant has 1 member" or carried a ⚠ would be scolding someone for a
     configuration that is correct for them, and telling them about functionality they
     have no use for. More seats is the product's growth path, so this says what MORE
     members would buy — a feature, not an apology. Backend parity:
     `routes/approvals.ts` exempts exactly this case from the requester-is-decider
     refusal and records it as an explicit `self_decision`.

     ⚠️ `data-testid="approvers-single-user"` IS KEPT, moved to the new visible
     element.

     The checkbox is `disabled` because the value is a FACT, not a choice: unchecking
     the only member would submit an empty roster, which the backend has no approver
     to satisfy. It is rendered rather than omitted so the form states who will sign
     off. -->
<fieldset class="space-y-2" data-testid="approvers-single-user">
	{#if legend}
		<legend
			class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
			>{legend}</legend
		>
	{/if}
	{#each members as m (m.id)}
		<label
			class="flex items-center gap-2 text-sm text-[var(--color-text)]"
			data-testid="approver-option-{m.id}"
		>
			<input type="checkbox" value={m.id} checked disabled />
			<span>{labelFor(m)}</span>
			{#if m.id === currentUserId}
				<span class="text-xs text-[var(--color-text-muted)]">(you)</span>
			{/if}
		</label>
	{:else}
		<!-- ⚠️ ApproverPicker routes ZERO members here as well as one, and it still
		     sets the roster to the caller in that case, so a legend with no row
		     underneath would show an empty approver list while submitting a
		     non-empty one — the UI contradicting the value it is about to send.
		     Name the caller instead. -->
		<label
			class="flex items-center gap-2 text-sm text-[var(--color-text)]"
			data-testid="approver-option-{currentUserId}"
		>
			<input type="checkbox" value={currentUserId} checked disabled />
			<span>You</span>
		</label>
	{/each}
	<p
		class="text-sm rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] px-3 py-2"
		data-testid="approvers-grow-tenant"
	>
		Add more members to your workspace and approvals, questions and other requests can be
		routed straight to the right people in your organization.
		<a class="underline font-medium" href="/admin/members">Invite members</a>
	</p>
</fieldset>
