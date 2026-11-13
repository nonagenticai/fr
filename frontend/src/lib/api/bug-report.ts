// bug-report.ts
//
// U2 — the typed view of a `report_type: 'bug_report'` report's `details`
// (backend/src/lib/bug-report-hash.ts BugReportDetailsSchema, schema id
// `bug_report/v1`, as agreed with the U1 owner 10-01). The backend validated
// the body on write; this parser is a RENDER guard, not a validator: anything
// that does not have the v1 shape returns null and the page falls back to the
// generic JSON view, so an unexpected row is shown raw rather than half-rendered.

export interface BugReportBug {
  /** Content fingerprint: sha256(file "\n" line "\n" kind), lowercase hex. */
  id: string;
  kind: string;
  location: { file: string; line: number };
  failing_test: { path: string; name: string };
  fix_outline: string[];
  severity?: string;
  confidence?: number;
}

export type HuntStatus = 'completed' | 'analyzer_failed';

/**
 * The backend stores a report only when the hunt COMPLETED over every tracked
 * source file and its root_cause_analysis does not start "Analysis failed: ".
 * The renderer still checks (`isHuntComplete`) so a row written around the
 * route can never show an empty list as a clean result.
 */
export interface BugReportHunt {
  status: HuntStatus;
  scanned_files: number;
  tracked_source_files: number;
  root_cause_analysis: string | null;
}

export interface BugReportDetails {
  schema: 'bug_report/v1';
  hunt: BugReportHunt;
  repo: string;
  commit_sha: string;
  bugs: BugReportBug[];
}

export const ANALYSIS_FAILED_PREFIX = 'Analysis failed: ';

export function isHuntComplete(h: BugReportHunt): boolean {
  return (
    h.status === 'completed' &&
    h.scanned_files === h.tracked_source_files &&
    !(h.root_cause_analysis ?? '').startsWith(ANALYSIS_FAILED_PREFIX)
  );
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

function parseHunt(v: unknown): BugReportHunt | null {
  if (!isObj(v)) return null;
  if (v.status !== 'completed' && v.status !== 'analyzer_failed') return null;
  if (!isCount(v.scanned_files) || !isCount(v.tracked_source_files)) return null;
  if (v.root_cause_analysis !== null && typeof v.root_cause_analysis !== 'string') return null;
  return {
    status: v.status,
    scanned_files: v.scanned_files,
    tracked_source_files: v.tracked_source_files,
    root_cause_analysis: v.root_cause_analysis,
  };
}

function parseBug(v: unknown): BugReportBug | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.kind)) return null;
  const loc = v.location;
  const ft = v.failing_test;
  if (!isObj(loc) || !isStr(loc.file) || !Number.isInteger(loc.line)) return null;
  if (!isObj(ft) || !isStr(ft.path) || !isStr(ft.name)) return null;
  if (!Array.isArray(v.fix_outline) || !v.fix_outline.every(isStr)) return null;
  return {
    id: v.id,
    kind: v.kind,
    location: { file: loc.file, line: loc.line as number },
    failing_test: { path: ft.path, name: ft.name },
    fix_outline: v.fix_outline as string[],
    ...(isStr(v.severity) ? { severity: v.severity } : {}),
    ...(typeof v.confidence === 'number' ? { confidence: v.confidence } : {}),
  };
}

/** The v1 details, bugs sorted by id (the order H_r hashes them in), or null. */
export function parseBugReportDetails(details: unknown): BugReportDetails | null {
  if (!isObj(details) || details.schema !== 'bug_report/v1') return null;
  const hunt = parseHunt(details.hunt);
  if (!hunt) return null;
  if (!isStr(details.repo) || !isStr(details.commit_sha) || !Array.isArray(details.bugs)) return null;
  const bugs: BugReportBug[] = [];
  for (const b of details.bugs) {
    const parsed = parseBug(b);
    if (!parsed) return null;
    bugs.push(parsed);
  }
  bugs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schema: 'bug_report/v1', hunt, repo: details.repo, commit_sha: details.commit_sha, bugs };
}
