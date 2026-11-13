<script lang="ts" module>
	import { stratifyTree, type TocGraph } from '$lib/api/toc';

	// The decompose↔recompose node — the trust surface that IS the product:
	// your request decomposed into TOC nodes, rolled back up to the deliverable.
	// Fed from /api/assets/toc/:treeId/graph (the BFS node+edge graph flattened
	// into this nesting by the caller).
	//
	// ⛔ `kind` USED to be a closed union `goal|epic|enabler|feature|card`, and
	// the only producer derived it from a node's DEPTH in the tree. None of
	// those five words except `goal` is a value the upstream ever writes:
	// `toc_nodes.node_kind` holds necessary_condition (5,811), csf (4,171),
	// goal (1,912), requirement/prerequisite/assumption/injection/objective
	// (32 between them) across 11,926 rows. So every badge below the root was a
	// label invented by the renderer and shown where a measured field belongs.
	// `kind` is now that measured field, verbatim, and `null` when the upstream
	// recorded none.

	/**
	 * The TOC node kinds this component gives a colour to. `IntegrityNode.kind`
	 * is a free `string` — this union is a STYLING table, not a validator, and an
	 * unlisted kind renders neutral rather than being replaced.
	 *
	 * The members are the measured vocabulary of `requirements_api.toc_nodes`
	 * (11,926 rows): necessary_condition 5,811 · csf 4,171 · goal 1,912 ·
	 * requirement 8 · prerequisite 8 · assumption 6 · injection 6 · objective 4.
	 */
	export type IntegrityKind =
		| 'goal'
		| 'objective'
		| 'csf'
		| 'necessary_condition'
		| 'requirement'
		| 'prerequisite'
		| 'assumption'
		| 'injection'
		| 'undesirable_effect';

	export interface IntegrityNode {
		/**
		 * `toc_nodes.node_kind` as recorded upstream, verbatim. `null` ⇒ the
		 * upstream recorded no kind — the badge SAYS so rather than guessing.
		 */
		kind: string | null;
		label: string;
		/** Roll-up completeness 0–100, or null/undefined when none is recorded. */
		rollup?: number | null;
		/** Status text shown instead of a bar (e.g. "awaiting decision"). */
		status?: string | null;
		blocked?: boolean;
		children?: IntegrityNode[];
	}

	/** Human form of a snake_case upstream kind, for the badge. */
	export function kindLabel(kind: string | null | undefined): string {
		const k = (kind ?? '').trim();
		if (!k) return 'kind unknown';
		return k.replace(/[_-]+/g, ' ');
	}

	/**
	 * Flatten a TOC graph into this component's nesting. Pure — unit-tested.
	 *
	 * ⛔ Lives here, not in the page, precisely because the defect it fixes was
	 * untestable while it was a closure inside `+page.svelte`: the page derived
	 * each node's `kind` from its DEPTH, and no test could reach that closure to
	 * say so. `kind` is now `toc_nodes.node_kind` verbatim (null when the
	 * upstream recorded none) and nothing here invents a label.
	 */
	export function buildIntegrityNodes(g: TocGraph): IntegrityNode[] {
		const rows = stratifyTree(g.nodes, g.edges);
		const childrenByParent = new Map<string | null, typeof rows>();
		for (const r of rows) {
			const key = r.parentId;
			if (!childrenByParent.has(key)) childrenByParent.set(key, []);
			childrenByParent.get(key)!.push(r);
		}
		const seen = new Set<string>();
		const build = (row: (typeof rows)[number]): IntegrityNode => {
			seen.add(row.id);
			const kids = (childrenByParent.get(row.id) ?? []).filter((c) => !seen.has(c.id));
			return {
				kind: (row.node.node_kind ?? '').trim() || null,
				label: row.node.title || row.node.statement || row.id,
				// No roll-up is computed anywhere in fr. Explicitly null so the
				// component says "not measured" rather than leaving a blank slot.
				rollup: null,
				children: kids.map((c) => build(c)),
			};
		};
		return (childrenByParent.get(null) ?? []).map((r) => build(r));
	}
