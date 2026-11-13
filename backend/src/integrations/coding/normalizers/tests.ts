/**
 * Tests findings normalizer — only failing test cases produce findings.
 */

import {
  asArray,
  asNumber,
  asString,
  findingId,
  locFrom,
  type Finding,
} from '../types';
import { reportSwallowedFailure } from '../../_lib/errors';

export function normalizeTestsFindings(body: unknown, jobId: string): Finding[] {
  if (!body || typeof body !== 'object') {
    // fr could not READ the response, and returning `[]` says "we read it and
    // there was nothing" — so a malformed or unparseable body lands the job as
    // `succeeded` with 0 findings, indistinguishable from all tests passing.
    // On a quality/test gate that is the worst possible direction to fail in.
    //
    // ⚠️ Reported, not repaired. The siblings `security.ts`/`dependencies.ts`
    // carry a `degraded` bit in their return type; these two return a bare
    // `Finding[]`, so plumbing one through would change the signature and ripple
    // into `adapter.ts` and the job-status surface. That is a design decision
    // about how a degraded scan should present to a user, not a refactor, so it
    // is recorded rather than guessed at. This at least makes the silence
    // visible in the failure ranking today.
    reportSwallowedFailure(new Error('tests normalizer received a non-object body'), {
      service: 'coding-tests-normalizer',
      path: `job:${jobId}`,
      degradedTo: 'zero test findings (renders as all tests passing)',
    });
    return [];
  }
  const r = body as Record<string, unknown>;
  // `body` may be a single TestExecutionResult or a list (batch).
  const list = Array.isArray(r.results)
    ? (r.results as unknown[])
    : Array.isArray(body as unknown[])
      ? (body as unknown[])
      : [body];
  const out: Finding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    // Only failing tests produce findings.
    const success = t.success === true;
    if (success) continue;
    const tests = asArray(t.test_results ?? t.tests ?? [t]);
    for (const tc of tests) {
      const o = (tc ?? {}) as Record<string, unknown>;
      if (o.success === true || o.passed === true) continue;
      const file = asString(o.file ?? o.file_path);
      const line = asNumber(o.line ?? o.line_number);
      const name = asString(o.test_name ?? o.name) ?? 'test failure';
      const kind = asString(
        (o.assertion_details as Record<string, unknown> | undefined)?.kind ?? o.kind,
      );
      out.push({
        id: findingId([jobId, 'tests', file, line, name, kind]),
        job_id: jobId,
        type: 'tests',
        severity: 'high',
        rule_id: kind ?? null,
        title: name,
        message: asString(o.error_message) ?? asString(t.stderr) ?? '',
        ...(locFrom(file, line) ? { location: locFrom(file, line)! } : {}),
        raw: tc,
      });
    }
  }
  return out;
}
