// @vitest-environment jsdom
//
// Contract A10 (2026-09-26): alerts (A10.4). Same rule as every other
// verification test here: an absent field is "not reported" in words, never
// 0, never a pass. (The A10.2/A10.3 canary + evidence-delete rendering lived
// on the trust board, deleted 2026-11-01 with the retired ILS.)
//
// (A10.5 arming preflight was removed 2026-09-27 per George's judge/oracle/
// tournament ruling — it existed only to arm the judge-tier-gated QA cell;
// see this file's own git history for the deleted `ArmingPreflightPanel` suite.)

import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import AlertsStrip from './AlertsStrip.svelte';
import { alertsStripStyle, alertsView } from './logic-a10';
import type { Block } from '$lib/types/read-model';
import type { VerificationAlertsPayload } from '$lib/types/verification';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host?.remove();
});

function render(C: any, props: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(C, { target: host, props });
  flushSync();
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`);

const alertsBlock = (data: VerificationAlertsPayload | null, available = true): Block<VerificationAlertsPayload> => ({
  data,
  meta: available
    ? { source: 'prometheus', fetched_at: '2026-09-26T17:08:00Z', available: true }
    : { source: 'prometheus', fetched_at: '2026-09-26T17:08:00Z', available: false, unavailable_kind: 'error', error: 'boom' },
});

// ---------------------------------------------------------------------------
// logic-a10.ts — pure functions
// ---------------------------------------------------------------------------

describe('alertsView / alertsStripStyle', () => {
  it('null/unavailable data -> null view -> "alert state unknown", never "no alerts"', () => {
    expect(alertsView(null)).toBeNull();
    expect(alertsStripStyle(null)).toMatchObject({ label: 'alert state unknown', tone: 'muted' });
  });

  it('reachable:false -> "alert state unknown" (MUTATION CONTROL: must never read as "no alerts")', () => {
    const view = alertsView({ source: 'prometheus', reachable: false, as_of: 't', items: [] });
    expect(view!.reachable).toBe(false);
    const style = alertsStripStyle(view);
    expect(style.label).toBe('alert state unknown');
    expect(style.label).not.toContain('no Verification alerts firing');
    expect(style.tone).toBe('muted');
  });

  it('reachable + 0 items -> "no Verification alerts firing"', () => {
    const view = alertsView({ source: 'prometheus', reachable: true, as_of: 't', items: [] });
    expect(alertsStripStyle(view)).toMatchObject({ label: 'no Verification alerts firing', tone: 'success' });
  });

  it('reachable + firing -> red headline naming the count', () => {
    const view = alertsView({
      source: 'prometheus',
      reachable: true,
      as_of: 't',
      items: [{ alertname: 'A', state: 'firing', severity: null, concept: null, active_at: null, summary: null, labels: {} }],
    });
    expect(alertsStripStyle(view)).toMatchObject({ label: '1 Verification alert(s) firing', tone: 'danger' });
  });
});

// ---------------------------------------------------------------------------
// AlertsStrip
// ---------------------------------------------------------------------------

describe('AlertsStrip', () => {
  it('block unavailable -> "alert state unknown", never "no alerts"', () => {
    render(AlertsStrip, { block: alertsBlock(null, false) });
    const text = $('verification-alerts-headline')!.textContent!;
    expect(text).toContain('alert state unknown');
    expect(text).not.toContain('no Verification alerts firing');
  });

  it('reachable:false -> "alert state unknown"', () => {
    render(AlertsStrip, { block: alertsBlock({ source: 'prometheus', reachable: false, as_of: 't', items: [] }) });
    expect($('verification-alerts-headline')!.textContent).toContain('alert state unknown');
    expect($('verification-alerts-unreachable')).not.toBeNull();
  });

  it('reachable + 0 items -> "no Verification alerts firing"', () => {
    render(AlertsStrip, { block: alertsBlock({ source: 'prometheus', reachable: true, as_of: 't', items: [] }) });
    expect($('verification-alerts-headline')!.textContent).toContain('no Verification alerts firing');
  });

  it('firing items are listed with concept + severity', () => {
    render(AlertsStrip, {
      block: alertsBlock({
        source: 'prometheus',
        reachable: true,
        as_of: 't',
        items: [{ alertname: 'VerificationOracleRed', state: 'firing', severity: 'critical', concept: 'oracle', active_at: null, summary: null, labels: {} }],
      }),
    });
    const item = $('verification-alert-item')!;
    expect(item.textContent).toContain('VerificationOracleRed');
    expect(item.textContent).toContain('oracle');
    expect(item.textContent).toContain('critical');
  });

  it('active_at present -> renders "since <relative> (<UTC>)"; absent -> no since clause', () => {
    render(AlertsStrip, {
      block: alertsBlock({
        source: 'prometheus',
        reachable: true,
        as_of: 't',
        items: [
          {
            alertname: 'VerificationOracleRed',
            state: 'firing',
            severity: 'critical',
            concept: 'oracle',
            active_at: '2026-09-25T10:00:00Z',
            summary: null,
            labels: {},
          },
        ],
      }),
    });
    const item = $('verification-alert-item')!;
    expect(item.textContent).toContain('since');
    expect(item.textContent).toContain('2026-09-25 10:00 UTC');
  });

  it('MUTATION CONTROL: active_at:null must render with no "since" clause at all', () => {
    render(AlertsStrip, {
      block: alertsBlock({
        source: 'prometheus',
        reachable: true,
        as_of: 't',
        items: [{ alertname: 'VerificationOracleRed', state: 'firing', severity: 'critical', concept: 'oracle', active_at: null, summary: null, labels: {} }],
      }),
    });
    const item = $('verification-alert-item')!;
    expect(item.textContent).not.toContain('since');
  });
});
