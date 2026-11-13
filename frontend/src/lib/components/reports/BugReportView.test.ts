// @vitest-environment jsdom
//
// U2 — the typed bug_report renderer. Shows hunt.status and scanned/tracked
// counts. A hunt that is not complete (only reachable by a row written around
// the route) renders as a LOUD failure, never as "no bugs"; a complete empty hunt
// says it found none; trace_id is shown or marked as an orphan write.
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import BugReportView from './BugReportView.svelte';
import type { BugReportDetails } from '$lib/api/bug-report';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  host?.remove();
});

function render(details: BugReportDetails, traceId: string | null = null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = mount(BugReportView, { target: host, props: { details, contentHash: 'a'.repeat(64), traceId } });
  flushSync();
}
const $ = (id: string) => host.querySelector(`[data-testid="${id}"]`);

const hunt = { status: 'completed' as const, scanned_files: 7, tracked_source_files: 7, root_cause_analysis: null };
const base: BugReportDetails = { schema: 'bug_report/v1', hunt, repo: 'r', commit_sha: 'c', bugs: [] };
const bug = {
  id: 'B1',
  kind: 'null-deref',
  location: { file: 'src/a.ts', line: 3 },
  failing_test: { path: 't/a.test.ts', name: 'a breaks' },
  fix_outline: ['guard'],
};

describe('BugReportView', () => {
  it('shows hunt.status and scanned / tracked counts', () => {
    render(base);
    expect($('bug-report-hunt-status')?.textContent?.trim()).toBe('completed');
    expect($('bug-report-hunt-coverage')?.textContent?.trim()).toBe('7 / 7');
  });

  it('an incomplete hunt (failed, partial, or "Analysis failed: " summary) is a danger banner, never "found no bugs"', () => {
    for (const h of [
      { ...hunt, status: 'analyzer_failed' as const },
      { ...hunt, scanned_files: 6 },
      { ...hunt, root_cause_analysis: 'Analysis failed: boom' },
    ]) {
      render({ ...base, hunt: h });
      expect($('bug-report-hunt-failed')?.getAttribute('role')).toBe('alert');
      expect($('bug-report-result-unknown')).not.toBeNull();
      expect($('bug-report-no-bugs')).toBeNull();
      unmount(app!);
      app = null;
      host.remove();
    }
  });

  it('completed + empty: says the hunt found no bugs, no failure banner', () => {
    render(base);
    expect($('bug-report-no-bugs')?.textContent).toContain('found no bugs');
    expect($('bug-report-hunt-failed')).toBeNull();
    expect(host.querySelectorAll('[data-testid="bug-report-row"]').length).toBe(0);
  });

  it('completed with bugs: one row per bug', () => {
    render({ ...base, bugs: [bug, { ...bug, id: 'B2' }] });
    expect(host.querySelectorAll('[data-testid="bug-report-row"]').length).toBe(2);
    expect($('bug-report-kind')?.textContent?.trim()).toBe('null-deref');
    expect($('bug-report-hunt-failed')).toBeNull();
  });

  it('shows the trace_id, or marks the write as an orphan', () => {
    render(base, '01999f3c-0000-7000-8000-000000000001');
    expect($('bug-report-trace')?.textContent?.trim()).toBe('01999f3c-0000-7000-8000-000000000001');
    unmount(app!);
    app = null;
    host.remove();
    render(base, null);
    expect($('bug-report-trace')?.textContent).toContain('orphan');
  });
});
