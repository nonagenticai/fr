/**
 * Security findings normalizer.
 *
 * Maps the upstream `coding-security` SecurityScanResult into the FR `Finding`
 * envelope. See spec §"Normalized envelopes" — security branch.
 *
 * Upstream shape (the real one — the async poll `result` and the sync report):
 *   {
 *     scan_degraded, security_grade, total_vulnerabilities, total_files_scanned,
 *     vulnerability_summary: { type -> count },
 *     file_results: [
 *       { file_path, language, cve_ids: string[],
 *         violations: [{ type, severity, line_number, pattern_matched,
 *                        description, suggested_fix }] }
 *     ]
 *   }
 * The individual findings live in `file_results[].violations[]` — there is NO
 * top-level `findings` array. A violation carries NO file_path/cve_id (those are
 * on the parent FileSecurityResult), so we attach the parent's file_path,
 * language and cve_ids to each mapped Finding.
 */

import {
  asArray,
  asNumber,
  asString,
  findingId,
  locFrom,
  normalizeSeverity,
  type Finding,
} from '../types';

/**
 * Peel the transport/report envelope down to the bare SecurityScanResult object.
 * The result may arrive wrapped as `{ result: {...} }` (async poll record),
 * `{ report: {...} }`, or already unwrapped. Handles one level of nesting
 * (e.g. `report.scan_summary`).
 */
function unwrapSecurityResult(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  let r = body as Record<string, unknown>;
  // Async poll record: { task_id, status, scan_degraded, result }.
  if (r.result && typeof r.result === 'object') {
    r = r.result as Record<string, unknown>;
  }
  // Some report shapes nest the scan under `report`.
  if (r.report && typeof r.report === 'object') {
    r = r.report as Record<string, unknown>;
  }
  return r;
}

export function normalizeSecurityFindings(body: unknown, jobId: string): Finding[] {
  if (!body || typeof body !== 'object') return [];
  const r = unwrapSecurityResult(body);

  // Preferred shape: findings live in file_results[].violations[].
  const fileResults = asArray(r.file_results);
  if (fileResults.length > 0) {
    return fileResults.flatMap((fr) => {
      const parent = (fr ?? {}) as Record<string, unknown>;
      const file = asString(parent.file_path ?? parent.file);
      const cveIds = asArray(parent.cve_ids).filter(
        (x): x is string => typeof x === 'string',
      );
      const violations = asArray(parent.violations);
      return violations.map((v) => {
        const o = (v ?? {}) as Record<string, unknown>;
        const line = asNumber(o.line_number ?? o.line);
        const vType = asString(o.type);
        const ruleId = vType ?? (cveIds.length > 0 ? cveIds[0]! : null);
        return {
          id: findingId([jobId, 'security', file, line, ruleId, asString(o.pattern_matched)]),
          job_id: jobId,
          type: 'security',
          severity: normalizeSeverity(o.severity),
          rule_id: ruleId ?? null,
          title: vType ?? 'security finding',
          message:
            asString(o.description) ??
            asString(o.pattern_matched) ??
            'security finding',
          ...(locFrom(file, line) ? { location: locFrom(file, line)! } : {}),
          ...(asString(o.suggested_fix) ? { remediation: asString(o.suggested_fix)! } : {}),
          ...(cveIds.length > 0 ? { refs: cveIds } : {}),
          raw: v,
        } satisfies Finding;
      });
    });
  }

  // Fallback for other/legacy shapes (flat findings/vulnerabilities/issues
  // arrays) so existing fixtures and non-async payloads don't regress.
  const items = asArray(r.findings ?? r.vulnerabilities ?? r.issues);
  return items.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const file = asString(o.file_path ?? o.file);
    const line = asNumber(o.line_number ?? o.line);
    const ruleId = asString(o.rule_id ?? o.cve_id ?? (asArray(o.cve_ids)[0] as string));
    const refs = asArray(o.cve_ids).filter((x): x is string => typeof x === 'string');
    return {
      id: findingId([jobId, 'security', file, line, ruleId, asString(o.vulnerability_type)]),
      job_id: jobId,
      type: 'security',
      severity: normalizeSeverity(o.severity),
      rule_id: ruleId ?? null,
      title: asString(o.vulnerability_type) ?? asString(o.title) ?? 'security finding',
      message: asString(o.description) ?? asString(o.message) ?? '',
      ...(locFrom(file, line) ? { location: locFrom(file, line)! } : {}),
      ...(asString(o.remediation) ? { remediation: asString(o.remediation)! } : {}),
      ...(refs.length > 0 ? { refs } : {}),
      raw: it,
    };
  });
}

export interface SecurityScanMeta {
  degraded: boolean;
  grade?: string;
  total_vulnerabilities?: number;
  total_files_scanned?: number;
}

/**
 * Read the honesty metadata off a SecurityScanResult (or a wrapping envelope).
 * `scan_degraded` may live on the outer poll record OR the inner result — read
 * whichever is present (true wins).
 */
export function readSecurityScanMeta(body: unknown): SecurityScanMeta {
  const outer =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const r = unwrapSecurityResult(body);
  const degraded = outer.scan_degraded === true || r.scan_degraded === true;
  const meta: SecurityScanMeta = { degraded };
  const grade = asString(r.security_grade ?? outer.security_grade);
  if (grade) meta.grade = grade;
  const totalVulns = asNumber(r.total_vulnerabilities ?? outer.total_vulnerabilities);
  if (totalVulns !== undefined) meta.total_vulnerabilities = totalVulns;
  const totalFiles = asNumber(r.total_files_scanned ?? outer.total_files_scanned);
  if (totalFiles !== undefined) meta.total_files_scanned = totalFiles;
  return meta;
}