</script>

<script lang="ts">
	import Self from './IntegrityTree.svelte';

	interface Props {
		nodes: IntegrityNode[];
		/** Root call renders the left border guide on nested levels only. */
		nested?: boolean;
	}
	let { nodes, nested = false }: Props = $props();

	const KIND_CLASS: Record<string, string> = {
		goal: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-strong)]',
		objective: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-strong)]',
		csf: 'bg-[var(--color-info-bg)] text-[var(--color-info-text)]',
		necessary_condition:
			'bg-[var(--color-secondary-bg)] text-[var(--color-secondary-text)]',
		requirement: 'bg-[var(--color-secondary-bg)] text-[var(--color-secondary-text)]',
		prerequisite: 'bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]',
		assumption: 'bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]',
		injection: 'bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]',
		undesirable_effect: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]',
	};
	// An unstyled kind is still a REAL kind — it gets a neutral badge, not a
	// substituted one. A missing kind gets the dashed "unknown" treatment so it
	// is visibly distinct from a kind we simply have no colour for.
	const NEUTRAL_KIND_CLASS = 'bg-[var(--color-surface)] text-[var(--color-text-muted)]';
	const UNKNOWN_KIND_CLASS =
		'border border-dashed border-[var(--color-border)] bg-transparent text-[var(--color-text-muted)] italic';

	function kindClass(kind: string | null | undefined): string {
		const k = (kind ?? '').trim().toLowerCase();
		if (!k) return UNKNOWN_KIND_CLASS;
		return KIND_CLASS[k] ?? NEUTRAL_KIND_CLASS;
	}

	function barColor(pct: number): string {
		return pct >= 100 ? 'var(--color-success)' : 'var(--color-accent)';
	}
</script>

<div class={nested ? 'ml-6 border-l-2 border-[var(--color-border)] pl-3.5' : ''}>
	{#each nodes as node (node.label)}
		<div
			class="mb-1.5 flex items-center gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5 {node.blocked
				? 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
				: 'border-[var(--color-border)] bg-[var(--color-bg)]'}"
		>
			<span
				class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide {kindClass(
					node.kind,
				)}"
				data-testid="integrity-kind"
			>
				{kindLabel(node.kind)}
			</span>
			<span class="text-sm {node.kind === 'goal' ? 'font-bold' : ''}">{node.label}</span>
			{#if node.blocked}
				<span
					class="rounded-full border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-danger-text)]"
				>
					BLOCKED
				</span>
			{/if}
			<span class="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
				{#if node.status}
					{node.status}
				{:else if node.rollup != null}
					<span
						class="h-1.5 w-[70px] overflow-hidden rounded-full bg-[var(--color-surface-strong)]"
					>
						<span
							class="block h-full rounded-full"
							style="width:{node.rollup}%;background:{barColor(node.rollup)}"
						></span>
					</span>
					{node.rollup >= 100 ? 'done' : `${node.rollup}%`}
				{:else}
					<!--
						No status AND no roll-up. This slot used to render EMPTY, which
						reads as "nothing to report" next to siblings that show a bar —
						and it was the state of EVERY node, because the only producer
						passed `rollup: null` for all of them. No roll-up is computed
						anywhere in fr, so say that, rather than leaving a gap the eye
						fills in. Remove this branch the day a producer supplies a
						measured roll-up, not before.
					-->
					<span
						class="italic opacity-70"
						data-testid="integrity-rollup-unknown"
						title="No roll-up completeness is recorded for this node"
					>
						roll-up not measured
					</span>
				{/if}
			</span>
		</div>
		{#if node.children && node.children.length}
			<Self nodes={node.children} nested={true} />
		{/if}
	{/each}
</div>
