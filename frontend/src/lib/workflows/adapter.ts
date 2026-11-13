/**
 * adapter.ts — pure transform from n8n workflow JSON to Svelte Flow shape.
 *
 * Pure function only — no Svelte imports — so it can be unit-tested in
 * isolation and reused server-side if we ever pre-render thumbnails.
 *
 * Spec: docs/superpowers/plans/2026-05-09-workflows-viewer.md (Task 3).
 *
 * n8n's runtime stores `connections` as a 4-deep nested structure:
 *   connections[<srcNodeName>][<outputType>][<outputIndex>][<i>] = {
 *     node: <dstNodeName>, type: <inputType>, index: <inputIndex>
 *   }
 *
 * The most common <outputType> / <inputType> is "main"; nodes like
 * `Code` (Run-Once-For-Each-Item) or AI agents can have other types
 * but those don't render distinct visual handles in the viewer today.
 * The adapter covers `main` only and silently drops the rest — when the
 * spec asks us to render them we can add a second pass without a
 * breaking shape change.
 */

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters?: Record<string, unknown>;
}

interface N8nConnectionLeaf {
  node: string;
  type: string;
  index: number;
}

export interface N8nWorkflow {
  id?: string;
  name?: string;
  nodes: N8nNode[];
  connections: Record<string, Record<string, N8nConnectionLeaf[][]>>;
}

export type FlowNodeKind = 'n8n' | 'sticky';

/**
 * Per-node diff status the workflow-improvement graph-diff view paints onto a
 * node (backend `workflow-graph-diff.ts` `NodeDiffStatus`, mirrored here so the
 * viewer has no dependency on the improvement types). Undefined ⇒ the node is
 * rendered plain (the default for the standalone /workflows viewer, which never
 * passes a diff map).
 */
export type NodeDiffStatus =
  | 'unchanged'
  | 'added'
  | 'changed'
  | 'removed'
  | 'failing'
  | 'guard';

export interface FlowNode {
  id: string;
  type: FlowNodeKind;
  position: { x: number; y: number };
  data: {
    name: string;
    nodeType: string;
    typeVersion?: number;
    parameters: Record<string, unknown>;
    /** Diff annotation for the two-canvas graph-diff view; unset in the plain viewer. */
    diffStatus?: NodeDiffStatus;
    /** Sticky-note specific — pre-extracted so StickyNote.svelte can render directly. */
    sticky?: {
      content: string;
      width: number;
      height: number;
    };
  };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

const STICKY_TYPE = 'n8n-nodes-base.stickyNote';

function nameToId(nameToIdMap: Map<string, string>, name: string): string | undefined {
  return nameToIdMap.get(name);
}

function buildStickyData(node: N8nNode): FlowNode['data']['sticky'] | undefined {
  const params = node.parameters ?? {};
  const content = typeof params.content === 'string' ? params.content : '';
  const width = typeof params.width === 'number' ? params.width : 240;
  const height = typeof params.height === 'number' ? params.height : 120;
  return { content, width, height };
}

/**
 * @param diffByNodeName Optional map from node NAME → diff status. n8n keys its
 *   `connections` by node name and the backend diff uses name as the identity
 *   key, so name is the stable join. When supplied, each node gets a
 *   `data.diffStatus`; omitted ⇒ plain nodes (the standalone viewer's behaviour).
 */
export function toFlow(
  workflow: N8nWorkflow,
  diffByNodeName?: Record<string, NodeDiffStatus>,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nameToIdMap = new Map<string, string>();
  for (const n of workflow.nodes) nameToIdMap.set(n.name, n.id);

  const nodes: FlowNode[] = workflow.nodes.map((n) => {
    const isSticky = n.type === STICKY_TYPE;
    return {
      id: n.id,
      type: isSticky ? 'sticky' : 'n8n',
      position: { x: n.position[0], y: n.position[1] },
      data: {
        name: n.name,
        nodeType: n.type,
        typeVersion: n.typeVersion,
        parameters: n.parameters ?? {},
        diffStatus: diffByNodeName?.[n.name],
        sticky: isSticky ? buildStickyData(n) : undefined,
      },
    };
  });

  const edges: FlowEdge[] = [];
  for (const [srcName, byType] of Object.entries(workflow.connections ?? {})) {
    const mainOutputs = byType.main;
    if (!Array.isArray(mainOutputs)) continue;
    const srcId = nameToId(nameToIdMap, srcName);
    if (!srcId) continue;
    mainOutputs.forEach((branch, outIdx) => {
      if (!Array.isArray(branch)) return;
      branch.forEach((leaf) => {
        const dstId = nameToId(nameToIdMap, leaf.node);
        if (!dstId) return;
        edges.push({
          id: `${srcId}->${dstId}.${outIdx}.${leaf.index}`,
          source: srcId,
          target: dstId,
          sourceHandle: `main-${outIdx}`,
          targetHandle: `main-${leaf.index}`,
        });
      });
    });
  }

  return { nodes, edges };
}
