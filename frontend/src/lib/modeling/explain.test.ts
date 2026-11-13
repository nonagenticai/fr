import { describe, expect, it } from 'vitest';

import { changeSetStatus, diagnosticText, lossText, opsSummary, runVerdict, svgDataUri, versionName, visibleFindings } from './explain';

const run = (over: Record<string, unknown>) => ({
  status: 'complete' as const,
  clean: true,
  counts: { error: 0, warning: 0, advice: 0 },
  examined: { element: 3 },
  expected: { element: 3 },
  ...over,
});

describe('runVerdict — RM’s stored verdict in words (never recomputed)', () => {
  it('clean', () => expect(runVerdict(run({}))).toMatchObject({ tone: 'success', label: 'Clean' }));
  it('errors', () => {
    const v = runVerdict(run({ clean: false, counts: { error: 2 } }));
    expect(v).toMatchObject({ tone: 'danger', label: '2 errors' });
    expect(v.explanation).toContain('cannot be published');
  });
  it('one error is singular', () => expect(runVerdict(run({ clean: false, counts: { error: 1 } })).label).toBe('1 error'));
  it('not clean without errors (a required rule off)', () =>
    expect(runVerdict(run({ clean: false }))).toMatchObject({ tone: 'warning', label: 'Not clean' }));
  it('incomplete names how much was looked at', () => {
    const v = runVerdict(run({ status: 'incomplete', clean: false, examined: { element: 2 }, expected: { element: 5 } }));
    expect(v.label).toBe('Incomplete');
    expect(v.explanation).toContain('2 of 5');
  });
  it('failed', () => expect(runVerdict(run({ status: 'failed', clean: false })).label).toBe('Could not finish'));
  it('the stored `clean` flag decides, not the counts', () => {
    // RM says not clean although no error counted (a required rule was off): fr does not overrule it.
    expect(runVerdict(run({ clean: false, counts: { error: 0 } })).label).not.toBe('Clean');
  });
});

describe('change sets', () => {
  it('summarises ops by kind and verb', () => {
    expect(
      opsSummary([
        { op: 'create', kind: 'element' },
        { op: 'create', kind: 'element' },
        { op: 'update', kind: 'relationship' },
        { op: 'create', kind: 'view_object' },
      ]),
    ).toBe('2 elements to add, 1 relationship to change, 1 diagram shape to add');
    expect(opsSummary([])).toBe('No changes: the file matches the model.');
  });
  it('status words', () => {
    expect(changeSetStatus('proposed').label).toBe('Ready to apply');
    expect(changeSetStatus('invalid').label).toBe('Cannot be applied');
    expect(changeSetStatus('weird').label).toBe('weird');
  });
  it('hides the import bookkeeping records', () => {
    const f = (rule_id: string) => ({ rule_id, ruleset_id: 'x', severity: 'advice' as const, targets: [], path: null, message: rule_id, evidence: null });
    expect(visibleFindings({ findings: [f('XI-META-001'), f('XI-LOSS-001'), f('AM-REL-001')] }).map((x) => x.rule_id)).toEqual(['AM-REL-001']);
  });
});

describe('exchange losses and diagram notes', () => {
  it('known loss codes in plain words; unknown ones keep RM’s message', () => {
    expect(lossText({ code: 'STAGE-ORGANIZATIONS', id: null, xpath: null, message: 'folders are not stored' })).toContain('Folders');
    expect(lossText({ code: 'NEW-CODE', id: null, xpath: null, message: 'as RM said' })).toBe('as RM said');
  });
  it('diagnostics read their message, else name the code', () => {
    expect(diagnosticText({ message: ' clipped label ' })).toBe('clipped label');
    expect(diagnosticText({ code: 'R-1' })).toBe('Drawing note R-1');
  });
});

describe('svgDataUri — the SVG reaches the page only as a data: URI', () => {
  it('base64, utf-8 safe, round-trips', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Zahlungsdienst — ✓</text></svg>';
    const uri = svgDataUri(svg);
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const bin = atob(uri.slice('data:image/svg+xml;base64,'.length));
    expect(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))).toBe(svg);
  });
});

it('versionName', () => {
  expect(versionName({ seq: 2, label: null })).toBe('Version 2');
  expect(versionName({ seq: 2, label: 'R1' })).toBe('Version 2 — R1');
});
