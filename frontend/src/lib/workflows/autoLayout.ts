/**
 * autoLayout.ts — dagre-based fallback layout for the workflows canvas.
 *
 * n8n stores `position: [x, y]` per node; we render verbatim. Some
 * workflows (especially auto-generated or naively-imported ones) land
 * multiple nodes on the same coordinates, producing visible overlap.
 *
 * `detectOverlap` flags that case so the canvas can opt-in to dagre.
 * `dagreLayout` returns a new position map keyed by node id; sticky
 * notes are excluded — they're free-floating annotations whose
 * positions should be honored as-is.
 */

import dagre from '@dagrejs/dagre';
import type { FlowNode, FlowEdge } from './adapter';

export interface LayoutOptions {
  /** dagre `rankdir`. 'LR' matches n8n's left-to-right convention. */
  rankdir?: 'LR' | 'TB';
  /** Horizontal spacing between ranks (between left/right neighbours). */
  ranksep?: number;
  /** Vertical spacing between nodes in the same rank. */
  nodesep?: number;
  /** Per-node bounding-box width used for layout math. */
  nodeWidth?: number;
  /** Per-node bounding-box height used for layout math. */
  nodeHeight?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  rankdir: 'LR',
  ranksep: 90,
  nodesep: 40,
  nodeWidth: 200,
  nodeHeight: 80,
};

/**
 * Returns true when any two non-sticky nodes share enough screen-space
 * that their bounding boxes overlap. Sticky notes are excluded because
 * they're large annotation rectangles and routinely sit behind other
 * nodes by design.
 */
export function detectOverlap(
  nodes: readonly FlowNode[],
  nodeWidth = DEFAULTS.nodeWidth,
  nodeHeight = DEFAULTS.nodeHeight,
): boolean {
  const flow = nodes.filter((n) => n.type !== 'sticky');
  for (let i = 0; i < flow.length; i++) {
    for (let j = i + 1; j < flow.length; j++) {
      const a = flow[i]!;
      const b = flow[j]!;
      const overlapsX =
        a.position.x < b.position.x + nodeWidth &&
        a.position.x + nodeWidth > b.position.x;
      const overlapsY =
        a.position.y < b.position.y + nodeHeight &&
        a.position.y + nodeHeight > b.position.y;
      if (overlapsX && overlapsY) return true;
    }
  }
  return false;
}

/**
 * Run dagre over the non-sticky nodes + edges and return a {id → position}
 * map. Sticky nodes are not present in the result — callers should keep
 * their original positions.
 *
 * Pure function: does not mutate `nodes` or `edges`.
 */
export function dagreLayout(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  opts: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const o = { ...DEFAULTS, ...opts };
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: o.rankdir, ranksep: o.ranksep, nodesep: o.nodesep });
  g.setDefaultEdgeLabel(() => ({}));

  const flowIds = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'sticky') continue;
    flowIds.add(n.id);
    g.setNode(n.id, { width: o.nodeWidth, height: o.nodeHeight });
  }

  for (const e of edges) {
    if (flowIds.has(e.source) && flowIds.has(e.target)) {
      g.setEdge(e.source, e.target);
    }
  }

  dagre.layout(g);

  const out = new Map<string, { x: number; y: number }>();
  for (const id of flowIds) {
    const node = g.node(id);
    if (!node) continue;
    // dagre returns the centre point; xyflow expects the top-left.
    out.set(id, {
      x: node.x - o.nodeWidth / 2,
      y: node.y - o.nodeHeight / 2,
    });
  }
  return out;
}
