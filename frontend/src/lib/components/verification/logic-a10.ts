// Contract A10 (2026-09-26) render helpers — alerts (A10.4). Same rule as every other verification parser here: a value
// the ILS/fr backend did not send is rendered as words ("not reported"),
// never as 0, never as a pass, never silently dropped.
import type { VerificationAlertItem, VerificationAlertsPayload } from '$lib/types/verification';
import type { Tone } from './logic';

// ---------------------------------------------------------------------------
// A10.4 — alerts
// ---------------------------------------------------------------------------

export interface AlertsView {
  reachable: boolean;
  firing: VerificationAlertItem[];
  pending: VerificationAlertItem[];
}

/**
 * `null` = the alerts BLOCK itself is unavailable (a fetch failure) — distinct
 * from `reachable:false`, which is a valid in-band value the ILS/fr sent. The
 * caller renders "alert state unknown" for BOTH (contract: never "no alerts"
 * unless the read genuinely succeeded AND reported zero items), but they are
 * kept distinguishable via `reachable`.
 */
export function alertsView(data: VerificationAlertsPayload | null | undefined): AlertsView | null {
  if (!data || typeof data !== 'object') return null;
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    reachable: data.reachable === true,
    firing: items.filter((i) => i && i.state === 'firing'),
    pending: items.filter((i) => i && i.state === 'pending'),
  };
}

/**
 * The strip's headline style. Contract A10.4: unreachable is GREY ("alert
 * state unknown"), NEVER "no alerts"; firing is RED; pending-only is AMBER;
 * reachable + zero items is the only state that says "no Verification alerts
 * firing".
 */
export function alertsStripStyle(view: AlertsView | null): { label: string; tone: Tone } {
  if (!view || !view.reachable) return { label: 'alert state unknown', tone: 'muted' };
  if (view.firing.length > 0) return { label: `${view.firing.length} Verification alert(s) firing`, tone: 'danger' };
  if (view.pending.length > 0) return { label: `${view.pending.length} Verification alert(s) pending`, tone: 'warning' };
  return { label: 'no Verification alerts firing', tone: 'success' };
}
