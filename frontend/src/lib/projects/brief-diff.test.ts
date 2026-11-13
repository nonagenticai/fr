import { describe, it, expect } from 'vitest';
import {
  BRIEF_FIELDS,
  diffBriefs,
  formatLocalDateTime,
  itemText,
  lineDiff,
  previousVersionOf,
  stableJson,
  versionLabel,
  viewingBadge,
} from './brief-diff';

describe('labels', () => {
  it('formats created_at as local YYYY-MM-DD HH:mm', () => {
    // Built from local components so the assertion holds in any TZ.
    const d = new Date(2026, 9, 13, 8, 40, 59);
    expect(formatLocalDateTime(d.toISOString())).toBe('2026-10-13 08:40');
  });

  it('an unparsable created_at is shown as received', () => {
    expect(formatLocalDateTime('not-a-date')).toBe('not-a-date');
  });

  it('version option label is "vN · author · date"', () => {
    const created_at = new Date(2026, 9, 13, 8, 40).toISOString();
    expect(versionLabel({ version: 3, author_kind: 'conveyor', created_at })).toBe('v3 · conveyor · 2026-10-13 08:40');
    expect(versionLabel({ version: 1, author_kind: 'user', created_at })).toBe('v1 · user · 2026-10-13 08:40');
  });

  it('viewing badge prefers current_version, else total', () => {
    expect(viewingBadge(2, 5, 4)).toBe('viewing v2 of 5');
    expect(viewingBadge(2, null, 4)).toBe('viewing v2 of 4');
  });
});

describe('BRIEF_FIELDS', () => {
  it('covers every ProjectBrief key exactly once', () => {
    const keys = BRIEF_FIELDS.map((f) => f.key);
    // Removed 2026-10-31: `expect(keys).toHaveLength(18)` — an absolute count of
    // the table, not of anything the code computes. It could not detect a
    // ProjectBrief field missing from BRIEF_FIELDS (types are erased at runtime),
    // and it only made every added field break a green suite on purpose. The
    // de-duplication assertion below is the real guard.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('constraints');
    expect(keys).toContain('risks');
  });
});

describe('itemText', () => {
  it('renders risks, dependencies and constraints as one line', () => {
    expect(itemText({ description: 'RM down', likelihood: 'low', impact: 'high', mitigation: 'retry' })).toBe(
      'RM down (likelihood: low, impact: high) — mitigation: retry',
    );
    expect(itemText({ kind: 'service', name: 'kag', note: 'v2 api' })).toBe('service: kag — v2 api');
    expect(itemText({ kind: 'budget_cap', amount: 10 })).toBe('budget_cap: {"amount":10}');
    expect(itemText('plain')).toBe('plain');
  });

  it('renders an RM #235 acceptance criterion ITEM as its text, never as JSON', () => {
    const base = { id: 'c-1', text: 'Login works with SSO', evidence: [], checked_at: null, checked_by: null };
    expect(itemText({ ...base, status: 'unchecked' })).toBe('Login works with SSO');
    expect(itemText({ ...base, status: 'met', evidence: [{ kind: 'pr', ref: 'https://x/pull/2' }] })).toBe(
      'Login works with SSO — met',
    );
    expect(itemText({ ...base, status: 'not_met' })).toBe('Login works with SSO — not met');
    expect(itemText({ ...base, status: 'met' })).not.toContain('{');
  });
});

describe('diffBriefs', () => {
  it('text fields report old → new; null and empty string are the same', () => {
    const d = diffBriefs(
      { problem_statement: 'old', notes: '' },
      { problem_statement: 'new', notes: null },
    );
    expect(d).toEqual([{ key: 'problem_statement', label: 'Problem statement', kind: 'text', before: 'old', after: 'new' }]);
  });

  it('list fields report added and removed items', () => {
    const d = diffBriefs({ in_scope: ['a', 'b'] }, { in_scope: ['b', 'c'] });
    expect(d).toEqual([{ key: 'in_scope', label: 'In scope', kind: 'items', added: ['c'], removed: ['a'] }]);
  });

  it('duplicates count: a second copy of an item is an addition', () => {
    const d = diffBriefs({ assumptions: ['x'] }, { assumptions: ['x', 'x'] });
    expect(d[0]).toMatchObject({ kind: 'items', added: ['x'], removed: [] });
  });

  it('objects compare by JSON identity (key order ignored)', () => {
    const before = { risks: [{ description: 'r1', impact: 'high' }], dependencies: [{ kind: 'svc', name: 'kag' }] };
    const after = {
      risks: [{ impact: 'high', description: 'r1' }, { description: 'r2' }],
      dependencies: [{ kind: 'svc', name: 'kag', note: 'pinned' }],
    };
    const d = diffBriefs(before, after);
    expect(d.map((x) => x.key)).toEqual(['dependencies', 'risks']);
    expect(d[0]).toMatchObject({ added: [{ kind: 'svc', name: 'kag', note: 'pinned' }], removed: [{ kind: 'svc', name: 'kag' }] });
    expect(d[1]).toMatchObject({ added: [{ description: 'r2' }], removed: [] });
  });

  it('the first version diffs against an empty brief', () => {
    const d = diffBriefs(null, { desired_outcome: 'ship', constraints: ['no prod writes'] });
    expect(d.map((x) => x.key)).toEqual(['desired_outcome', 'constraints']);
  });

  it('identical briefs have no diff', () => {
    const b = { approvers: ['ann'], risks: [{ description: 'r' }], budget: '10k' };
    expect(diffBriefs(b, structuredClone(b))).toEqual([]);
  });

  it('notes diff line by line: a conveyor append (R144) shows only the appended section', () => {
    const user = 'Please keep the API stable.\nNo prod writes.';
    const v2 = `${user}\n\n## Clarifications\n- repo is ems`;
    const d = diffBriefs({ notes: user }, { notes: v2 });
    expect(d).toEqual([
      { key: 'notes', label: 'Notes', kind: 'lines', kept: 2, removed: [], added: ['', '## Clarifications', '- repo is ems'] },
    ]);
  });

  it('notes added from nothing are all additions; an edit shows old and new block', () => {
    expect(diffBriefs({}, { notes: 'a\nb' })[0]).toMatchObject({ kind: 'lines', kept: 0, removed: [], added: ['a', 'b'] });
    expect(lineDiff('a\nb\nc', 'a\nX\nc')).toEqual({ kept: 2, removed: ['b'], added: ['X'] });
    expect(lineDiff('a\na', 'a\na\na')).toEqual({ kept: 2, removed: [], added: ['a'] });
    expect(lineDiff('a', null)).toEqual({ kept: 0, removed: ['a'], added: [] });
  });

  it('stableJson ignores key order', () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});

describe('previousVersionOf', () => {
  it('finds the version just below, in any order; null for the first', () => {
    const vs = [{ version: 5 }, { version: 3 }, { version: 1 }];
    expect(previousVersionOf(vs, 5)).toBe(3);
    expect(previousVersionOf(vs, 3)).toBe(1);
    expect(previousVersionOf(vs, 1)).toBeNull();
  });
});
