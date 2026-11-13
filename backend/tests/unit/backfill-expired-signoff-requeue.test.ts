// Pure-logic tests for scripts/backfill-expired-signoff-requeue.ts.
//
// No test doubles (owner ruling 2026-10-29): the run itself (`runBackfill`,
// `main`) needs the real database and Planka, so it is verified live, not here.
// What stays is the logic that has no collaborator — the cutoff and marker
// constants, `scrubMarker`, and the report's accounting check.

import { describe, expect, it } from 'bun:test';

import {
  BACKFILL_ATTEMPT_NOTE,
  BACKFILL_MARKER,
  formatReport,
  scrubMarker,
  type BackfillResult,
} from '../../scripts/backfill-expired-signoff-requeue';

describe('backfill constants', () => {
  it('the marker names the receiver fix so a human can grep for what wrote it', () => {
    expect(BACKFILL_MARKER).toContain('#1316');
    expect(BACKFILL_MARKER).toContain('backfill');
  });

  it('BACKFILL_ATTEMPT_NOTE does not contain BACKFILL_MARKER as a substring', () => {
    expect(BACKFILL_ATTEMPT_NOTE.includes(BACKFILL_MARKER)).toBe(false);
  });
});

describe('scrubMarker', () => {
  it('removes every occurrence, not just the first', () => {
    expect(scrubMarker(`x ${BACKFILL_MARKER} y ${BACKFILL_MARKER} z`)).not.toContain(BACKFILL_MARKER);
    expect(scrubMarker('nothing to scrub')).toBe('nothing to scrub'); // identity control
  });
});

describe('formatReport', () => {
  it('flags an accounting mismatch instead of quietly summing wrong', () => {
    const broken: BackfillResult = {
      mode: 'apply',
      candidates: 3,
      attempted: 3,
      sent: 1,
      failed: 0,
      skipped: {
        'no-todo-list-id': 0,
        'card-read-gone': 0,
        'card-read-degraded': 0,
        'not-blocked': 0,
        'duplicate-card': 0,
        'live-pending-gate': 0,
        'already-claimed': 0,
        'sender-refused': 0,
      },
      verdicts: [],
    };
    expect(formatReport(broken)).toContain('MISMATCH');
  });
});
