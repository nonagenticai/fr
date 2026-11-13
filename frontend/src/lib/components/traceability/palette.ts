// Categorical palette for the traceability graph — one colour per 5D
// dimension. These are raw hex because they are written into SVG <circle
// fill=…> attributes (CSS custom properties don't resolve there) and must stay
// visually distinct across dimensions — the same reasoning as the code-graph
// ArchitectureGraph layer palette. The legend reuses these exact values so the
// canvas and key never drift.

import type { TraceDimension } from '$lib/api/traceability';

export const DIMENSION_COLORS: Record<TraceDimension, string> = {
  architecture: '#3b82f6', // blue
  requirement: '#10b981', // green
  decision: '#f59e0b', // amber
  principle: '#8b5cf6', // violet
  pm: '#06b6d4', // cyan
  other: '#6b7280', // gray
};

export const DIMENSION_LABELS: Record<TraceDimension, string> = {
  architecture: 'Architecture',
  requirement: 'Requirements',
  decision: 'Decisions',
  principle: 'Principles',
  pm: 'Project Mgmt',
  other: 'Other',
};

/** Render order for the legend (matches the canonical 5D order). */
export const DIMENSION_ORDER: TraceDimension[] = [
  'principle',
  'requirement',
  'decision',
  'architecture',
  'pm',
  'other',
];

export function dimensionColor(dimension: string): string {
  return DIMENSION_COLORS[dimension as TraceDimension] ?? DIMENSION_COLORS.other;
}
