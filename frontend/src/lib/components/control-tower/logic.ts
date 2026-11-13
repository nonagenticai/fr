// logic.ts
// ========
// Pure, framework-free helpers for the super-admin control tower — tone
// mappings, small null-safe formatters, and the alert deep-link parser. Kept out of the .svelte files so they are
// unit-testable without mounting a component (the idiom the improvement lenses
// established).

import type { TagTone } from '$lib/components/evidence/pillTone';
import type {
  ControlAlertSeverity,
  TenantKind,
  Meter,
  ActiveExecutionRow,
  CorrelationState,
} from '$lib/types/control-tower';

/** Alert severity → Tag tone. */
export function alertTone(severity: ControlAlertSeverity): TagTone {
  switch (severity) {
    case 'danger':
      return 'danger';
    case 'warn':
      return 'warning';
    case 'ok':
    default:
      return 'success';
  }
}

/** Human label for a canonical tenant kind. */
export function tenantKindLabel(kind: TenantKind): string {
  switch (kind) {
    case 'system':
      return 'System';
    case 'execution':
      return 'Execution';
    case 'other':
    default:
      return 'Workspace';
  }
}

/** Board reachability → StatusBadge status. */
export function boardBadge(available: boolean): 'live' | 'stale' {
  return available ? 'live' : 'stale';
}

// ---- formatters (null-safe) ----
export function fmtNum(v: number | null | undefined): string {
  return v == null ? '—' : String(v);
}
export function fmtPct(v: number | null | undefined): string {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}
/** Seconds → compact human duration (e.g. 45 → "45s", 130 → "2m 10s", 4000 → "1h 6m"). */
export function fmtDurationSecs(v: number | null | undefined): string {
  if (v == null) return '—';
  const s = Math.max(0, Math.round(v));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
/** Meter value (0..1) → clamped 0..100 bar width percentage. */
export function meterPct(v: number | null | undefined): number {
  if (v == null) return 0;
  return Math.min(100, Math.max(0, Math.round(v * 100)));
}

// ---- telemetry meter value ----
/**
 * A meter's headline value, with the three states kept DISTINCT.
 *
 * `fmtPct` maps null → "—", and a meter has two very different reasons to hold
 * a null: it could not be measured at all (`available:false`), or it was
 * measured and there was nothing in the denominator (`available:true`,
 * `value:null` — e.g. correlation coverage over zero worker sessions). Those
 * collapsed onto the same glyph, so an entirely healthy idle system was
 * indistinguishable from a dead upstream.
 *
 * NB the fix is in the RENDERING only. The backend deliberately keeps
 * `value: total > 0 ? withCorr / total : null` because a fleet-wide denominator
 * is not obtainable from worker-management's bare-array session list — see the
 * comment above that computation, which says not to "fix" it into a true ratio.
 */
export function fmtMeterValue(meter: Pick<Meter, 'available' | 'value'>): string {
  if (!meter.available) return 'not reported';
  if (meter.value == null) return 'nothing to measure';
  return fmtPct(meter.value);
}

// ---- execution correlation ----
/** Shorten a correlation id for a dense table cell. */
export function shortCorrelationId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

/**
 * An execution row's correlation cell, with the three states kept DISTINCT.
 *
 * A blank cell used to mean all of: "started by an n8n schedule, so no fr
 * correlation id exists", "the mapping lookup failed", and "there is an id".
 * Only the middle one is a gap; the first is a fact about the run.
 *
 * TOLERANCE: `correlation_state` is being added by the backend half of this
 * fix and may be absent on a row served by an older build. An absent state with
 * a real id still renders the id — the id being present IS the evidence — and
 * an absent state with no id falls back to the honest unknown, "—".
 */
export function correlationState(
  row: Pick<ActiveExecutionRow, 'correlation_id' | 'correlation_state'>,
): CorrelationState {
  const declared = row.correlation_state ?? (row.correlation_id ? 'present' : 'unavailable');
  // A row claiming 'present' while carrying no id is not present — that is a
  // gap, and it must not render as one of the two positive states.
  return declared === 'present' && !row.correlation_id ? 'unavailable' : declared;
}

export function correlationLabel(
  row: Pick<ActiveExecutionRow, 'correlation_id' | 'correlation_state'>,
): string {
  const state = correlationState(row);
  if (state === 'not_fr_initiated') return 'external';
  if (state === 'present' && row.correlation_id) return shortCorrelationId(row.correlation_id);
  return '—';
}

// ---- alert deep-link parsing ----
export interface AlertLink {
  kind: string;
  ref: string;
}
/**
 * Parse an alert `link` of the form `block:<name>` / `card:<id>` into its parts.
 * Returns null for an empty/malformed link so callers can no-op. Pure.
 */
export function parseAlertLink(link: string | null | undefined): AlertLink | null {
  if (!link) return null;
  const idx = link.indexOf(':');
  if (idx <= 0 || idx === link.length - 1) return null;
  return { kind: link.slice(0, idx), ref: link.slice(idx + 1) };
}
