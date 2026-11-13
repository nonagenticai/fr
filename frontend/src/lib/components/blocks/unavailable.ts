// unavailable.ts
// =============
// Presentation helpers for read-model blocks that resolved `available:false`.
// A block is unavailable for one of four honest reasons, carried on
// `meta.unavailable_kind`: nothing selected yet, no data for this selection, a
// known upstream data gap, or a genuine transient failure. `deriveBlockLabel`
// shows copy that matches the actual state instead of collapsing all of them to
// "temporarily unavailable" (the F-1 mis-copy). The muted card also names the
// source + freshness — never a fake value. Pure — unit-tested.

import type { BlockMeta } from '$lib/types/read-model';

const SOURCE_LABELS: Record<string, string> = {
  'fr-db': 'Workspace database',
  planka: 'Board (Planka)',
  n8n: 'Automation (n8n)',
  'worker-management': 'Workers',
  metering: 'Quality metering',
  kag: 'Knowledge graph',
  requirements: 'Requirements',
  artifacts: 'Artifacts',
  composed: 'Composed view',
};

/** Human-readable name for a block's source. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Short, honest reason line for an unavailable block, keyed on
 * `meta.unavailable_kind`:
 *  - 'no_selection' → prompt to pick something (the page shows the noun)
 *  - 'no_data'      → the curated "nothing recorded for this selection" reason
 *  - 'data_gap'     → the curated "not captured upstream" reason
 *  - 'error'        → generic "temporarily unavailable" (never leak `error` text)
 * The curated `meta.error` reasons are author-written (safe to show on the
 * operator surfaces); only genuine `error`-kind failures stay generic. Blocks
 * with no `unavailable_kind` (legacy / frontend-fabricated fallbacks) keep the
 * old behaviour.
 */
export function deriveBlockLabel(meta: BlockMeta): string {
  const src = sourceLabel(meta.source);
  const reason = meta.error?.trim();
  switch (meta.unavailable_kind) {
    case 'no_selection':
      return 'Select an item to view this.';
    case 'no_data':
      return reason ? capitalize(reason) : `${src} has no data for this selection.`;
    case 'data_gap':
      return reason ? capitalize(reason) : `${src} isn't captured upstream yet.`;
    case 'no_evidence':
      return reason ? capitalize(reason) : `${src} holds no evidence for this.`;
    case 'error':
      return `${src} is temporarily unavailable.`;
    default:
      return reason ? `${src} is temporarily unavailable.` : `${src} isn't reporting this yet.`;
  }
}
