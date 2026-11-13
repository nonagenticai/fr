// Pure derivation: ArchitectureConformanceResult → {nodes, links} for the
// ConformanceOverlayGraph. Unit-tested in derive.test.ts; the Svelte
// component is a thin D3 render over this output (same split as
// `components/traceability/TraceabilityGraph.svelte` + its palette helpers).
//
// Node-shape decisions:
//  - Every element referenced anywhere in the conformance result is one
//    node, deduped by id. Kind = `application_component` if its
//    `element_type` matches, else `artifact`.
//  - Unrealized Application Components and orphan Artifacts are nodes with
//    no incident edges (deliberately visible — they're the finding).
//
// Edge-shape decisions:
//  - matched/missing/extra come from `dependency_conformance.{matched,missing,extra}`.
//  - illegal comes from `illegal_dependencies.illegal_dependencies`.
//  - An edge that appears in BOTH matched and illegal is kept once as
//    `illegal` (illegality wins visually — it is the harder finding).

import type {
  ArchitectureConformanceResult,
  ConformanceEdgePair,
  ConformanceElementRef,
} from '$lib/api/governance';
import type { ConformanceEdgeKind, ConformanceNodeKind } from './palette';

export interface ConformanceGraphNode {
  id: string;
  label: string;
  kind: ConformanceNodeKind;
  layer: string;
  /** True when the element appears in unrealized / orphan lists — render dim. */
  isFinding: boolean;
}

export interface ConformanceGraphLink {
  source: string;
  target: string;
  kind: ConformanceEdgeKind;
  /** Human-readable reason, populated for illegal edges. */
  reason: string | null;
}

export interface ConformanceGraphData {
  nodes: ConformanceGraphNode[];
  links: ConformanceGraphLink[];
}

function nodeKindOf(ref: ConformanceElementRef): ConformanceNodeKind {
  return ref.element_type === 'application_component'
    ? 'application_component'
    : 'artifact';
}

function upsertNode(
  nodes: Map<string, ConformanceGraphNode>,
  ref: ConformanceElementRef,
  isFinding: boolean,
): void {
  const existing = nodes.get(ref.id);
  if (existing) {
    if (isFinding && !existing.isFinding) existing.isFinding = true;
    return;
  }
  nodes.set(ref.id, {
    id: ref.id,
    label: ref.title,
    kind: nodeKindOf(ref),
    layer: ref.layer,
    isFinding,
  });
}

function addPair(
  out: ConformanceGraphLink[],
  pairs: ConformanceEdgePair[],
  kind: ConformanceEdgeKind,
  seen: Map<string, ConformanceEdgeKind>,
): void {
  for (const p of pairs) {
    const key = `${p.source.id}->${p.target.id}`;
    const prior = seen.get(key);
    // Illegality wins; otherwise first one writes. Don't double-add an edge
    // already classified as illegal (the illegal-pass runs LAST below so the
    // overwrite happens only for non-illegal earlier passes).
    if (prior === 'illegal') continue;
    if (prior && prior !== kind) {
      // Overwrite earlier classification only when the new kind is illegal
      // (handled by the dedicated pass below); otherwise keep the first.
      continue;
    }
    seen.set(key, kind);
    out.push({ source: p.source.id, target: p.target.id, kind, reason: null });
  }
}

export function deriveConformanceGraph(
  result: ArchitectureConformanceResult,
): ConformanceGraphData {
  const nodeMap = new Map<string, ConformanceGraphNode>();

  // Realized components: present in the model AND have a binding — neutral.
  for (const e of result.realization_coverage.realized) upsertNode(nodeMap, e, false);
  // Unrealized: designed, not built — finding.
  for (const e of result.realization_coverage.unrealized) upsertNode(nodeMap, e, true);
  // Orphan artifacts: built, no realization edge — finding.
  for (const e of result.realization_coverage.orphan_artifacts) {
    upsertNode(nodeMap, e, true);
  }

  // Dependency-conformance edges contribute every endpoint as a node too.
  const allPairs: { pairs: ConformanceEdgePair[]; kind: ConformanceEdgeKind }[] = [
    { pairs: result.dependency_conformance.matched, kind: 'matched' },
    { pairs: result.dependency_conformance.missing, kind: 'missing' },
    { pairs: result.dependency_conformance.extra, kind: 'extra' },
  ];
  for (const { pairs, kind } of allPairs) {
    for (const p of pairs) {
      upsertNode(nodeMap, p.source, kind === 'missing');
      upsertNode(nodeMap, p.target, kind === 'missing');
    }
  }

  const links: ConformanceGraphLink[] = [];
  const seen = new Map<string, ConformanceEdgeKind>();
  for (const { pairs, kind } of allPairs) addPair(links, pairs, kind, seen);

  // Illegal pass last, with reason capture + overwrite of any prior classification.
  for (const e of result.illegal_dependencies.illegal_dependencies) {
    upsertNode(nodeMap, e.source, true);
    upsertNode(nodeMap, e.target, true);
    const key = `${e.source.id}->${e.target.id}`;
    const prior = seen.get(key);
    if (prior && prior !== 'illegal') {
      const existing = links.find((l) => l.source === e.source.id && l.target === e.target.id);
      if (existing) {
        existing.kind = 'illegal';
        existing.reason = e.reason;
      }
    } else if (!prior) {
      links.push({
        source: e.source.id,
        target: e.target.id,
        kind: 'illegal',
        reason: e.reason,
      });
    }
    seen.set(key, 'illegal');
  }

  return { nodes: [...nodeMap.values()], links };
}
