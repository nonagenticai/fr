// priorityErrorMessage — readable text for the backend's priority refusal
// codes, found in the error body or in the message; fallback to the message.
import { describe, it, expect } from 'vitest';
import { PRIORITY_ERROR_TEXT, priorityErrorMessage } from './priority';

class CodedApiError extends Error {
  constructor(
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

describe('priorityErrorMessage', () => {
  for (const [code, text] of Object.entries(PRIORITY_ERROR_TEXT)) {
    it(`maps ${code} from the message`, () => {
      expect(priorityErrorMessage(new CodedApiError(code))).toBe(text);
    });
    it(`maps ${code} from body.code even when the message is something else`, () => {
      expect(priorityErrorMessage(new CodedApiError('Forbidden', { code, error: 'x' }))).toBe(text);
    });
  }

  it('maps from body.error', () => {
    expect(priorityErrorMessage(new CodedApiError('x', { error: 'card_not_found' }))).toBe(
      "This card is not on the project's board.",
    );
  });

  it('an unknown code falls back to the message', () => {
    expect(priorityErrorMessage(new CodedApiError('Project not found', { error: 'Project not found' }))).toBe(
      'Project not found',
    );
  });

  it('a non-Error falls back to a generic line', () => {
    expect(priorityErrorMessage('boom')).toBe('Saving the priority failed.');
    expect(priorityErrorMessage(null)).toBe('Saving the priority failed.');
  });

  it('does not match inherited keys (toString is not a code)', () => {
    expect(priorityErrorMessage(new CodedApiError('toString'))).toBe('toString');
  });
});

import { priorityOptions, storedPriorityLevel, toSelectValue, fromSelectValue, priorityLabel } from './priority';

describe('priority levels (the workspace RM levels; no P0..P3 list in fr)', () => {
  const LEVELS = [
    { id: 'b', name: 'normal', title: 'Normal', rank: 5, is_default: true },
    { id: 'a', name: 'urgent', title: 'Urgent', rank: 0, is_default: false, description: 'drop everything' },
  ];
  it('options: Unset then the levels by rank, valued by id', () => {
    expect(priorityOptions(LEVELS)).toEqual([
      { value: '', label: 'Unset' },
      { value: 'a', label: 'Urgent – drop everything' },
      { value: 'b', label: 'Normal' },
    ]);
  });
  it('stored level: id first, else the legacy text by name (case-insensitive), else null', () => {
    expect(storedPriorityLevel(LEVELS, { id: 'b', text: 'URGENT' })!.id).toBe('b');
    expect(storedPriorityLevel(LEVELS, { text: 'URGENT' })!.id).toBe('a');
    expect(storedPriorityLevel(LEVELS, { id: 'zzz', text: 'nope' })).toBeNull();
    expect(storedPriorityLevel(LEVELS, {})).toBeNull();
  });
  it('select round-trip and label', () => {
    expect(toSelectValue(LEVELS[0]!)).toBe('b');
    expect(toSelectValue(null)).toBe('');
    expect(fromSelectValue('')).toBeNull();
    expect(fromSelectValue('a')).toBe('a');
    expect(priorityLabel(null)).toBe('unset');
    expect(priorityLabel(LEVELS[1]!)).toBe('Urgent');
  });
});
