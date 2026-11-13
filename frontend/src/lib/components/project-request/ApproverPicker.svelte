<script lang="ts" module>
	// ⛔ THE SOLO-TENANT RULE IS NO LONGER SPELLED HERE. It lives in exactly one
	// file — `$lib/components/approvers/SoloTenantApprovers.svelte` — because
	// three other approver surfaces (the procedures queue-signoff dialog and the
	// two workflow dialogs) each carried a hand-written copy of this component's
	// vocabulary, and a governance rule with four authors has four futures.
	//
	// ⚠️ These two names are RE-EXPORTED, not redefined.
	export {
		shouldShowApprovers,
		labelFor,
	} from '$lib/components/approvers/SoloTenantApprovers.svelte';
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listTenantMembers, type TenantMember } from '$lib/api/tenant-members';
	import SoloTenantApprovers, {
		shouldShowApprovers,
		soloApproverIds,
		labelFor,
	} from '$lib/components/approvers/SoloTenantApprovers.svelte';

	interface Props {
		selected: string[];
		currentUserId: string;
	}

	let {
		selected = $bindable([]),
		currentUserId
	}: Props = $props();

	let status = $state<'loading' | 'error' | 'loaded'>('loading');
	let errorMessage = $state<string | null>(null);
	let members = $state<TenantMember[]>([]);

	const showPicker = $derived(status === 'loaded' && shouldShowApprovers(members));

	function reconcile(list: TenantMember[]) {
		if (!shouldShowApprovers(list)) {
			// Single-user tenant: the only possible approver is the caller. The control is
			// still RENDERED (see the `SoloTenantApprovers` branch in the markup) — this
			// line only decides the value, not the visibility. ⚠️ The CHOICE is
			// `soloApproverIds`, shared with the three improvement dialogs, so "who is the
			// god of a one-member tenant" has one answer across the product.
			selected = soloApproverIds(list, currentUserId);
			return;
		}
		const ids = new Set(list.map((m) => m.id));
		const kept = selected.filter((id) => ids.has(id));
		if (kept.length === 0) {
			selected = ids.has(currentUserId) ? [currentUserId] : [];
		} else if (kept.length !== selected.length) {
			selected = kept;
		}
	}

	async function load() {
		status = 'loading';
		errorMessage = null;
		try {
			const list = await listTenantMembers();
			// De-duplicate by id, preserving server order (unresolved last).
			const seen = new Set<string>();
			const unique = list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
			members = unique;
			reconcile(unique);
			status = 'loaded';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			status = 'error';
		}
	}

	function toggle(id: string, checked: boolean) {
		if (checked) {
			if (!selected.includes(id)) selected = [...selected, id];
		} else {
			selected = selected.filter((s) => s !== id);
		}
	}

	onMount(() => {
		void load();
	});
</script>

{#if status === 'loading'}
	<p class="text-sm text-[var(--color-text-muted)]" data-testid="approvers-loading">Loading tenant members…</p>
{:else if status === 'error'}
	<div
		class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded-lg p-4"
		data-testid="approver-error"
		role="alert"
	>
		<p class="text-[var(--color-danger-text)] font-medium">Could not load tenant members</p>
		<p class="text-[var(--color-danger)] text-sm">{errorMessage}</p>
		<button
			type="button"
			data-testid="approver-retry"
			onclick={() => void load()}
			class="mt-2 px-4 py-2 bg-[var(--color-surface)] text-[var(--color-text)] rounded-lg hover:bg-[var(--color-surface-strong)] transition-colors"
		>Retry</button>
	</div>
{:else if !showPicker}
	<!-- ⭐ ONE RULE, ONE COMPONENT. The fieldset, the checked+disabled checkbox, the
	     `(you)` marker, the zero-member fallback row and the commercial nudge all
	     moved verbatim into `SoloTenantApprovers` — same markup, same
	     `data-testid`s — so the three improvement dialogs render the IDENTICAL
	     control instead of each re-deriving it. The wording rationale travelled
	     with it; read it there before changing a word of it. -->
	<SoloTenantApprovers {members} {currentUserId} />
{:else}
	<fieldset class="space-y-2" data-testid="approver-picker">
		<legend class="block text-sm font-medium text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Approvers</legend>
		{#each members as m (m.id)}
			<label
				class="flex items-center gap-2 text-sm {m.resolved ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}"
				data-testid="approver-option-{m.id}"
			>
				<input
					type="checkbox"
					value={m.id}
					checked={selected.includes(m.id)}
					onchange={(e) => toggle(m.id, (e.currentTarget as HTMLInputElement).checked)}
				/>
				<span>{labelFor(m)}</span>
				{#if !m.resolved}
					<span class="text-xs px-2 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-text-muted)]">unresolved</span>
				{/if}
				{#if m.id === currentUserId}
					<span class="text-xs text-[var(--color-text-muted)]">(you)</span>
				{/if}
			</label>
		{/each}
	</fieldset>
{/if}
