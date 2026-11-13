// Shared colour assignment for the KAG graph — the single source of truth used
// by BOTH the canvas (KagGraphExplorer) and the legend/filter chips
// (KagGraphExploreTab). Previously each computed its own colour: the legend
// keyed a curated palette by `allTypes.indexOf(type)` while the canvas assigned
// the same palette in first-seen call order (and let community keys consume the
// same slots), so the legend swatch and the on-canvas node could drift apart.
//
// Here colour-by-type is deterministic on the SORTED `allTypes` index, so any
// caller passing the same sorted list gets the same colour. Colour-by-community
// uses a SEPARATE palette so a community run never steals a type's colour.

// Curated head for the common type count, then a deterministic HSL hash so any
// overflow label still gets a distinct, repeatable colour. Mid lightness reads
// on both themes.
// eslint-disable-next-line design-tokens
export const TYPE_PALETTE = [
  '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
];

// A deliberately DISJOINT categorical palette (Tableau-10) for communities —
// no hex overlaps TYPE_PALETTE, so "by theme" is visually distinct from
// "by type" and neither ever consumes the other's slots.
// eslint-disable-next-line design-tokens
export const COMMUNITY_PALETTE = [
  '#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab',
];

function hashHsl(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 62% 55%)`;
}

/**
 * Colour for a neo4j node type. Deterministic on the position of `type` within
 * the SORTED `allTypes` list, so the legend and the canvas — given the same
 * sorted list — always agree. Types beyond the curated palette hash to a stable
 * HSL colour.
 */
export function colorForType(type: string, allTypes: string[]): string {
  const idx = allTypes.indexOf(type);
  if (idx >= 0 && idx < TYPE_PALETTE.length) return TYPE_PALETTE[idx]!;
  return hashHsl(type);
}

/** Colour for a community index, from the separate community palette. */
export function colorForCommunity(c: number): string {
  return COMMUNITY_PALETTE[c % COMMUNITY_PALETTE.length] ?? hashHsl(`c${c}`);
}
