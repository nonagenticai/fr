import { describe, it, expect } from 'vitest';
import {
  alertTone,
  tenantKindLabel,
  boardBadge,
  fmtNum,
  fmtPct,
  fmtDurationSecs,
  meterPct,
  parseAlertLink,
  fmtMeterValue,
  correlationState,
  correlationLabel,
} from './logic';

describe('tone maps', () => {
  it('alertTone maps severities', () => {
    expect(alertTone('danger')).toBe('danger');
    expect(alertTone('warn')).toBe('warning');
    expect(alertTone('ok')).toBe('success');
  });
});

describe('labels + badges', () => {
  it('tenantKindLabel humanises kinds', () => {
    expect(tenantKindLabel('system')).toBe('System');
    expect(tenantKindLabel('other')).toBe('Workspace');
  });

  it('boardBadge maps reachability', () => {
    expect(boardBadge(true)).toBe('live');
    expect(boardBadge(false)).toBe('stale');
  });
});

describe('formatters', () => {
  it('fmtNum / fmtPct are null-safe', () => {
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(0)).toBe('0');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(0.951)).toBe('95.1%');
  });

  it('meterPct clamps 0..100 and treats null as 0', () => {
    expect(meterPct(null)).toBe(0);
    expect(meterPct(0.5)).toBe(50);
    expect(meterPct(1.4)).toBe(100);
    expect(meterPct(-0.2)).toBe(0);
  });

  it('fmtDurationSecs renders compact, null-safe, non-negative durations', () => {
    expect(fmtDurationSecs(null)).toBe('—');
    expect(fmtDurationSecs(0)).toBe('0s');
    expect(fmtDurationSecs(45)).toBe('45s');
    expect(fmtDurationSecs(130)).toBe('2m 10s');
    expect(fmtDurationSecs(4000)).toBe('1h 6m');
    expect(fmtDurationSecs(-5)).toBe('0s');
  });
});

describe('fmtMeterValue', () => {
  it('renders a measured value as a percentage', () => {
    expect(fmtMeterValue({ available: true, value: 0.951 })).toBe('95.1%');
    expect(fmtMeterValue({ available: true, value: 0 })).toBe('0.0%');
  });

  it('distinguishes measured-but-empty from could-not-measure', () => {
    // The defect: both used to render "—", so a healthy idle meter was
    // indistinguishable from a dead upstream.
    const empty = fmtMeterValue({ available: true, value: null });
    const missing = fmtMeterValue({ available: false, value: null });
    expect(empty).toBe('nothing to measure');
    expect(missing).toBe('not reported');
    expect(empty).not.toBe(missing);
    expect(empty).not.toBe('—');
    expect(missing).not.toBe('—');
  });

  it('never claims a percentage for an unavailable meter carrying a stale value', () => {
    expect(fmtMeterValue({ available: false, value: 0.4 })).toBe('not reported');
  });
});

describe('correlation state + label', () => {
  it('renders the three states distinctly', () => {
    expect(correlationLabel({ correlation_id: 'abc-123', correlation_state: 'present' })).toBe('abc-123');
    expect(correlationLabel({ correlation_id: null, correlation_state: 'not_fr_initiated' })).toBe('external');
    expect(correlationLabel({ correlation_id: null, correlation_state: 'unavailable' })).toBe('—');
  });

  it('shortens a long id', () => {
    expect(correlationLabel({ correlation_id: '0123456789abcdef', correlation_state: 'present' })).toBe('0123456789ab…');
    expect(correlationLabel({ correlation_id: '0123456789ab', correlation_state: 'present' })).toBe('0123456789ab');
  });

  it('tolerates the backend field being absent (the two halves land independently)', () => {
    // Absent + an id: the id IS the evidence of presence.
    expect(correlationState({ correlation_id: 'abc-123' })).toBe('present');
    expect(correlationLabel({ correlation_id: 'abc-123' })).toBe('abc-123');
    // Absent + no id: unknown, not "external" — we must not invent the fact.
    expect(correlationState({ correlation_id: null })).toBe('unavailable');
    expect(correlationLabel({ correlation_id: null })).toBe('—');
  });

  it('does not treat a "present" claim with no id as present', () => {
    expect(correlationState({ correlation_id: null, correlation_state: 'present' })).toBe('unavailable');
    expect(correlationLabel({ correlation_id: null, correlation_state: 'present' })).toBe('—');
  });

  it('an fr-initiated gap and an external run are never the same string', () => {
    expect(correlationLabel({ correlation_id: null, correlation_state: 'not_fr_initiated' })).not.toBe(
      correlationLabel({ correlation_id: null, correlation_state: 'unavailable' }),
    );
  });
});

describe('parseAlertLink', () => {
  it('splits block:/card: links', () => {
    expect(parseAlertLink('block:observability')).toEqual({ kind: 'block', ref: 'observability' });
    expect(parseAlertLink('card:abc-123')).toEqual({ kind: 'card', ref: 'abc-123' });
  });

  it('returns null for empty/malformed links', () => {
    expect(parseAlertLink(null)).toBeNull();
    expect(parseAlertLink('')).toBeNull();
    expect(parseAlertLink('nocolon')).toBeNull();
    expect(parseAlertLink(':leading')).toBeNull();
    expect(parseAlertLink('trailing:')).toBeNull();
  });
});
