// Pure helper for the Architecture map sidebar's "Connections" navigation.
// The as-built code-graph has 100s of nodes, so the Node Details panel lists a
// selected node's inbound/outbound neighbours as clickable links — navigating the
// graph from the sidebar instead of hunting for a node on the canvas.

export interface GraphNodeLike {
	id: string;
	label: string;
}

export interface GraphEdgeLike {
	source: string;
	target: string;
	type?: string;
}

export interface Neighbour {
	id: string;
	label: string;
	type: string;
}

export interface Neighbours {
	/** Nodes this node points to (its dependencies). */
	outgoing: Neighbour[];
	/** Nodes that point to this node (its dependents). */
	incoming: Neighbour[];
}

/**
 * Resolve the inbound/outbound neighbours of `selectedId` from the graph.
 * De-duplicates per neighbour, skips self-loops, and drops dangling edge
 * endpoints (an edge to a node absent from `nodes`).
 */
export function computeNeighbours(
	nodes: GraphNodeLike[],
	edges: GraphEdgeLike[],
	selectedId: string | null | undefined,
): Neighbours {
	if (!selectedId) return { outgoing: [], incoming: [] };
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const outgoing: Neighbour[] = [];
	const incoming: Neighbour[] = [];
	const seenOut = new Set<string>();
	const seenIn = new Set<string>();
	for (const e of edges) {
		if (e.source === selectedId && e.target !== selectedId && !seenOut.has(e.target)) {
			seenOut.add(e.target);
			const t = byId.get(e.target);
			if (t) outgoing.push({ id: t.id, label: t.label, type: e.type ?? 'dependency' });
		}
		if (e.target === selectedId && e.source !== selectedId && !seenIn.has(e.source)) {
			seenIn.add(e.source);
			const s = byId.get(e.source);
			if (s) incoming.push({ id: s.id, label: s.label, type: e.type ?? 'dependency' });
		}
	}
	return { outgoing, incoming };
}
