/**
 * Quality findings normalizer (linter / static-analysis output).
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
import { reportSwallowedFailure } from '../../_lib/errors';

export function normalizeQualityFindings(body: unknown, jobId: string): Finding[] {
  if (!body || typeof body !== 'object') {
    // fr could not READ the response, and returning `[]` says "we read it and
    // there was nothing" — so a malformed or unparseable body lands the job as
    // `succeeded` with 0 findings, indistinguishable from clean code.
    // On a quality/test gate that is the worst possible direction to fail in.
    //
    // ⚠️ Reported, not repaired. The siblings `security.ts`/`dependencies.ts`
    // carry a `degraded` bit in their return type; these two return a bare
    // `Finding[]`, so plumbing one through would change the signature and ripple
    // into `adapter.ts` and the job-status surface. That is a design decision
    // about how a degraded scan should present to a user, not a refactor, so it
    // is recorded rather than guessed at. This at least makes the silence
    // visible in the failure ranking today.
    reportSwallowedFailure(new Error('quality normalizer received a non-object body'), {
      service: 'coding-quality-normalizer',
      path: `job:${jobId}`,
      degradedTo: 'zero quality findings (renders as clean code)',
    });
    return [];
  }
  const r = body as Record<string, unknown>;
  const items = asArray(r.issues ?? r.findings);
  return items.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const file = asString(
      o.file ?? o.file_path ?? (o.location as Record<string, unknown> | undefined)?.file,
    );
    const line = asNumber(
      o.line ?? (o.location as Record<string, unknown> | undefined)?.line,
    );
    const ruleId = asString(o.rule_id ?? o.rule ?? o.code);
    return {
      id: findingId([jobId, 'quality', file, line, ruleId]),
      job_id: jobId,
      type: 'quality',
      severity: normalizeSeverity(o.severity),
      rule_id: ruleId ?? null,
      title: asString(o.rule_description) ?? asString(o.title) ?? ruleId ?? 'quality issue',
      message: asString(o.message) ?? asString(o.detail) ?? '',
      ...(locFrom(file, line) ? { location: locFrom(file, line)! } : {}),
      raw: it,
    };
  });
}
