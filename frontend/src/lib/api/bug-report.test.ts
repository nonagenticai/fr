import { describe, it, expect } from 'vitest';
import { isHuntComplete, parseBugReportDetails } from './bug-report';

const bug = (id: string) => ({
  id,
  kind: `kind-${id}`,
  location: { file: `src/${id}.ts`, line: 3 },
  failing_test: { path: `tests/${id}.test.ts`, name: `${id} breaks` },
  fix_outline: ['step one', 'step two'],
});

const hunt = { status: 'completed', scanned_files: 9, tracked_source_files: 9, root_cause_analysis: null };
const v1 = { schema: 'bug_report/v1', hunt, repo: 'nonagenticai/fr', commit_sha: 'abc', bugs: [bug('B2'), bug('B1')] };

describe('parseBugReportDetails', () => {
  it('parses a v1 body and sorts bugs by id (the H_r order)', () => {
    const parsed = parseBugReportDetails(v1);
    expect(parsed?.repo).toBe('nonagenticai/fr');
    expect(parsed?.bugs.map((b) => b.id)).toEqual(['B1', 'B2']);
    expect(parsed?.bugs[0]?.kind).toBe('kind-B1');
    expect(parsed?.bugs[0]?.fix_outline).toEqual(['step one', 'step two']);
    expect(parsed?.hunt).toEqual(hunt);
  });

  it('an empty bugs[] from a complete hunt parses (an honest empty result)', () => {
    expect(parseBugReportDetails({ ...v1, bugs: [] })?.bugs).toEqual([]);
  });

  it('returns null (generic JSON fallback) for anything that is not v1-shaped', () => {
    expect(parseBugReportDetails(null)).toBeNull();
    expect(parseBugReportDetails({ ...v1, schema: 'bug_report/v2' })).toBeNull();
    expect(parseBugReportDetails({ ...v1, hunt: undefined })).toBeNull();
    expect(parseBugReportDetails({ ...v1, hunt: { ...hunt, status: 'partial' } })).toBeNull();
    expect(parseBugReportDetails({ ...v1, hunt: { ...hunt, scanned_files: -1 } })).toBeNull();
    expect(parseBugReportDetails({ ...v1, hunt: { ...hunt, root_cause_analysis: 7 } })).toBeNull();
    expect(parseBugReportDetails({ ...v1, bugs: [{ ...bug('B1'), kind: '' }] })).toBeNull();
    expect(parseBugReportDetails({ ...v1, bugs: [{ ...bug('B1'), location: { file: 'f', line: 'x' } }] })).toBeNull();
    expect(parseBugReportDetails({ ...v1, bugs: [{ ...bug('B1'), fix_outline: [1] }] })).toBeNull();
  });
});

describe('isHuntComplete', () => {
  it('only completed + scanned == tracked + no "Analysis failed: " summary is complete', () => {
    expect(isHuntComplete({ status: 'completed', scanned_files: 9, tracked_source_files: 9, root_cause_analysis: null })).toBe(true);
    expect(isHuntComplete({ status: 'completed', scanned_files: 9, tracked_source_files: 9, root_cause_analysis: 'ok' })).toBe(true);
    expect(isHuntComplete({ status: 'analyzer_failed', scanned_files: 9, tracked_source_files: 9, root_cause_analysis: null })).toBe(false);
    expect(isHuntComplete({ status: 'completed', scanned_files: 8, tracked_source_files: 9, root_cause_analysis: null })).toBe(false);
    expect(
      isHuntComplete({ status: 'completed', scanned_files: 9, tracked_source_files: 9, root_cause_analysis: 'Analysis failed: x' }),
    ).toBe(false);
  });
});
