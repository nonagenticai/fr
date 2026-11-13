<!--
  Band ④ — Split / relations.

  Renders the card's Relations group (parent_card / child_cards / requires /
  required_by) as navigable chips into /cards/{id}, following the
  filter-empty-slots pattern of PrinciplesSection. Frontend-only — the data
  is already in card.groups.Relations.

  v1 renders child chips as links only. A per-child mini-PhaseStrip is
  deferred: it needs each child's list_name, which isn't in the parent
  payload (would require a light per-child fetch).
-->
<script lang="ts">
	import { shortId } from '$lib/utils/shortId';

	interface Props {
		relations: Record<string, string>;
		/** Optional id → card title map (kanbanStore board + the card payload's
		 *  `related_titles`, merged in CardDetailSections). Unnamed ids fall back. */
		titles?: Record<string, string>;
	}
	let { relations, titles = {} }: Props = $props();

	// UI review 2026-10-07: a related card rendered as a bare Planka id. Use the
	// title when one is known, else "Card …<tail>" — the full id stays in the
	// tooltip and the href.
	function cardLabel(id: string): string {
		const t = titles[id]?.trim();
		return t ? t : `Card ${shortId(id)}`;
	}

	// Relation field values may be a single id, a comma/space-separated
	// list, or a JSON array string (depending on how the n8n
	// set-card-relation step wrote them). Split tolerantly into clean ids.
	function ids(value: string | undefined): string[] {
		if (!value || !value.trim()) return [];
		const raw = value.trim();
		if (raw.startsWith('[')) {
			try {
				const arr = JSON.parse(raw);
				if (Array.isArray(arr)) {
					return arr.filter((x) => x != null).map((x) => String(x).trim()).filter(isId);
				}
			} catch {
				// fall through to delimiter split
			}
		}
		return raw
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(isId);
	}
	// fr#1516: "null"/"undefined" (any case) is no relation, not a card id.
	function isId(s: string): boolean {
		return s !== '' && !/^(null|undefined)$/i.test(s);
	}

	const parent = $derived(ids(relations.parent_card));
	const children = $derived(ids(relations.child_cards));
	const requires = $derived(ids(relations.requires));
	const requiredBy = $derived(ids(relations.required_by));

	const groups = $derived(
		[
			{ key: 'parent_card', label: 'Parent', items: parent },
			{ key: 'child_cards', label: 'Children', items: children },
			{ key: 'requires', label: 'Requires', items: requires },
			{ key: 'required_by', label: 'Required by', items: requiredBy },
		].filter((g) => g.items.length > 0),
	);
</script>

<div>
	{#if groups.length === 0}
		<p class="text-sm text-[var(--color-text-muted)] italic">
			No relations — this card is standalone.
		</p>
	{:else}
		<div class="space-y-3">
			{#each groups as g (g.key)}
				<div>
					<h4 class="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
						{g.label}
					</h4>
					<ul class="flex flex-wrap gap-1.5">
						{#each g.items as id (id)}
							<li>
								<a
									class="inline-block rounded border border-[var(--color-border)] px-2 py-0.5 font-mono text-xs text-[var(--color-accent)] hover:bg-[var(--color-accent-bg)] hover:underline"
									href={`/cards/${encodeURIComponent(id)}`}
									title={id}
								>
									{cardLabel(id)}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</div>

		{#if children.length > 0}
			<p class="text-xs text-[var(--color-text-muted)] mt-3 italic">
				Parent progression: this card waits in TODO until every child reaches
				DONE, then advances through QA → DONE.
			</p>
		{/if}
	{/if}
</div>
