<script lang="ts">
	import { authFetch } from '$lib/api/auth-fetch';
	import type { CardTypeDescription } from './types';

	interface Props {
		card_type: string;
	}

	let { card_type }: Props = $props();

	let desc = $state<CardTypeDescription | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let expanded = $state(false);
	let loaded = $state(false);

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			const res = await authFetch(`/api/card-types/${encodeURIComponent(card_type)}`);
			if (!res.ok) {
				// A type the tenant's catalogue does not define — a 404 is expected, not an error.
				error = res.status === 404 ? 'none' : `HTTP ${res.status}`;
				return;
			}
			desc = (await res.json()) as CardTypeDescription;
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to load';
		} finally {
			loading = false;
		}
	}

	// Lazy: fetch only when the panel is first opened. Fetching on mount fired a
	// console 404 on every card whose type has no protocol (George's report).
	function toggle(): void {
		expanded = !expanded;
		if (expanded && !loaded && card_type) {
			loaded = true;
			void load();
		}
	}

	// The tenant's RM card type attributes (requirements_management catalogue).
	const sections = $derived(
		desc
			? [
					{ key: 'inputs', label: 'Inputs', items: desc.inputs },
					{ key: 'outputs', label: 'Outputs', items: desc.outputs },
					{ key: 'acceptance', label: 'Acceptance', items: desc.acceptance },
					{ key: 'rules', label: 'Rules', items: desc.rules },
				]
			: [],
	);
</script>

<section class="space-y-2">
	<button
		type="button"
		class="flex items-center justify-between w-full text-left text-xs uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
		onclick={toggle}
		aria-expanded={expanded}
	>
		<span>Card type</span>
		<span class="font-mono">{expanded ? '−' : '+'}</span>
	</button>
	{#if expanded}
		{#if loading}
			<p class="text-xs text-[var(--color-text-muted)] italic">Loading…</p>
		{:else if error === 'none'}
			<p class="text-xs text-[var(--color-text-muted)] italic">This card type is not in this workspace's catalogue.</p>
		{:else if error}
			<p class="text-xs text-[var(--color-danger)]">Error: {error}</p>
		{:else if desc}
			<p class="text-xs text-[var(--color-text-muted)]">
				{desc.card_type_description}
			</p>
			{#if desc.capability}
				<p class="text-xs text-[var(--color-text-muted)]">Capability: {desc.capability.title}</p>
			{/if}
			{#each sections as p (p.key)}
				<details class="border border-[var(--color-border)] rounded">
					<summary
						class="cursor-pointer px-2 py-1 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
					>
						{p.label}
						<span class="ml-1 text-[var(--color-text-muted)] font-normal">({p.items.length})</span>
					</summary>
					{#if p.items.length === 0}
						<p class="px-3 py-1.5 text-xs text-[var(--color-text-muted)] italic">None recorded.</p>
					{:else}
						<ul class="px-3 py-1.5 space-y-0.5 text-xs list-disc list-inside">
							{#each p.items as item (item)}
								<li class="text-[var(--color-text)]">{item}</li>
							{/each}
						</ul>
					{/if}
				</details>
			{/each}
		{/if}
	{/if}
</section>
