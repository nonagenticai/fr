// Tests for the catalog page's malformed-region marker.
//
// These pin BOTH directions, because a marker that over-fires is as much a lie
// as one that under-fires:
//   * the three measured live values must be flagged, and
//   * a legitimate code — including the merely test-SHAPED but well-formed
//     `test-1c869499` that sits right beside them — must NOT be.
//
// They also pin the classification itself: nothing here filters. If a future
// change makes this module drop rows instead of marking them, the last test
// goes red.

import { describe, it, expect } from 'vitest';
import { isMalformedValue, isMalformedRegion } from './page-helpers';

// Measured on the live /admin/licenses/catalog regions list, 2026-09-10.
const LIVE_MALFORMED = ['test-{uuid}', 'test-ebd49b24.hex[:8]}', 'test-f26f2a12.hex[:8]}'];

// Measured on the same list — these are ordinary rows and must stay ordinary.
const LIVE_WELL_FORMED = [
  'test-1c869499',
  'test-4c6761e7',
  'demo-1772531634565',
  'eu',
  'us-east-1',
  'Test Region 2d929549',
  'Demo Region',
];

describe('isMalformedValue', () => {
  it('flags an un-interpolated f-string fragment', () => {
    for (const v of LIVE_MALFORMED) {
      expect(isMalformedValue(v), v).toBe(true);
    }
  });

  it('does not flag a well-formed value, test-shaped or not', () => {
    for (const v of LIVE_WELL_FORMED) {
      expect(isMalformedValue(v), v).toBe(false);
    }
  });

  it('treats an absent value as not-malformed (absence is a different fact)', () => {
    expect(isMalformedValue(null)).toBe(false);
    expect(isMalformedValue(undefined)).toBe(false);
    expect(isMalformedValue('')).toBe(false);
  });
});

describe('isMalformedRegion', () => {
  it('flags a row whose code is junk even when its name reads fine', () => {
    // The live pairing: code and name carry DIFFERENT uuids, which is what
    // proves two separate seeding calls wrote them.
    expect(
      isMalformedRegion({ code: 'test-ebd49b24.hex[:8]}', name: 'Test Region test-1c869499' }),
    ).toBe(true);
  });

  it('flags a row whose name is junk even when its code reads fine', () => {
    expect(isMalformedRegion({ code: 'test-3d33b8da', name: 'Test Region {uuid}' })).toBe(true);
  });

  it('leaves a healthy row alone', () => {
    expect(isMalformedRegion({ code: 'eu', name: 'Europe' })).toBe(false);
    expect(isMalformedRegion({ code: 'test-3d33b8da', name: 'Test Region' })).toBe(false);
  });

  it('classifies rather than filters — every input yields a verdict, never a drop', () => {
    // Guards the whole point of the module: bad rows stay visible. A rewrite
    // that turns this into `regions.filter(...)` cannot satisfy this shape.
    const rows = [
      { code: 'eu', name: 'Europe' },
      { code: 'test-{uuid}', name: 'Test Region' },
    ];
    expect(rows.map(isMalformedRegion)).toEqual([false, true]);
  });
});

// ── fr#1240: THE PLAN FORM MUST NOT OFFER JUNK REGIONS ───────────────────────────
//
// ⚠️ MEASURED on the production `licenses.region` table 2026-09-26/27: 97 rows, 97
// test/demo-shaped, ZERO genuine, and 0 licenses + 0 plans referencing any region — the
// table this filter was written against, and why `regionPickerState` has a hidden-all
// state at all.
//
// ⛔ CORRECTED 2026-09-27 — THAT STATE IS NOW ARMED, NOT LIVE, and the earlier wording
// ("the realistic fixture is 'the filter hides EVERYTHING'") would read as a claim about
// today. The operator purged the catalog (`DELETE 94`); re-measured live,
// `licenses.region` = **0 rows** (non-zero control, same connection: `app` 52, `plan` 89).
// So production takes the `empty` arm and `all-residue-hidden` has zero subjects until
// the unfixed seeder reseeds. The fixtures below stay — they pin a state that must be
// right the moment residue returns — but they describe a possible table, not the current
// one.
import {
  isResidueRegion,
  offerableRegions,
  regionPickerState,
} from './page-helpers';

