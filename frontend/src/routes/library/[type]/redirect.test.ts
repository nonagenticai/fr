// +page.ts load: governance kinds 308-redirect to the canonical /{plural}
// AssetWorkspace surface; the lens stays for kag_document/workflow/channel/trigger.

import { describe, it, expect } from 'vitest';
import { load } from './+page';

function redirectOf(type: string): { status?: number; location?: string } {
  try {
    // Minimal shape — load() only reads params.type.
    const res = load({ params: { type } } as never);
    return { status: undefined, location: undefined, ...(res as object) };
  } catch (e) {
    // SvelteKit redirect() throws a { status, location } object.
    return e as { status: number; location: string };
  }
}

describe('/library/[type] +page.ts redirect', () => {
  it.each([
    ['requirement', '/requirements'],
    ['requirements', '/requirements'],
    ['principle', '/principles'],
    ['principles', '/principles'],
    ['decision', '/decisions'],
    ['decisions', '/decisions'],
  ])('308-redirects governance slug %s → %s', (type, dest) => {
    const r = redirectOf(type);
    expect(r.status).toBe(308);
    expect(r.location).toBe(dest);
  });

  it.each(['kag_document', 'workflow', 'workflows', 'channel', 'channels', 'trigger'])(
    'does NOT redirect non-governance slug %s',
    (type) => {
      const r = redirectOf(type);
      expect(r.status).toBeUndefined();
    },
  );
});
