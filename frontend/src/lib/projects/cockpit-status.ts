// cockpit-status.ts — C1 status header vocabulary (spec "Project cockpit redesign", R-CK4).
// Pure: the state chip's word + tone, durations in words, the three health dots' tooltips.
import type { CockpitState, CockpitStateReason, CockpitStatus } from '$lib/types/cockpit';
import type { PanelHealth } from '$lib/types/panel';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export const STATE_META: Readonly<Record<CockpitState, { word: string; tone: Tone }>> = {
  running: { word: 'Running', tone: 'success' },
  waiting_on_you: { word: 'Waiting on you', tone: 'warning' },
  blocked: { word: 'Blocked', tone: 'danger' },
  paused: { word: 'Paused', tone: 'warning' },
  completed: { word: 'Completed', tone: 'neutral' },
  cancelled: { word: 'Cancelled', tone: 'neutral' },
};

/** The project is over: an outcome page, with no asks, drafts or running indicators (D6, D8). */
export function isFinished(s: CockpitState | null | undefined): boolean {
  return s === 'completed' || s === 'cancelled';
}

const REASON_WORDS: Readonly<Record<CockpitStateReason, string>> = {
  rm_closed: 'The project was closed.',
  project_archived: 'The project is archived.',
  project_delivered: 'The project was delivered.',
  andon_engaged: 'Work is paused on this project.',
  card_blocked: 'A card is blocked.',
  flow_failed: 'A flow failed and has not succeeded since.',
  open_approvals: 'Something is waiting for a decision.',
};

/** One sentence explaining the state (the chip's tooltip). */
export function stateExplanation(s: Pick<CockpitStatus, 'state' | 'reasons'>): string {
  if (s.reasons.length === 0) return s.state === 'running' ? 'Work is moving; nothing is waiting on you.' : STATE_META[s.state].word;
  return s.reasons.map((r) => REASON_WORDS[r] ?? '').filter(Boolean).join(' ');
}

/** "3 h 12 min", "45 min", "2 d 4 h", "under a minute". */
export function durationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'under a minute';
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

/** "Running for 3 h 12 min" / "Closed after 2 h" / "Started 2026-10-25" when the end is unknown. */
export function elapsedWords(s: Pick<CockpitStatus, 'state' | 'started_at' | 'ended_at'>, now: number): string | null {
  const start = s.started_at ? Date.parse(s.started_at) : NaN;
  if (!Number.isFinite(start)) return null;
  if (isFinished(s.state)) {
    const end = s.ended_at ? Date.parse(s.ended_at) : NaN;
    return Number.isFinite(end)
      ? `Ran for ${durationWords(end - start)}`
      : `Started ${new Date(start).toLocaleDateString()}`;
  }
  return `${durationWords(now - start)} so far`;
}

/** "waiting 12 min" for an action item. */
export function ageWords(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `waiting ${durationWords(now - t)}` : null;
}

export const HEALTH_WORD: Readonly<Record<PanelHealth, string>> = { ok: 'OK', degraded: 'Degraded', down: 'Down' };

/** "Phase 3 of 4: Execution"; null when the phase is not known. */
export function phaseOfWords(s: Pick<CockpitStatus, 'phase_position' | 'phase_count' | 'current_phase_label'>): string | null {
  if (!s.phase_position || !s.phase_count || !s.current_phase_label) return null;
  return `Phase ${s.phase_position} of ${s.phase_count}: ${s.current_phase_label}`;
}

/** "$29.78" (2 decimals, the billing currency); null amount ⇒ null. */
export function moneyWords(amount: number | null | undefined, currency = 'USD'): string | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** "Started 25 Oct 09:56" in the viewer's locale; null for an unreadable stamp. */
export function startedWords(iso: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return `Started ${new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}
