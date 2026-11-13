// Categorical palette for the TOC (Theory-of-Constraints) surface — companion
// to `traceability/palette.ts`. Raw hex because these are written into SVG
// fill/stroke attributes (CSS custom properties don't resolve there) and must
// stay visually distinct; the legend reuses the exact same values so canvas
// and key never drift.

import type { TocTreeType, TocEdgeKind } from '$lib/api/toc';
import { CLR_CATEGORIES, type ClrCategory } from '$lib/api/toc';

/** One accent colour per TOC tree type (drives the type legend + node fill). */
export const TREE_TYPE_COLORS: Record<TocTreeType, string> = {
  io_map: '#10b981', // green — intermediate objectives toward the goal
  evaporating_cloud: '#f59e0b', // amber — conflict resolution
  crt: '#ef4444', // red — current reality (undesirable effects)
  frt: '#3b82f6', // blue — future reality (desired effects)
  prt: '#8b5cf6', // violet — prerequisite tree
  trt: '#06b6d4', // cyan — transition tree
};

export const TREE_TYPE_LABELS: Record<TocTreeType, string> = {
  io_map: 'IO Map',
  evaporating_cloud: 'Evaporating Cloud',
  crt: 'Current Reality Tree',
  frt: 'Future Reality Tree',
  prt: 'Prerequisite Tree',
  trt: 'Transition Tree',
};

export const TREE_TYPE_ORDER: TocTreeType[] = [
  'io_map',
  'evaporating_cloud',
  'crt',
  'frt',
  'prt',
  'trt',
];

export function treeTypeColor(type: string): string {
  return TREE_TYPE_COLORS[type as TocTreeType] ?? '#6b7280';
}

export function treeTypeLabel(type: string): string {
  return TREE_TYPE_LABELS[type as TocTreeType] ?? type;
}

/** Logic-edge colour by relationship semantics. */
export const EDGE_KIND_COLORS: Record<string, string> = {
  necessity: '#2563eb', // blue — "in order to … we must …"
  sufficiency: '#059669', // green — "if … then …"
  conflict: '#dc2626', // red — the D↔D′ tension
  assumption: '#9333ea', // purple — surfaced assumption
};

export function edgeKindColor(kind: TocEdgeKind | string): string {
  return EDGE_KIND_COLORS[kind] ?? '#9ca3af';
}

export function edgeKindDashed(kind: TocEdgeKind | string): boolean {
  return kind === 'conflict' || kind === 'assumption';
}

/** CLR-category meta — short code for compact chips + the canonical order. */
export const CLR_CATEGORY_CODES: Record<ClrCategory, string> = {
  clarity: 'CL',
  entity_existence: 'EE',
  causality_existence: 'CE',
  cause_sufficiency: 'CS',
  additional_cause: 'AC',
  cause_effect_reversal: 'CR',
  predicted_effect_existence: 'PE',
  tautology: 'TT',
};

export const CLR_CATEGORY_ORDER: readonly ClrCategory[] = CLR_CATEGORIES;

/**
 * Severity → token. Reservations are tinted by severity so the lens panel
 * reads at a glance; returns a CSS custom property (theme-tracking).
 */
export type ClrSeverity = 'info' | 'minor' | 'major' | 'blocker' | string;

export function severityTone(severity: ClrSeverity): string {
  switch (severity) {
    case 'blocker':
    case 'major':
      return 'var(--color-danger)';
    case 'minor':
      return 'var(--color-warning)';
    default:
      return 'var(--color-text-muted)';
  }
}

// Re-export the score colour helper so component imports stay in `palette`.
export { qualityScoreColor } from '$lib/api/toc';
