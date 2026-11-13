// @vitest-environment jsdom
//
// IntegrityTree — the two places this component showed a value it never
// measured.
//
//  1. THE KIND BADGE. Its only producer derived each node's `kind` from the
//     node's DEPTH in the tree, over ['goal','epic','enabler','feature','card'].
//     Four of those five words are not values the upstream has ever written:
//     measured over `requirements_api.toc_nodes` (11,926 rows) the vocabulary is
//     necessary_condition 5,811 · csf 4,171 · goal 1,912 · requirement 8 ·
//     prerequisite 8 · assumption 6 · injection 6 · objective 4. `node_kind` was
//     on `TocNode` the whole time and the sibling views already read it, so the
//     badge was a renderer-invented taxonomy sitting where a measured field
//     belongs — and it MOVED whenever an edge changed.
//
//  2. THE ROLL-UP BAR. The component's contract promises "roll-up completeness
//     0–100", the only producer passes `rollup: null` for every node, and the
//     slot then rendered EMPTY — which reads as "nothing to report" beside
//     siblings that show a bar. Nothing in fr computes a roll-up, so the honest
//     render is to say that, not to leave a gap the eye fills in.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import IntegrityTree, {
	buildIntegrityNodes,
	kindLabel,
	type IntegrityNode,
} from './IntegrityTree.svelte';
import type { TocGraph, TocNode, TocEdge } from '$lib/api/toc';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) {
		unmount(app);
		app = null;
	}
	host.remove();
});

function node(id: string, kind: string, over: Partial<TocNode> = {}): TocNode {
	return {
		id,
		slug: id,
		tree_id: 'T-1',
		tenant_id: 't',
		title: `title ${id}`,
		statement: `stmt ${id}`,
		node_kind: kind,
		...over,
	};
}

function edge(source: string, target: string): TocEdge {
	return {
		id: `${source}->${target}`,
		slug: `${source}->${target}`,
		tenant_id: 't',
		source_entity_type: 'toc_nodes',
		target_entity_type: 'toc_nodes',
		source_id: source,
		target_id: target,
		relationship_type: 'necessity',
	};
}

/**
 * goal ← csf ← necessary_condition. Edges point prerequisite → objective:
 * MEASURED on prod 2026-10-07, 5711 necessary_condition→csf and 4019 csf→goal
 * edges against 72 the other way. (This fixture used to draw goal→csf→nc and
 * call it the real shape; the tree code agreed with it, which is why the live
 * tree rendered upside-down.)
 */
const REAL_GRAPH: TocGraph = {
	tree: { id: 'T-1', slug: 't-1', title: 'T', tenant_id: 't', tree_type: 'io_map' },
	nodes: [
		node('G', 'goal'),
		node('C', 'csf'),
		node('N', 'necessary_condition'),
	],
	edges: [edge('C', 'G'), edge('N', 'C')],
};

describe('buildIntegrityNodes — the kind is read, not derived', () => {
	it('carries each node\'s OWN node_kind, at every depth', () => {
		const built = buildIntegrityNodes(REAL_GRAPH);
		expect(built).toHaveLength(1);
		const root = built[0]!;
		const child = root.children![0]!;
		const grandchild = child.children![0]!;

		// ⭐ The load-bearing assertion. The depth-derived rule answers
		// 'goal' / 'epic' / 'enabler' for these three positions; only the DEEPER
		// two discriminate, which is why both are asserted.
		expect(root.kind).toBe('goal');
		expect(child.kind).toBe('csf');
		expect(grandchild.kind).toBe('necessary_condition');

		// And none of the fabricated vocabulary leaks through.
		const kinds = [root.kind, child.kind, grandchild.kind];
		expect(kinds).not.toContain('epic');
		expect(kinds).not.toContain('enabler');
	});

	it('does NOT move a node\'s kind when its position in the tree changes', () => {
		// Same three nodes, re-parented flat. Under the depth rule all three
		// become 'goal'; under the measured rule nothing moves. This is the
		// property the old code could not have: a kind that is a fact about the
		// node rather than about the edges around it.
		const flat: TocGraph = { ...REAL_GRAPH, edges: [] };
		const built = buildIntegrityNodes(flat);
		expect(built.map((n) => n.kind)).toEqual(['goal', 'csf', 'necessary_condition']);
	});

	it('reports an ABSENT node_kind as null rather than guessing one', () => {
		const g: TocGraph = { ...REAL_GRAPH, nodes: [node('X', '   ')], edges: [] };
		expect(buildIntegrityNodes(g)[0]!.kind).toBeNull();
	});

	it('leaves rollup null — nothing in fr computes one', () => {
		expect(buildIntegrityNodes(REAL_GRAPH)[0]!.rollup).toBeNull();
	});
});

describe('kindLabel', () => {
	it('renders a snake_case upstream kind readably, verbatim in substance', () => {
		expect(kindLabel('necessary_condition')).toBe('necessary condition');
		expect(kindLabel('csf')).toBe('csf');
	});

	it('says the kind is UNKNOWN rather than substituting a plausible one', () => {
		expect(kindLabel(null)).toBe('kind unknown');
		expect(kindLabel('   ')).toBe('kind unknown');
	});
});

describe('IntegrityTree rendering', () => {
	it('prints the measured kind on the badge, including one it has no colour for', () => {
		const nodes: IntegrityNode[] = [
			{ kind: 'necessary_condition', label: 'NC one', rollup: null },
			// `subordination` is not in KIND_CLASS. An unstyled kind is still a
			// REAL kind and must be printed, not replaced by a styled neighbour.
			{ kind: 'subordination', label: 'Odd one', rollup: null },
		];
		app = mount(IntegrityTree, { target: host, props: { nodes } });
		flushSync();
		const badges = [...host.querySelectorAll('[data-testid="integrity-kind"]')].map((e) =>
			(e.textContent ?? '').trim(),
		);
		expect(badges).toEqual(['necessary condition', 'subordination']);
	});

	it('⛔ says "roll-up not measured" instead of rendering an empty slot', () => {
		app = mount(IntegrityTree, {
			target: host,
			props: { nodes: [{ kind: 'goal', label: 'G', rollup: null }] as IntegrityNode[] },
		});
		flushSync();
		const marker = host.querySelector('[data-testid="integrity-rollup-unknown"]');
		expect(marker).not.toBeNull();
		expect((marker!.textContent ?? '').trim()).toBe('roll-up not measured');
	});

	// ⚠️ The negative control. A marker that appeared unconditionally would pass
	// the test above while destroying the very distinction it exists to make —
	// a measured roll-up and an absent one would look identical again.
	it('does NOT show that marker when a roll-up IS measured', () => {
		app = mount(IntegrityTree, {
			target: host,
			props: { nodes: [{ kind: 'goal', label: 'G', rollup: 40 }] as IntegrityNode[] },
		});
		flushSync();
		expect(host.querySelector('[data-testid="integrity-rollup-unknown"]')).toBeNull();
		expect(host.textContent).toContain('40%');
	});

	it('does NOT show that marker when a status is given instead', () => {
		app = mount(IntegrityTree, {
			target: host,
			props: {
				nodes: [{ kind: 'goal', label: 'G', rollup: null, status: 'awaiting decision' }] as IntegrityNode[],
			},
		});
		flushSync();
		expect(host.querySelector('[data-testid="integrity-rollup-unknown"]')).toBeNull();
		expect(host.textContent).toContain('awaiting decision');
	});
});
