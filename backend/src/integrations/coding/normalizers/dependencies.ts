/**
 * Dependencies findings normalizer (vulnerable-package / DependencyRiskReport).
 *
 * Upstream shape (the real one — the async poll `result` and the sync report):
 *   DependencyRiskReport {
 *     codebase_id, generated_at, packages, risk_score,
 *     summary: { total_packages, vulnerable_packages, total_vulnerabilities,
 *                critical_vulnerabilities, high_vulnerabilities,
 *                moderate_vulnerabilities, low_vulnerabilities },
 *     vulnerabilities: [
 *       { id, severity, summary, details, references, package_name,
 *         affected_versions, fixed_versions, published_date, modified_date }
 *     ]
 *   }
 * The individual findings live in `vulnerabilities[]`. NOTE the real field
 * names: `id` (NOT cve_id), `package_name` (NOT package/version), `summary`
 * (NOT advisory), `references` (NOT refs). The pre-fix normalizer read the
 * wrong keys, so every dependency Finding shipped with an empty title/message —
 * this is the shape-bug fix. A LEGACY FALLBACK branch preserves the old flat
 * `vulnerable_packages[]` shape so non-async / older payloads don't regress.
 */

import {
  asArray,
  asNumber,
  asString,
  findingId,
  normalizeSeverity,
  type Finding,
} from '../types';

/**
 * Peel the transport/report envelope down to the bare DependencyRiskReport.
 * The report may arrive wrapped as `{ result: {...} }` (async poll record),
 * `{ report: {...} }`, or already unwrapped.
 */
function unwrapDependencyResult(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  let r = body as Record<string, unknown>;
  // Async poll record: { task_id, status, scan_degraded, result }.
  if (r.result && typeof r.result === 'object') {
    r = r.result as Record<string, unknown>;
  }
  // Some report shapes nest under `report`.
  if (r.report && typeof r.report === 'object') {
    r = r.report as Record<string, unknown>;
  }
  return r;
}

export function normalizeDependencyFindings(body: unknown, jobId: string): Finding[] {
  if (!body || typeof body !== 'object') return [];
  const r = unwrapDependencyResult(body);

  // Preferred shape: findings live in `vulnerabilities[]` with the REAL field
  // names (id / package_name / summary / references / affected|fixed_versions).
  const vulns = asArray(r.vulnerabilities);
  if (vulns.length > 0) {
    return vulns.map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      const pkg = asString(o.package_name);
      const cve = asString(o.id);
      const version =
        asString(asArray(o.fixed_versions)[0]) ??
        asString(asArray(o.affected_versions)[0]);
      const refs = asArray(o.references).filter(
        (x): x is string => typeof x === 'string',
      );
      return {
        id: findingId([jobId, 'dependencies', pkg, version, cve]),
        job_id: jobId,
        type: 'dependencies',
        severity: normalizeSeverity(o.severity),
        rule_id: cve ?? null,
        title: pkg && version ? `${pkg}@${version}` : (pkg ?? 'vulnerable dependency'),
        message: asString(o.summary) ?? asString(o.details) ?? '',
        ...(refs.length > 0 ? { refs } : {}),
        raw: it,
      } satisfies Finding;
    });
  }

  // Legacy fallback: flat `vulnerable_packages[]` (or findings) with the old
  // per-item keys — kept so legacy / non-async payloads don't regress.
  const items = asArray(r.vulnerable_packages ?? r.findings ?? r.vulnerabilities);
  return items.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const pkg = asString(o.package ?? o.name);
    const version = asString(o.version);
    const cve = asString(o.cve_id ?? (asArray(o.cve_ids)[0] as string));
    const refs = asArray(o.refs ?? o.cve_ids ?? o.references).filter(
      (x): x is string => typeof x === 'string',
    );
    return {
      id: findingId([jobId, 'dependencies', pkg, version, cve]),
      job_id: jobId,
      type: 'dependencies',
      severity: normalizeSeverity(o.severity),
      rule_id: cve ?? null,
      title: pkg && version ? `${pkg}@${version}` : (pkg ?? 'vulnerable dependency'),
      message: asString(o.advisory) ?? asString(o.description) ?? asString(o.message) ?? '',
      ...(refs.length > 0 ? { refs } : {}),
      raw: it,
    } satisfies Finding;
  });
}

export interface DependencyScanMeta {
  degraded: boolean;
  riskScore?: number;
  totalPackages?: number;
  vulnerablePackages?: number;
  totalVulnerabilities?: number;
}

/**
 * Read the honesty metadata off a DependencyRiskReport (or a wrapping poll
 * envelope). `scan_degraded` may live on the outer poll record OR the inner
 * result — read whichever is present (true wins). Unlike the security scan,
 * the DependencyRiskReport itself carries NO `scan_degraded` field, so the
 * outer poll-record bit is the authoritative source in the async path.
 */
export function readDependencyScanMeta(body: unknown): DependencyScanMeta {
  const outer =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const r = unwrapDependencyResult(body);
  const degraded = outer.scan_degraded === true || r.scan_degraded === true;
  const meta: DependencyScanMeta = { degraded };
  const riskScore = asNumber(r.risk_score ?? outer.risk_score);
  if (riskScore !== undefined) meta.riskScore = riskScore;
  const summary =
    r.summary && typeof r.summary === 'object'
      ? (r.summary as Record<string, unknown>)
      : {};
  const totalPackages = asNumber(summary.total_packages);
  if (totalPackages !== undefined) meta.totalPackages = totalPackages;
  const vulnerablePackages = asNumber(summary.vulnerable_packages);
  if (vulnerablePackages !== undefined) meta.vulnerablePackages = vulnerablePackages;
  const totalVulnerabilities = asNumber(summary.total_vulnerabilities);
  if (totalVulnerabilities !== undefined) meta.totalVulnerabilities = totalVulnerabilities;
  return meta;
}
