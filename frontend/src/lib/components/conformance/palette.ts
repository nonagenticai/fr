// Architecture-conformance overlay palette — four edge categories from the
// `/architecture/tools/conformance` upstream tool (matched / missing / extra /
// illegal) plus two node kinds (application_component / artifact). Raw hex
// because the values are written into SVG attributes, mirroring
// `components/traceability/palette.ts`. Legend reuses these exact values.

export type ConformanceEdgeKind = 'matched' | 'missing' | 'extra' | 'illegal';

export type ConformanceNodeKind = 'application_component' | 'artifact';

export const EDGE_COLORS: Record<ConformanceEdgeKind, string> = {
  matched: '#10b981', // green — designed AND realized
  missing: '#f59e0b', // amber — designed, not realized
  extra: '#3b82f6', // blue  — realized, not designed
  illegal: '#ef4444', // red   — layer-order violation
};

export const EDGE_LABELS: Record<ConformanceEdgeKind, string> = {
  matched: 'Matched (designed + realized)',
  missing: 'Missing (designed, not realized)',
  extra: 'Extra (realized, not designed)',
  illegal: 'Illegal (layer-order violation)',
};

/** Dashed strokes for negative-finding edges so the legend stays accessible
 *  for colour-blind operators. Matched/extra are solid; missing dashes;
 *  illegal is the bolder hazard pattern. */
export const EDGE_DASH: Record<ConformanceEdgeKind, string | null> = {
  matched: null,
  missing: '5 3',
  extra: null,
  illegal: '2 2',
};

export const NODE_COLORS: Record<ConformanceNodeKind, string> = {
  application_component: '#6366f1', // indigo — as-designed
  artifact: '#6b7280', // gray   — as-built
};

export const NODE_LABELS: Record<ConformanceNodeKind, string> = {
  application_component: 'Application Component',
  artifact: 'Artifact (code-binding)',
};

/** Render order for the legend. */
export const EDGE_ORDER: ConformanceEdgeKind[] = [
  'matched',
  'missing',
  'extra',
  'illegal',
];

export const NODE_ORDER: ConformanceNodeKind[] = [
  'application_component',
  'artifact',
];

export function edgeColor(kind: ConformanceEdgeKind): string {
  return EDGE_COLORS[kind];
}

export function nodeColor(kind: ConformanceNodeKind): string {
  return NODE_COLORS[kind] ?? NODE_COLORS.artifact;
}
