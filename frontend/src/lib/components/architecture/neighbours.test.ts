import { describe, it, expect } from 'vitest';
import { computeNeighbours } from './neighbours';

const nodes = [
	{ id: 'a', label: 'A' },
	{ id: 'b', label: 'B' },
	{ id: 'c', label: 'C' }
];
const edges = [
	{ source: 'a', target: 'b', type: 'imports' },
	{ source: 'a', target: 'c' }, // no type → defaults
	{ source: 'b', target: 'a', type: 'calls' },
	{ source: 'a', target: 'b', type: 'imports' }, // duplicate → deduped
	{ source: 'a', target: 'a' }, // self-loop → ignored
	{ source: 'a', target: 'zzz' } // dangling endpoint → dropped
];

describe('computeNeighbours', () => {
	it('returns empty when nothing selected', () => {
		expect(computeNeighbours(nodes, edges, null)).toEqual({ outgoing: [], incoming: [] });
	});

	it('resolves outgoing + incoming, dedupes, skips self-loops and dangling edges', () => {
		const n = computeNeighbours(nodes, edges, 'a');
		expect(n.outgoing).toEqual([
			{ id: 'b', label: 'B', type: 'imports' },
			{ id: 'c', label: 'C', type: 'dependency' }
		]);
		expect(n.incoming).toEqual([{ id: 'b', label: 'B', type: 'calls' }]);
	});

	it('a leaf with only inbound edges has empty outgoing', () => {
		const n = computeNeighbours(nodes, edges, 'c');
		expect(n.outgoing).toEqual([]);
		expect(n.incoming).toEqual([{ id: 'a', label: 'A', type: 'dependency' }]);
	});
});
