import { describe, expect, it } from 'vitest';
import { humanizeEnum, listNameLabel } from './humanizeEnum';

describe('humanizeEnum (FR-9)', () => {
  it.each([
    ['approved', 'Approved'],
    ['needs_revision', 'Needs revision'],
    ['IN_PROGRESS', 'In progress'],
    ['QA', 'QA'],
    ['', ''],
  ])('%s → %s', (input, out) => {
    expect(humanizeEnum(input)).toBe(out);
  });
  it('null/undefined render as empty, never "null"', () => {
    expect(humanizeEnum(null)).toBe('');
    expect(humanizeEnum(undefined)).toBe('');
  });
});

describe('listNameLabel (FR-9)', () => {
  it.each([
    ['DOING', 'Doing'],
    ['TODO', 'To do'],
    ['QA', 'QA'],
    ['PUBLISHED', 'Published'],
    ['Backlog', 'Backlog'],
  ])('%s → %s', (input, out) => {
    expect(listNameLabel(input)).toBe(out);
  });
});
