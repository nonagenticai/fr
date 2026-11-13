import { describe, it, expect } from 'vitest';
import { parseBlockReason, prLink } from './runtime-state';

describe('parseBlockReason', () => {
  it('structured <class>:<exit>:<detail> ⇒ reason', () => {
    expect(parseBlockReason('qa_failed:tests_red:3 failing in importer')).toEqual({
      kind: 'reason',
      cls: 'qa_failed',
      exit: 'tests_red',
      detail: '3 failing in importer',
    });
  });

  it('class `parked` ⇒ wait', () => {
    expect(parseBlockReason('parked:awaiting_merge_queue:slot 3')).toEqual({
      kind: 'wait',
      cls: 'parked',
      exit: 'awaiting_merge_queue',
      detail: 'slot 3',
    });
  });

  // MUST-FAIL control: an implementation that splits on EVERY ':' truncates the
  // detail at "https" / "src/a.ts".
  it('MUST-FAIL control: a detail containing ":" and a URL is kept intact', () => {
    const detail = 'see https://github.com/nonagenticai/ems/pull/7 at src/a.ts:42';
    const r = parseBlockReason(`ci_red:lint:${detail}`);
    expect(r).toEqual({ kind: 'reason', cls: 'ci_red', exit: 'lint', detail });
  });

  it('empty detail is allowed', () => {
    expect(parseBlockReason('ci_red:lint:')).toEqual({ kind: 'reason', cls: 'ci_red', exit: 'lint', detail: '' });
  });

  it('legacy free text ⇒ unstructured, verbatim', () => {
    const raw = 'waiting for George to review the plan';
    expect(parseBlockReason(raw)).toEqual({ kind: 'unstructured', raw });
  });

  it('uppercase or spaced head ⇒ unstructured', () => {
    expect(parseBlockReason('QA_failed:x:y')).toEqual({ kind: 'unstructured', raw: 'QA_failed:x:y' });
    expect(parseBlockReason('qa failed:x:y')).toEqual({ kind: 'unstructured', raw: 'qa failed:x:y' });
    expect(parseBlockReason('Note: tests red')).toEqual({ kind: 'unstructured', raw: 'Note: tests red' });
  });

  it("'' / whitespace / null / number / undefined ⇒ null", () => {
    expect(parseBlockReason('')).toBeNull();
    expect(parseBlockReason('   ')).toBeNull();
    expect(parseBlockReason(null)).toBeNull();
    expect(parseBlockReason(undefined)).toBeNull();
    expect(parseBlockReason(42)).toBeNull();
  });
});

describe('prLink', () => {
  it('valid github PR ⇒ href set, label #<n> <owner>/<repo>', () => {
    expect(
      prLink({
        pr_url: 'https://github.com/nonagenticai/ems/pull/7',
        pr_number: '7',
        pr_repo_owner: 'nonagenticai',
        pr_repo_name: 'ems',
      }),
    ).toEqual({ href: 'https://github.com/nonagenticai/ems/pull/7', label: '#7 nonagenticai/ems' });
  });

  it('missing number/owner/repo ⇒ label falls back to the url text', () => {
    const url = 'https://github.com/nonagenticai/ems/pull/7';
    expect(prLink({ pr_url: url })).toEqual({ href: url, label: url });
  });

  // MUST-FAIL control: an implementation that links any pr_url would emit these
  // as hrefs.
  it('MUST-FAIL control: javascript: and non-github URLs ⇒ href null (text only)', () => {
    expect(prLink({ pr_url: 'javascript:alert(1)' })).toEqual({ href: null, label: 'javascript:alert(1)' });
    expect(prLink({ pr_url: 'https://evil.example/pull/1' })?.href).toBeNull();
    expect(prLink({ pr_url: 'http://github.com/a/b/pull/1' })?.href).toBeNull();
  });

  it('missing / blank pr_url ⇒ null', () => {
    expect(prLink(undefined)).toBeNull();
    expect(prLink({})).toBeNull();
    expect(prLink({ pr_url: '' })).toBeNull();
    expect(prLink({ pr_number: '7' })).toBeNull();
  });
});

