// scopeRefs — the scope-reference (projects / departments) read contract.
//
// THE DEFECT these pin: a failed `/api/projects` or `tenancy.listDepartments()`
// was degraded to `[]`, which is byte-identical to a tenant that genuinely has
// none. Every consumer gates its control on `length > 0`, so an outage deleted
// the control and the surface looked complete — while `AssetCreateScopePicker`
// went one worse and printed an INSTRUCTION ("switch to tenant-wide").

import { describe, it, expect } from 'vitest';
import { directoryReadState, readFailureReason, scopeRefState } from './scopeRefs';

describe('readFailureReason', () => {
  it('keeps the upstream reason — it is what decides whether retrying can work', () => {
    expect(readFailureReason(new Error('HTTP 403 forbidden'), 'fallback')).toBe(
      'HTTP 403 forbidden',
    );
  });

  it('falls back when the throw carries no message at all', () => {
    expect(readFailureReason(new Error(''), 'project list unreadable')).toBe(
      'project list unreadable',
    );
    expect(readFailureReason(new Error('   '), 'project list unreadable')).toBe(
      'project list unreadable',
    );
    expect(readFailureReason(undefined, 'project list unreadable')).toBe(
      'project list unreadable',
    );
    expect(readFailureReason(null, 'project list unreadable')).toBe(
      'project list unreadable',
    );
  });

  it('never returns an empty string — every caller reads that as success', () => {
    for (const thrown of [new Error(''), '', null, undefined, {}]) {
      expect(readFailureReason(thrown, 'read failed').length).toBeGreaterThan(0);
    }
  });

  it('stringifies a non-Error throw rather than dropping it', () => {
    expect(readFailureReason('upstream timed out', 'read failed')).toBe(
      'upstream timed out',
    );
  });
});

describe('scopeRefState', () => {
  it('a failed read is UNREADABLE, never the empty state', () => {
    expect(scopeRefState(0, 'HTTP 502')).toBe('unreadable');
  });

  it('stays unreadable even when stale rows survive from an earlier tick', () => {
    expect(scopeRefState(7, 'HTTP 502')).toBe('unreadable');
  });

  it('a successful read of nothing is empty — the only claim it earned', () => {
    expect(scopeRefState(0, null)).toBe('empty');
    expect(scopeRefState(0, undefined)).toBe('empty');
    // An empty-string reason is no reason at all.
    expect(scopeRefState(0, '')).toBe('empty');
  });

  it('is ready when there are targets and no failure', () => {
    expect(scopeRefState(3, null)).toBe('ready');
  });
});

describe('directoryReadState', () => {
  // THE DEFECT this pins: `scopeRefState` cannot express the IN-FLIGHT window of
  // an async read. With no rows and no recorded failure it answers 'empty', which
  // is what made the approver pickers render "No members are listed for this
  // tenant. The directory WAS read — add an approver by user id below." while
  // the request was still open: a claim the read had completed, plus an
  // instruction to paste a raw user id, on the strength of nothing.

  it('an unsettled read is LOADING, never empty', () => {
    expect(directoryReadState(false, 0, null)).toBe('loading');
    expect(directoryReadState(false, 0, undefined)).toBe('loading');
    // An empty-string reason is no reason at all — still loading, not failed.
    expect(directoryReadState(false, 0, '')).toBe('loading');
  });

  it('a recorded failure outranks not-yet-loaded — the read is over', () => {
    // On failure the dialogs deliberately leave `loaded` false so that reopening
    // retries. If `loading` won here, a dead directory would sit on "Loading…"
    // forever and never be reported.
    expect(directoryReadState(false, 0, 'HTTP 502')).toBe('unreadable');
    expect(directoryReadState(false, 7, 'HTTP 502')).toBe('unreadable');
  });

  it('a completed read of nothing is EMPTY — the only claim it earned', () => {
    expect(directoryReadState(true, 0, null)).toBe('empty');
  });

  it('is ready only when the read completed AND named somebody', () => {
    expect(directoryReadState(true, 3, null)).toBe('ready');
  });
});
