// `isRecordOmission` had no unit coverage, and an adversarial verifier proved
// it: inverting the predicate left all 2124 tests green. A discriminator that
// nothing can kill is a discriminator nobody has checked.
//
// It matters more than a type guard usually would. `ExportOmission` is a union
// of two shapes that overlap on exactly one member (`bucket`):
//
//   screened record   { review_record_id, bucket, exclusion_reason_code, adjudicated }
//   quarantined row   { import_row_id,   bucket: 'quarantined', quarantine_reason }
//
// A renderer that picks the wrong arm does not crash — it reads `undefined` for
// every field it wants and renders a row that says nothing. Inverted, EVERY
// screened exclusion renders as a quarantine and every quarantined row renders
// as a screened record with no reason. That is the `ER-009.3` claim ("an
// omission must be explicit") failing silently, which is the one failure mode
// this whole surface exists to prevent.

import { describe, expect, it } from 'vitest';
import { isRecordOmission, type ExportOmission } from './reviews';

const SCREENED: ExportOmission = {
  review_record_id: '019ffca5-38d3-7000-8000-00000000aaaa',
  bucket: 'excluded',
  exclusion_reason_code: 'wrong_population',
  adjudicated: false,
};

const QUARANTINED: ExportOmission = {
  import_row_id: '019ffca5-38d3-7000-8000-00000000bbbb',
  bucket: 'quarantined',
  quarantine_reason: 'no usable identifier',
};

describe('isRecordOmission tells the two omission shapes apart', () => {
  it('is true for a screened record', () => {
    expect(isRecordOmission(SCREENED)).toBe(true);
  });

  it('is false for a quarantined import row', () => {
    expect(isRecordOmission(QUARANTINED)).toBe(false);
  });

  it('does not discriminate on `bucket`, which both shapes carry', () => {
    // A screened record can also be bucketed `uncertain` or `duplicate_removed`;
    // keying on `bucket === 'quarantined'` would look right and then misclassify
    // a screened record whose bucket the service later spells differently.
    const uncertain: ExportOmission = { ...SCREENED, bucket: 'uncertain' };
    expect(isRecordOmission(uncertain)).toBe(true);

    // And the inverse: a quarantined row is identified by its KEY, not by the
    // literal 'quarantined'.
    const oddlyBucketed = {
      import_row_id: QUARANTINED.import_row_id,
      bucket: 'quarantined',
      quarantine_reason: null,
    } as ExportOmission;
    expect(isRecordOmission(oddlyBucketed)).toBe(false);
  });

  it('routes a mixed list so neither shape is dropped', () => {
    // The failure this guards is not an exception — it is a row that renders
    // blank. So assert on what a renderer would actually read off each arm.
    const omissions: ExportOmission[] = [SCREENED, QUARANTINED, SCREENED];

    const rendered = omissions.map((o) =>
      isRecordOmission(o)
        ? { kind: 'record', id: o.review_record_id, detail: o.exclusion_reason_code }
        : { kind: 'quarantined', id: o.import_row_id, detail: o.quarantine_reason },
    );

    expect(rendered).toEqual([
      { kind: 'record', id: SCREENED.review_record_id, detail: 'wrong_population' },
      { kind: 'quarantined', id: QUARANTINED.import_row_id, detail: 'no usable identifier' },
      { kind: 'record', id: SCREENED.review_record_id, detail: 'wrong_population' },
    ]);

    // Every rendered row carries an id and none is undefined — the inverted
    // predicate fails here rather than merely mislabelling.
    expect(rendered.every((r) => typeof r.id === 'string' && r.id.length > 0)).toBe(true);
  });

  it('never reports both arms for one value', () => {
    for (const o of [SCREENED, QUARANTINED]) {
      const isRecord = isRecordOmission(o);
      const looksQuarantined = 'import_row_id' in o;
      expect(isRecord).toBe(!looksQuarantined);
    }
  });
});