const GENUINE = { id: 'r-eu', code: 'eu', name: 'Europe' };
// The three shapes actually measured on the live table.
const TEMPLATE = { id: 'r-t1', code: 'test-ebd49b24.hex[:8]}', name: 'Test Region test-1c869499' };
const TEST_SHAPED = { id: 'r-t2', code: 'test-3d33b8da', name: 'Test Region' };
const NAME_ONLY_JUNK = { id: 'r-t3', code: 'eu-west', name: 'Region {uuid}' };

describe('isResidueRegion', () => {
  it('catches the test-prefixed rows the toggle already means for apps', () => {
    expect(isResidueRegion(TEST_SHAPED)).toBe(true);
    expect(isResidueRegion(TEMPLATE)).toBe(true);
  });

  it('catches a malformed NAME on a clean code — which is why it is a UNION', () => {
    // `isTestApp('eu-west')` is false, so the malformed arm is the only thing that can
    // flag this. Dropping either half of the union loses a real case.
    expect(isResidueRegion(NAME_ONLY_JUNK)).toBe(true);
  });

  it('leaves a genuine region alone', () => {
    // The negative control. Without it, `() => true` satisfies every case above.
    expect(isResidueRegion(GENUINE)).toBe(false);
  });
});

describe('offerableRegions', () => {
  it('withholds residue by default and offers everything when asked', () => {
    const all = [GENUINE, TEMPLATE, TEST_SHAPED, NAME_ONLY_JUNK];
    expect(offerableRegions(all, false).map((r) => r.id)).toEqual(['r-eu']);
    expect(offerableRegions(all, true).map((r) => r.id)).toEqual([
      'r-eu',
      'r-t1',
      'r-t2',
      'r-t3',
    ]);
  });

  it('does not mutate or reorder the caller’s array', () => {
    const all = [TEMPLATE, GENUINE];
    offerableRegions(all, false);
    expect(all.map((r) => r.id)).toEqual(['r-t1', 'r-eu']);
  });
});

describe('regionPickerState', () => {
  // The production shape: rows exist, all of them residue, filter on.
  const ALL_RESIDUE = [TEMPLATE, TEST_SHAPED, NAME_ONLY_JUNK];

  it('ALL-HIDDEN is its own state — not "empty"', () => {
    // ⛔ THE ASSERTION THE WHOLE STATE EXISTS FOR. 3 rows read, 0 offered. Keyed on the
    // offered count alone this is indistinguishable from a deployment with no regions,
    // and telling an operator "no regions configured" while 3 sit behind their own
    // checkbox is the absence-rendered-as-a-result defect.
    const offered = offerableRegions(ALL_RESIDUE, false).length;
    expect(offered).toBe(0);
    expect(regionPickerState(true, ALL_RESIDUE.length, offered, null)).toBe(
      'all-residue-hidden',
    );
  });

  it('DISCRIMINATING PAIR: genuinely zero rows IS "empty"', () => {
    // Same offered count (0), different total. A single-count implementation returns
    // the same verdict for both of these; this pair is what refutes it.
    expect(regionPickerState(true, 0, 0, null)).toBe('empty');
    expect(regionPickerState(true, 3, 0, null)).toBe('all-residue-hidden');
  });

  it('the same rows with the toggle ON are simply ready', () => {
    const offered = offerableRegions(ALL_RESIDUE, true).length;
    expect(offered).toBe(3);
    expect(regionPickerState(true, ALL_RESIDUE.length, offered, null)).toBe('ready');
  });

  it('a failed read outranks every count — it is never "empty" or "all hidden"', () => {
    // Inherited from `directoryReadState`, whose docblock argues it: a refresh that
    // failed beside stale rows is showing a stale set as if it were current.
    expect(regionPickerState(true, 0, 0, 'HTTP 503')).toBe('unreadable');
    expect(regionPickerState(true, 3, 0, 'HTTP 503')).toBe('unreadable');
  });

  it('in flight is "loading", not a claim about what exists', () => {
    // The fourth state, and the reason `directoryReadState` is reused rather than
    // `scopeRefState`: before the read lands, 0 rows is not a fact about the table.
    expect(regionPickerState(false, 0, 0, null)).toBe('loading');
  });
});
