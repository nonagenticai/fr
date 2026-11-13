import { describe, it, expect } from 'vitest';
import { bodyText, catalogueMode, importRows, listView, rowsOr } from './state';
import type { CatalogueFailure } from '$lib/api/conveyor-catalogue';

const fail = (status: number, unavailable = false): CatalogueFailure => ({
  ok: false,
  status,
  code: null,
  message: 'm',
  body: { error: 'x' },
  unavailable,
});

describe('catalogueMode — admins edit, members read', () => {
  it('maps the workspace-admin capability', () => {
    expect(catalogueMode('permitted')).toBe('edit');
    expect(catalogueMode('denied')).toBe('read');
    expect(catalogueMode('unknown')).toBe('checking');
  });
});

describe('listView never collapses unavailable / not shipped / empty', () => {
  it('maps each result to its own state', () => {
    expect(listView({ ok: true, data: [] }).kind).toBe('empty');
    expect(listView({ ok: true, data: [1] })).toEqual({ kind: 'ready', rows: [1] });
    expect(listView(fail(502, true)).kind).toBe('unavailable');
    expect(listView(fail(409, true)).kind).toBe('unavailable');
    expect(listView(fail(404)).kind).toBe('not-shipped');
    expect(listView(fail(403)).kind).toBe('error');
  });

  it('rowsOr reports a failed secondary read instead of an empty list', () => {
    const f = fail(500, true);
    expect(rowsOr(f)).toEqual({ rows: [], failure: f });
    expect(rowsOr({ ok: true, data: ['a'] })).toEqual({ rows: ['a'], failure: null });
  });
});

describe('error body rendering', () => {
  it('pretty-prints a JSON body and keeps a text body', () => {
    expect(bodyText({ detail: 'nope' })).toBe('{\n  "detail": "nope"\n}');
    expect(bodyText('plain')).toBe('plain');
    expect(bodyText(null)).toBe('');
  });
});

describe('importRows', () => {
  it('lists counted collections (filled when RM reports it) and non-empty skip lists', () => {
    const out = importRows({
      project_phases: { created: 5, existing: 0 },
      card_types: { created: 1, existing: 4, filled: 3 },
      skipped_card_types: ['old_type'],
    });
    expect(out.rows).toEqual([
      { collection: 'project_phases', created: 5, existing: 0, filled: null },
      { collection: 'card_types', created: 1, existing: 4, filled: 3 },
    ]);
    expect(out.skipped).toEqual([['skipped_card_types', ['old_type']]]);
  });
});
