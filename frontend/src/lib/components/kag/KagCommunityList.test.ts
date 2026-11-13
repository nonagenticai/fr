// @vitest-environment jsdom
//
// KagCommunityList renders KAG community-detection output. The endpoint gives
// only entity→community assignments (`entityCommunities`) and optional
// per-community sizes (`communitySizes`) — no member labels — so members show as
// raw entity IDs. Groups are inverted from the assignment map and sorted by size
// descending. Mirrors the KagNodeCard mount/flushSync pattern.

import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

import KagCommunityList from './KagCommunityList.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(props: {
  entityCommunities: Record<string, number>;
  communitySizes?: Record<string, number>;
}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(KagCommunityList, { target: host, props });
  flushSync();
  return host;
}

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host?.remove();
});

describe('KagCommunityList', () => {
  it('inverts the assignment map into one group per community, co-locating members', () => {
    const entityCommunities = { a: 0, b: 0, c: 1 };
    const el = render({ entityCommunities });
    const groups = el.querySelectorAll('[data-testid="kag-community-group"]');
    // One group per DISTINCT community in the input, not a literal count.
    expect(groups.length).toBe(new Set(Object.values(entityCommunities)).size);
    // The group containing 'a' also lists 'b' (both are in community 0).
    const withA = Array.from(groups).find((g) => g.textContent?.includes('a'))!;
    const items = Array.from(withA.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toContain('a');
    expect(items).toContain('b');
  });

  it('sorts groups by community size descending', () => {
    const el = render({
      entityCommunities: { a: 0, b: 1 },
      communitySizes: { 0: 2, 1: 5 },
    });
    const first = el.querySelector('[data-testid="kag-community-group"] summary');
    expect(first?.textContent).toContain('Community 1 (5)');
  });

  it('falls back to member count when communitySizes is omitted', () => {
    const el = render({ entityCommunities: { a: 0, b: 0 } });
    const summaries = Array.from(el.querySelectorAll('[data-testid="kag-community-group"] summary'));
    expect(summaries.some((s) => s.textContent?.includes('Community 0 (2)'))).toBe(true);
  });
});
