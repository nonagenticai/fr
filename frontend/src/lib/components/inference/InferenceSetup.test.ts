// @vitest-environment jsdom
//
// InferenceSetup — one component test per setup (PLAN tenant-inference-
// provisioning §2.6). Every case first proves the section painted (its legend
// and the three setup options), so an empty render fails rather than passing.
//
//   setup 1 `local`            — selectable; ONE locked tier "Non-Agentic AI local"
//                                (local-llm); markup fields present but DISABLED;
//                                budget EUR + explicit byo_mode (byo_required).
//   setup 2 `owner_commercial` — visible, DISABLED, reason "available after
//                                spend breakers are live" while the flag is off;
//                                selectable and its markup fields enabled once on.
//   setup 3 `byo`              — visible, DISABLED, reason "available after BYO
//                                key custody ships" — even with setup 2 armed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import InferenceSetup from './InferenceSetup.svelte';
import { emptyInferenceDraft, type InferenceDraft } from './inference-form';
import type { InferenceConfig } from '$lib/api/inference-admin';

const CONFIG_OFF: InferenceConfig = {
  enabled: true,
  setup2_enabled: false,
  setups: [
    { setup: 'local', available: true, reason: null },
    { setup: 'owner_commercial', available: false, reason: 'available after spend breakers are live' },
    { setup: 'byo', available: false, reason: 'available after BYO key custody ships' },
  ],
};
const CONFIG_SETUP2: InferenceConfig = {
  ...CONFIG_OFF,
  setup2_enabled: true,
  setups: [
    { setup: 'local', available: true, reason: null },
    { setup: 'owner_commercial', available: true, reason: null },
    { setup: 'byo', available: false, reason: 'available after BYO key custody ships' },
  ],
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function render(draft: InferenceDraft, config: InferenceConfig): HTMLElement {
  app = mount(InferenceSetup, { target: host, props: { draft, config, mode: 'provision' } });
  flushSync();
  const root = host.querySelector<HTMLElement>('[data-testid="inference-setup"]');
  expect(root, 'the Inference section must have painted').not.toBeNull();
  expect(root!.textContent).toContain('Inference');
  for (const s of ['local', 'owner_commercial', 'byo']) {
    expect(root!.querySelector(`[data-testid="inference-setup-option-${s}"]`), `setup ${s} is always visible`).not.toBeNull();
  }
  return root!;
}

const radio = (root: HTMLElement, s: string) =>
  root.querySelector<HTMLInputElement>(`[data-testid="inference-setup-radio-${s}"]`)!;
const markupFieldset = (root: HTMLElement) =>
  root.querySelector<HTMLFieldSetElement>('[data-testid="inference-tiers-markup"]')!;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host.remove();
});

describe('InferenceSetup', () => {
  it('setup 1: one locked "Non-Agentic AI local" tier on local-llm; markup disabled; budget + explicit byo_mode', () => {
    const root = render(emptyInferenceDraft(), CONFIG_OFF);
    expect(radio(root, 'local').checked).toBe(true);
    expect(radio(root, 'local').disabled).toBe(false);

    const tier = root.querySelector('[data-testid="inference-local-tier"]');
    expect(tier?.textContent).toContain('Non-Agentic AI local');
    expect(root.querySelector('[data-testid="inference-local-model"]')?.textContent).toBe('local-llm');

    expect(markupFieldset(root).disabled).toBe(true);
    expect(root.querySelector('[data-testid="inference-markup-note"]')?.textContent).toContain('setups 2 and 3 only');

    const budget = root.querySelector<HTMLInputElement>('[data-testid="inference-budget-amount"]')!;
    expect(budget.type).toBe('number');
    expect(budget.step).toBe('1');
    const currency = root.querySelector<HTMLSelectElement>('[data-testid="inference-budget-currency"]')!;
    expect(currency.value).toBe('EUR');
    expect([...currency.options].map((o) => o.value)).toEqual(['EUR', 'USD', 'CAD']);
    expect(currency.disabled).toBe(false);

    // Pre-paid / post-paid: modelled, read-only, "coming soon".
    const terms = root.querySelector<HTMLElement>('[data-testid="inference-payment-terms"]')!;
    expect(terms.textContent).toContain('coming soon');
    expect(terms.textContent).toContain('billing-service#247');
    const term = (line: string) =>
      root.querySelector<HTMLSelectElement>(`[data-testid="inference-payment-term-${line}"]`)!;
    expect([term('budget').value, term('markup').value, term('fees').value]).toEqual(['prepaid', 'postpaid', 'postpaid']);
    expect([term('budget').disabled, term('markup').disabled, term('fees').disabled]).toEqual([true, true, true]);

    const byo = root.querySelector<HTMLSelectElement>('[data-testid="inference-byo-mode"]')!;
    expect(byo.value).toBe('byo_required');
    expect([...byo.options].map((o) => o.value)).toEqual(['local_allowed', 'byo_required', 'platform_only']);
  });

  it('setup 2: visible but disabled with its reason while FR_SETUP2_ENABLED is off', () => {
    const root = render(emptyInferenceDraft(), CONFIG_OFF);
    expect(radio(root, 'owner_commercial').disabled).toBe(true);
    expect(root.querySelector('[data-testid="inference-setup-reason-owner_commercial"]')?.textContent).toContain(
      'available after spend breakers are live',
    );
  });

  it('setup 2: selectable once armed, and its tier + markup fields are enabled', () => {
    const draft = { ...emptyInferenceDraft(), setup: 'owner_commercial' as const };
    const root = render(draft, CONFIG_SETUP2);
    expect(radio(root, 'owner_commercial').disabled).toBe(false);
    expect(radio(root, 'owner_commercial').checked).toBe(true);
    expect(root.querySelector('[data-testid="inference-setup-reason-owner_commercial"]')).toBeNull();
    expect(markupFieldset(root).disabled).toBe(false);
    expect(root.querySelector('[data-testid="inference-markup-pct"]')).not.toBeNull();
    // Setup 2 has no locked local tier card.
    expect(root.querySelector('[data-testid="inference-local-tier"]')).toBeNull();
  });

  it('setup 3: visible but disabled with its reason — even with setup 2 armed', () => {
    const root = render(emptyInferenceDraft(), CONFIG_SETUP2);
    expect(radio(root, 'byo').disabled).toBe(true);
    expect(root.querySelector('[data-testid="inference-setup-reason-byo"]')?.textContent).toContain(
      'available after BYO key custody ships',
    );
    // No key field anywhere: BYO key entry ships with custody.
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(root.textContent?.toLowerCase()).not.toContain('api key');
  });

  it('disabled=true locks every control (edit mode while applying)', () => {
    app = mount(InferenceSetup, {
      target: host,
      props: { draft: emptyInferenceDraft(), config: CONFIG_OFF, mode: 'edit', disabled: true },
    });
    flushSync();
    const root = host.querySelector<HTMLElement>('[data-testid="inference-setup"]')!;
    expect(root.dataset.mode).toBe('edit');
    expect(radio(root, 'local').disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('[data-testid="inference-budget-amount"]')!.disabled).toBe(true);
  });
});
