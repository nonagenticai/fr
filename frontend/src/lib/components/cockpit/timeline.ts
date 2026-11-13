// timeline.ts
// ==========
// Pure helpers for the LiveExecutionTimeline: the customer-safe "kicker" label
// for each event type, and the URL-synced type filter vocabulary + predicate.
// The timeline renders the flat backend events truthfully — the mock's embedded
// 5D asset-strip and per-inference stack are surfaced by dedicated blocks
// (asset_usage → AssetUseStrip), not fabricated into event rows here.

import type { TimelineEvent, TimelineEventType } from '$lib/types/cockpit';

const KICKER: Record<TimelineEventType, string> = {
  phase_transition: 'Card phase transition',
  asset_fetch: 'Seeker / 5D asset pull',
  worker_inference: 'Narrow worker inference',
  typed_action: 'Typed n8n action',
  qa_verdict: 'QA verdict',
  decision_write: 'Decision',
  kag_write: 'Knowledge memory write',
};

export function eventKicker(type: TimelineEventType): string {
  return KICKER[type] ?? type;
}

/** The timeline filter options — `'all'` plus each event type, in display order. */
export const TIMELINE_FILTERS = [
  'all',
  'phase_transition',
  'worker_inference',
  'typed_action',
  'qa_verdict',
  'decision_write',
  'kag_write',
] as const;

export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

export function filterEvents(events: TimelineEvent[], filter: TimelineFilter): TimelineEvent[] {
  if (filter === 'all') return events;
  return events.filter((e) => e.type === filter);
}
