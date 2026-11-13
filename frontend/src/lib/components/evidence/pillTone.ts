// pillTone.ts
// ==========
// Map a backend timeline-pill tone onto a `ui/Tag.svelte` tone. Load-bearing:
// the backend emits `'warn'` but the Tag primitive's tone is `'warning'`, so a
// naive pass-through would silently fall through to neutral styling. Pure —
// unit-tested.

import type { TimelinePillTone } from '$lib/types/cockpit';

/** Tone vocabulary accepted by `ui/Tag.svelte`. */
export type TagTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function pillTone(tone: TimelinePillTone): TagTone {
  switch (tone) {
    case 'warn':
      return 'warning';
    case 'success':
      return 'success';
    case 'danger':
      return 'danger';
    case 'neutral':
    default:
      return 'neutral';
  }
}
