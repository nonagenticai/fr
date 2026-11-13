import { describe, it, expect } from 'vitest';
import { detectOverlap, dagreLayout } from './autoLayout';
import type { FlowNode, FlowEdge } from './adapter';

function n(id: string, x: number, y: number, kind: 'n8n' | 'sticky' = 'n8n'): FlowNode {
  return {
    id,
    type: kind,
    position: { x, y },
    data: { name: id, nodeType: 'n8n-nodes-base.set', parameters: {} },
  };
}

function e(source: string, target: string): FlowEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: 'main-0',
    targetHandle: 'main-0',
  };
}

describe('detectOverlap', () => {
  it('returns false when nodes are far apart', () => {
    const nodes = [n('a', 0, 0), n('b', 400, 0), n('c', 0, 200)];
    expect(detectOverlap(nodes)).toBe(false);
  });
  it('returns true when two nodes share the same position', () => {
    const nodes = [n('a', 0, 0), n('b', 0, 0)];
    expect(detectOverlap(nodes)).toBe(true);
  });
  it('returns true when nodes are within one bounding box of each other', () => {
    const nodes = [n('a', 0, 0), n('b', 150, 30)]; // width=200, height=80
    expect(detectOverlap(nodes)).toBe(true);
  });
  it('ignores sticky-note overlaps', () => {
    const nodes = [n('a', 0, 0), n('s', 10, 10, 'sticky')];
    expect(detectOverlap(nodes)).toBe(false);
  });
});

describe('dagreLayout', () => {
  it('lays out a linear chain left-to-right', () => {
    const nodes = [n('a', 0, 0), n('b', 0, 0), n('c', 0, 0)];
    const edges = [e('a', 'b'), e('b', 'c')];
    const positions = dagreLayout(nodes, edges);
    expect(positions.size).toBe(3);
    const a = positions.get('a')!;
    const b = positions.get('b')!;
    const c = positions.get('c')!;
    // LR layout: a.x < b.x < c.x; all on same row.
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
    expect(a.y).toBe(b.y);
    expect(b.y).toBe(c.y);
  });

  it('excludes sticky notes from the position map', () => {
    const nodes = [n('a', 0, 0), n('s', 0, 0, 'sticky')];
    const positions = dagreLayout(nodes, []);
    expect(positions.has('a')).toBe(true);
    expect(positions.has('s')).toBe(false);
  });

  it('drops edges that reference unknown / sticky endpoints', () => {
    const nodes = [n('a', 0, 0), n('b', 0, 0), n('s', 0, 0, 'sticky')];
    // edge to sticky should be ignored; layout still works.
    const edges = [e('a', 'b'), e('a', 's'), e('s', 'b')];
    const positions = dagreLayout(nodes, edges);
    expect(positions.size).toBe(2);
  });
});
