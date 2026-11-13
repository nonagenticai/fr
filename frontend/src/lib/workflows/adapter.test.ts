/**
 * Adapter — n8n workflow JSON → Svelte Flow {nodes, edges}.
 *
 * Spec: docs/superpowers/plans/2026-05-09-workflows-viewer.md (Task 3).
 *
 * The fixture has an IF node with 2 main outputs. The adapter must:
 *   - preserve absolute pixel positions from n8n
 *   - render sticky notes as a separate kind so the canvas can pick a
 *     different svelte component
 *   - emit edges with sourceHandle = `main-<outIdx>` so multi-output nodes
 *     route the right branch to the right downstream node
 */

import { describe, it, expect } from 'vitest';

import { toFlow, type N8nWorkflow } from './adapter';
import fixture from './__fixtures__/multi-output-if.json';

describe('toFlow (n8n → Svelte Flow)', () => {
  // The JSON loader infers position as number[]; our adapter only reads
  // [0] and [1] so the cast is safe.
  const result = toFlow(fixture as unknown as N8nWorkflow);

  it('emits one Svelte-Flow node per n8n node', () => {
    expect(result.nodes).toHaveLength(fixture.nodes.length);
  });

  it('preserves absolute pixel positions', () => {
    const ifNode = result.nodes.find((n) => n.id === 'n-if');
    expect(ifNode).toBeDefined();
    expect(ifNode!.position).toEqual({ x: 0, y: 0 });
    const trueNode = result.nodes.find((n) => n.id === 'n-true');
    expect(trueNode!.position).toEqual({ x: 200, y: -100 });
  });

  it('marks sticky notes with kind=sticky for the canvas dispatcher', () => {
    const sticky = result.nodes.find((n) => n.id === 'n-sticky');
    expect(sticky!.type).toBe('sticky');
    const ifNode = result.nodes.find((n) => n.id === 'n-if');
    expect(ifNode!.type).toBe('n8n');
  });

  it('routes multi-output IF connections via sourceHandle main-<outIdx>', () => {
    const trueEdge = result.edges.find((e) => e.target === 'n-true');
    const falseEdge = result.edges.find((e) => e.target === 'n-false');
    expect(trueEdge).toBeDefined();
    expect(falseEdge).toBeDefined();
    expect(trueEdge!.source).toBe('n-if');
    expect(trueEdge!.sourceHandle).toBe('main-0');
    expect(falseEdge!.sourceHandle).toBe('main-1');
  });

  it('uses targetHandle main-<inIdx>', () => {
    const webhookEdge = result.edges.find((e) => e.source === 'n-webhook');
    expect(webhookEdge!.targetHandle).toBe('main-0');
  });

  it('exposes node name + type + parameters on data', () => {
    const ifNode = result.nodes.find((n) => n.id === 'n-if');
    expect(ifNode!.data.name).toBe('IF');
    expect(ifNode!.data.nodeType).toBe('n8n-nodes-base.if');
    expect((ifNode!.data.parameters as Record<string, unknown>).conditions).toBeDefined();
  });

  it('leaves data.diffStatus undefined when no diff map is passed', () => {
    for (const n of result.nodes) {
      expect(n.data.diffStatus).toBeUndefined();
    }
  });
});

describe('toFlow diff annotation (graph-diff view)', () => {
  // A tiny two-node workflow; the diff map keys by node NAME (the backend
  // NodeDiff.name identity key + n8n's connections key), not id.
  const wf: N8nWorkflow = {
    id: 'wf1',
    name: 'diffable',
    nodes: [
      { id: 'a', name: 'Webhook', type: 'n8n-nodes-base.webhook', position: [0, 0] },
      { id: 'b', name: 'Provision', type: 'n8n-nodes-base.httpRequest', position: [200, 0] },
      { id: 'c', name: 'Gate', type: 'n8n-nodes-base.if', position: [400, 0] },
    ],
    connections: {},
  };

  it('paints diffStatus onto each node keyed by name', () => {
    const out = toFlow(wf, { Provision: 'added', Gate: 'guard' });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('b')!.data.diffStatus).toBe('added');
    expect(byId.get('c')!.data.diffStatus).toBe('guard');
  });

  it('leaves nodes absent from the map with undefined diffStatus', () => {
    const out = toFlow(wf, { Provision: 'changed' });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('a')!.data.diffStatus).toBeUndefined();
    expect(byId.get('b')!.data.diffStatus).toBe('changed');
  });

  it('supports every NodeDiffStatus value', () => {
    const out = toFlow(
      {
        ...wf,
        nodes: [
          { id: '1', name: 'U', type: 't', position: [0, 0] },
          { id: '2', name: 'A', type: 't', position: [0, 0] },
          { id: '3', name: 'C', type: 't', position: [0, 0] },
          { id: '4', name: 'R', type: 't', position: [0, 0] },
          { id: '5', name: 'F', type: 't', position: [0, 0] },
          { id: '6', name: 'G', type: 't', position: [0, 0] },
        ],
      },
      { U: 'unchanged', A: 'added', C: 'changed', R: 'removed', F: 'failing', G: 'guard' },
    );
    const statuses = out.nodes.map((n) => n.data.diffStatus);
    expect(statuses).toEqual(['unchanged', 'added', 'changed', 'removed', 'failing', 'guard']);
  });
});
