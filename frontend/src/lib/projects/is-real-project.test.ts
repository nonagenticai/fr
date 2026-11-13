// src/lib/projects/is-real-project.test.ts
//
// The regression this file exists to stop is subtle and FAILS OPEN.
//
// `GET /api/projects` used to mint synthetic ids `stream:<uuid>` for
// stream-backed boards, and three components each spelled "is this a real
// project?" differently — one of them by testing that `stream:` PREFIX. The
// prefix was removed because it is not a uuid: fed back into a `uuid` column it
// raised SQLSTATE 22P02 and escaped as HTTP 500 (measured on the deployed pod
// 2026-09-04, 13 of 13 500s in a 37-minute window).
//
// A prefix test against the new bare-uuid id does not throw and does not warn —
// it silently matches nothing, so the filter stops filtering and stream boards
// leak back into project pickers and the switcher. That is the same 500 class,
// relocated. `kind` is the discriminator; these tests pin it.

import { describe, expect, test } from 'vitest';
import { isRealProject } from './is-real-project';

const STREAM_UUID = '9b9fc446-3fff-4587-be44-68908427ea32';

describe('isRealProject', () => {
  test('rejects a stream-backed entry by kind', () => {
    expect(isRealProject({ kind: 'continuous' })).toBe(false);
  });

  test('accepts a real project (kind absent, the common case)', () => {
    expect(isRealProject({})).toBe(true);
    expect(isRealProject({ kind: undefined })).toBe(true);
    expect(isRealProject({ kind: null })).toBe(true);
  });

  test('accepts any other kind rather than failing closed on an unknown value', () => {
    // A future `kind` must not silently hide real projects from every picker.
    expect(isRealProject({ kind: 'deliverable' })).toBe(true);
  });

  test('THE REGRESSION: a prefix filter fails OPEN where this does not', () => {
    // The old spelling, kept here as the counter-example. Against the id shape
    // the backend emits today it returns TRUE for a stream board — i.e. it
    // admits exactly what it was written to exclude, with no error.
    const oldPrefixFilter = (p: { id: string }) => !p.id.startsWith('stream:');

    const streamEntry = { id: STREAM_UUID, kind: 'continuous' as const };

    expect(oldPrefixFilter(streamEntry)).toBe(true); // silently wrong
    expect(isRealProject(streamEntry)).toBe(false); // correct
  });

  test('filtering a mixed list keeps only real projects', () => {
    const list = [
      { id: '11111111-1111-4111-8111-111111111111' },
      { id: STREAM_UUID, kind: 'continuous' as const },
      { id: '22222222-2222-4222-8222-222222222222', kind: null },
    ];
    expect(list.filter(isRealProject).map((p) => p.id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });
});
