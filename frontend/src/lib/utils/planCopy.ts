// User-facing copy helpers for the conveyor plan (FR-PROJECT-PAGE-CONVEYOR G1/G10).

/**
 * Agent-written text with internal rule references removed: "(R300)",
 * "(R88, R92)", "the R300 rule" → "the rule", a bare "R185", a leading "R300:". The rest of the
 * sentence is kept verbatim — fr never rewrites what the agent meant.
 */
export function withoutRuleRefs(text: string | null | undefined): string {
  if (text == null) return '';
  return String(text)
    .replace(/\s*\((?:R\d+[a-z]?)(?:\s*[,/;]\s*R\d+[a-z]?)*\)/g, '')
    .replace(/\b(the|a|an)\s+R\d+[a-z]?\s+(rule|ruling)\b/gi, '$1 $2')
    .replace(/,?\s*\bR\d+[a-z]?\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:)])/g, '$1')
    .replace(/^\s*[:;,]\s*/, '')
    .trim();
}

const REASONS: Readonly<Record<string, string>> = {
  no_board: 'the project has no board',
  project_type_missing: 'the project has no project type',
  project_type_not_in_catalogue: "the project's type is not in the catalogue",
  activities_unavailable: 'the activities could not be read',
  rm_project_missing: 'the project has no plan record',
  rm_project_ambiguous: 'the project has more than one plan record',
  project_tenant_unknown: "the project's workspace is unknown",
  MISSING_TENANT: "the project's workspace is unknown",
  UPSTREAM_UNREACHABLE: 'the planning service could not be reached',
  UPSTREAM_TIMEOUT: 'the planning service did not answer in time',
  UPSTREAM_NOT_FOUND: 'the planning service has no such record',
  UPSTREAM_FORBIDDEN: 'the planning service refused the read',
  UPSTREAM_UNAUTHORIZED: 'the planning service refused the read',
};

/** A server `reason` code as a short phrase a person reads. Unknown codes are humanized, never hidden. */
export function unavailableReason(reason: string | null | undefined): string {
  const r = String(reason ?? '').trim();
  if (r === '') return 'unknown reason';
  return REASONS[r] ?? r.replace(/[_-]+/g, ' ').toLowerCase();
}
