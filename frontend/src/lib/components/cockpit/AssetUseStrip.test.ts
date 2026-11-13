// @vitest-environment jsdom
//
// AssetUseStrip.test.ts
//
// Render-based tests for the customer cockpit's 5D asset-use strip. Uses Svelte
// 5's mount/unmount/flushSync directly .
// Pins that the four governance tiles render REAL per-kind bound counts from
// asset_bindings — including a 0 (a real "none bound" answer) — and never the old
// "not yet surfaced" placeholder, and that the block degrades when unavailable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import AssetUseStrip from './AssetUseStrip.svelte';
import type { Panel } from '$lib/types/panel';
import type { AssetUsage } from '$lib/types/cockpit';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (app) {
    unmount(app);
    app = null;
  }
  host.remove();
});

function availableBlock(usage: AssetUsage): Panel<AssetUsage> {
  return { data: usage, as_of: '2026-07-10T00:00:00.000Z', health: 'ok' as const };
}

describe('AssetUseStrip', () => {
  it('renders real per-kind bound counts, including a zero, and no placeholder', () => {
    app = mount(AssetUseStrip, {
      target: host,
      props: {
        assetUsage: availableBlock({
          kag_memory_links: 12,
          cards_with_links: 5,
          per_card: [],
          bound_by_kind: { principle: 3, requirement: 7, decision: 0 },
        }),
      },
    });
    flushSync();

    const strip = host.querySelector('[data-testid="asset-use-strip"]');
    expect(strip).not.toBeNull();
    const text = strip?.textContent ?? '';

    // KAG tile unchanged.
    expect(text).toContain('KAG');
    expect(text).toContain('12 linked');
    expect(text).toContain('5 cards');

    // Three governance tiles with real counts (0 is a real answer).
    expect(text).toContain('Principles');
    expect(text).toContain('3 bound');
    expect(text).toContain('Requirements');
    expect(text).toContain('7 bound');
    expect(text).toContain('Decisions');
    expect(text).toContain('0 bound');

    // The old data-gap placeholder is gone.
    expect(text).not.toContain('not yet surfaced');
  });

  it('labels the counts as explicit bindings and links to Effective assets', () => {
    // UI review 2026-10-07: 0 everywhere read as "this project uses nothing";
    // the tiles count explicit bindings only.
    app = mount(AssetUseStrip, {
      target: host,
      props: {
        projectId: 'p-1',
        assetUsage: availableBlock({
          kag_memory_links: 0,
          cards_with_links: 0,
          per_card: [],
          bound_by_kind: { principle: 0, requirement: 0, decision: 0 },
        }),
      },
    });
    flushSync();

    expect(host.querySelector('[data-testid="asset-use-strip-label"]')?.textContent).toContain(
      'Explicitly bound assets',
    );
    const link = host.querySelector('[data-testid="asset-use-strip-note"] a');
    expect(link?.getAttribute('href')).toBe('/projects/p-1/knowledge');
  });

  it('degrades via BlockUnavailable when the block is unavailable', () => {
    app = mount(AssetUseStrip, {
      target: host,
      props: {
        assetUsage: {
          data: null,
          as_of: null, health: 'down' as const, detail_code: 'fr_db_error',
        },
      },
    });
    flushSync();

    expect(host.querySelector('[data-testid="asset-use-strip"]')).toBeNull();
  });
});
