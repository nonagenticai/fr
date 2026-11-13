import { describe, expect, it } from 'vitest';
import { ageWords, durationWords, elapsedWords, isFinished, moneyWords, phaseOfWords, startedWords, stateExplanation, STATE_META } from './cockpit-status';
import { isClosedProjectStatus } from './project-status';

describe('C1 vocabulary', () => {
  it('every state has one word', () => {
    expect(Object.values(STATE_META).map((m) => m.word)).toEqual(['Running', 'Waiting on you', 'Blocked', 'Paused', 'Completed', 'Cancelled']);
  });
  it('durations in words', () => {
    expect(durationWords(30_000)).toBe('under a minute');
    expect(durationWords(45 * 60_000)).toBe('45 min');
    expect(durationWords((3 * 60 + 12) * 60_000)).toBe('3 h 12 min');
    expect(durationWords((2 * 1440 + 4 * 60) * 60_000)).toBe('2 d 4 h');
  });
  it('elapsed: running vs closed (with and without a recorded end)', () => {
    const start = '2026-10-25T09:00:00.000Z';
    const now = Date.parse('2026-10-25T10:30:00.000Z');
    expect(elapsedWords({ state: 'running', started_at: start, ended_at: null }, now)).toBe('1 h 30 min so far');
    expect(elapsedWords({ state: 'completed', started_at: start, ended_at: '2026-10-25T10:53:00.000Z' }, now)).toBe('Ran for 1 h 53 min');
    expect(elapsedWords({ state: 'cancelled', started_at: start, ended_at: null }, now)).toMatch(/^Started /);
    expect(elapsedWords({ state: 'running', started_at: null, ended_at: null }, now)).toBeNull();
  });
  it('R2 header words: phase N of M, money, started, finished', () => {
    expect(phaseOfWords({ phase_position: 3, phase_count: 4, current_phase_label: 'Execution' })).toBe('Phase 3 of 4: Execution');
    expect(phaseOfWords({ phase_position: null, phase_count: 4, current_phase_label: null })).toBeNull();
    expect(moneyWords(29.784, 'USD')).toBe('$29.78');
    expect(moneyWords(null, 'USD')).toBeNull();
    expect(startedWords(null)).toBeNull();
    expect(startedWords('2026-10-25T09:56:00.000Z')).toMatch(/^Started /);
    expect(['running', 'waiting_on_you', 'blocked', 'paused', 'completed', 'cancelled'].filter((s) => isFinished(s as never))).toEqual(['completed', 'cancelled']);
  });
  it('age of an action item', () => {
    expect(ageWords('2026-10-25T10:18:00.000Z', Date.parse('2026-10-25T10:30:00.000Z'))).toBe('waiting 12 min');
    expect(ageWords(null, 0)).toBeNull();
  });
  it('explanations are plain words (no codes)', () => {
    const t = stateExplanation({ state: 'blocked', reasons: ['flow_failed', 'card_blocked'] });
    expect(t).toContain('A flow failed');
    expect(t).not.toMatch(/flow_failed|card_blocked/);
  });
});

describe('isClosedProjectStatus learns rm_status (F9)', () => {
  it('RM closed closes an fr-active project', () => {
    expect(isClosedProjectStatus('active', 'closed')).toBe(true);
    expect(isClosedProjectStatus('active', 'active')).toBe(false);
    expect(isClosedProjectStatus('archived')).toBe(true);
    expect(isClosedProjectStatus(null, null)).toBe(false);
  });
});
