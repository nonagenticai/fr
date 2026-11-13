// @vitest-environment jsdom
//
// Spec 2 §4 — ShapeRadio component test.
//
// Pure presentational, no API surface — these tests assert the
// rendered radios, the preselection logic, and the bind:value /
// onchange wiring.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ShapeRadio from './ShapeRadio.svelte';

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

describe('ShapeRadio', () => {
  it('renders both options and preselects deliverable', () => {
    app = mount(ShapeRadio, { target: host, props: { value: 'deliverable' } });
    flushSync();
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(inputs.length).toBe(2);
    expect(inputs[0]!.value).toBe('deliverable');
    expect(inputs[0]!.checked).toBe(true);
    expect(inputs[1]!.value).toBe('continuous_flow');
    expect(inputs[1]!.checked).toBe(false);
  });

  it('preselects continuous_flow when value="continuous_flow"', () => {
    app = mount(ShapeRadio, { target: host, props: { value: 'continuous_flow' } });
    flushSync();
    const cf = host.querySelector<HTMLInputElement>(
      'input[value="continuous_flow"]',
    );
    expect(cf!.checked).toBe(true);
  });

  it('emits onchange when the user picks continuous_flow', async () => {
    let captured: 'deliverable' | 'continuous_flow' = 'deliverable';
    app = mount(ShapeRadio, {
      target: host,
      props: {
        value: 'deliverable',
        onchange: (v) => {
          captured = v;
        },
      },
    });
    flushSync();
    const cf = host.querySelector<HTMLInputElement>(
      'input[value="continuous_flow"]',
    )!;
    cf.click();
    flushSync();
    await tick();
    expect(captured).toBe('continuous_flow');
  });

  // Removed 2026-10-31: an `it('renders the testid for E2E discovery')` that only
  // asserted `[data-testid="shape-radio"]` exists after a mount. It said nothing
  // about what the component renders or decides — and if the testid ever moves,
  // the E2E selector that depends on it fails, which is the guard that matters.

  it('disables both inputs when disabled=true', () => {
    app = mount(ShapeRadio, {
      target: host,
      props: { value: 'deliverable', disabled: true },
    });
    flushSync();
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(inputs[0]!.disabled).toBe(true);
    expect(inputs[1]!.disabled).toBe(true);
  });
});
