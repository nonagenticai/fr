// `actionBucketOf` is a MIRROR of a SQL expression, so it is tested against what
// that SQL actually did — not against what the field looks like it should do.
//
// ⭐ EVERY EXPECTATION BELOW WAS MEASURED, not reasoned. The twelve rows here
// were inserted into a real Postgres 18 and bucketed by
// `backend/src/routes/approvals.ts :: deblockActionBucket` verbatim
// (`select (case …), count(*) … group by 1`, plus one
// `where (case …) = $1` per bucket). The observed grouping was:
//
//     QUESTION 3   ('QUESTION' ×2, and ' QUESTION ' — btrim)
//     RETRY    1
//     none     5   ('', '   ', JSON null, absent key, NULL metadata)
//     other    3   ('question' lower-case, 'WAT', and the NUMBER 123)
//
// ⛔ THAT LAST ONE IS WHY THIS FILE EXISTS. `actionBucketOf` originally copied
// `deblockActionOf` in `./question.ts` — `typeof raw !== 'string' → none` — and
// that is WRONG against the server, because `metadata ->> 'deblock_action'`
// renders a JSON number as its text. The consequence was not cosmetic: under
// `?deblock_action=other` the server SENDS such a row and the page's client-side
// belt would have hidden it, so the chip would read "Unrecognised 3" above two
// rendered rows. A mirror that disagrees with the thing it mirrors turns the
// safety belt into the defect.
//
// ⚠️ These two functions are deliberately NOT unified. `deblockActionOf` answers
// "what does this row SAY?" for the row BADGE, where rendering `123` as an
// action would be noise; `actionBucketOf` answers "which server bucket is this
// row in?", where agreeing with the server is the entire contract. Same field,
// two questions, two right answers.
//
// MUTATION CONTROL for this file: restore `if (typeof raw !== 'string') return
// ACTION_BUCKET_NONE;` as the first line of `actionBucketOf` and the
// "non-string" case reds while every string case stays green — which is exactly
// how the defect survived being written.

import { describe, it, expect } from 'vitest';
import {
  actionBucketOf,
  actionFacetLabel,
  ACTION_BUCKETS,
  DEBLOCK_ACTIONS,
} from './action-facets';

const row = (deblock_action: unknown) =>
  deblock_action === undefined ? { metadata: {} } : { metadata: { deblock_action } };

describe('actionBucketOf mirrors the server bucketing CASE', () => {
  it('buckets a closed-set member as itself', () => {
    for (const action of DEBLOCK_ACTIONS) {
      expect(actionBucketOf(row(action)), action).toBe(action);
    }
  });

  it('trims, exactly as btrim() does server-side', () => {
    // Measured: ' QUESTION ' landed in the QUESTION group, not in `other`.
    expect(actionBucketOf(row(' QUESTION '))).toBe('QUESTION');
    expect(actionBucketOf(row('\tRETRY\n'))).toBe('RETRY');
  });

  it('calls absent, null, empty and whitespace-only `none` — the five-row cohort', () => {
    expect(actionBucketOf(row(undefined))).toBe('none');
    expect(actionBucketOf(row(null))).toBe('none');
    expect(actionBucketOf(row(''))).toBe('none');
    expect(actionBucketOf(row('   '))).toBe('none');
    // No `metadata` key at all — the shape every non-n8n approval has.
    expect(actionBucketOf({})).toBe('none');
    expect(actionBucketOf({ metadata: null })).toBe('none');
  });

  it('calls a NON-STRING `other`, because `->>` renders it as text', () => {
    // ⭐ THE MEASURED CASE. The number 123 grouped under `other` server-side.
    // Returning `none` here — the obvious reading of an untyped jsonb field, and
    // what `deblockActionOf` correctly does for the badge — desynchronises the
    // belt from the filter.
    expect(actionBucketOf(row(123))).toBe('other');
    expect(actionBucketOf(row(true))).toBe('other');
    expect(actionBucketOf(row({ a: 1 }))).toBe('other');
    expect(actionBucketOf(row(['QUESTION']))).toBe('other');
  });

  it('is case-SENSITIVE, so a lower-case action is `other` on both sides', () => {
    // Measured: 'question' grouped under `other`, with 'WAT'. That is the honest
    // answer — `asDeblockAction` drops it, so the callback can never act on it.
    expect(actionBucketOf(row('question'))).toBe('other');
    expect(actionBucketOf(row('WAT'))).toBe('other');
  });

  it('never returns a bucket the chip row cannot render', () => {
    // The chips iterate ACTION_BUCKETS. A bucket outside it is a row counted in
    // `total` that no facet can reach — the "counted nowhere" failure the server
    // added an `other` bucket to prevent, re-entered from the client side.
    const samples = [...DEBLOCK_ACTIONS, ' QUESTION ', '', '  ', 'wat', 7, null, undefined, {}];
    for (const sample of samples) {
      expect(ACTION_BUCKETS, String(sample)).toContain(actionBucketOf(row(sample)));
    }
  });
});

describe('actionFacetLabel', () => {
  it('keeps the wire spelling for real actions, so the chip matches the row badge', () => {
    // The row chip renders the stored string verbatim
    // (`approval-deblock-chip`). A prettified "Question" on the facet and a
    // "QUESTION" on the row are two names for one thing on one screen.
    for (const action of DEBLOCK_ACTIONS) {
      expect(actionFacetLabel(action)).toBe(action);
    }
  });

  it('names the two synthetic buckets in the operator\'s terms, not the wire\'s', () => {
    // `none` and `other` are not actions and must not look like ones.
    expect(actionFacetLabel('none')).toBe('No action');
    expect(actionFacetLabel('other')).toBe('Unrecognised');
    expect(actionFacetLabel('all')).toBe('All');
  });
});
