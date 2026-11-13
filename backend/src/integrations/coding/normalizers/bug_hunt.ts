/**
 * Bug-hunt findings normalizer.
 *
 * Handles both the synchronous `errors[]` shape (from /hunt fallback) and the
 * asynchronous `findings[]` report shape.
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

export function normalizeBugHuntFindings(body: unknown, jobId: string): Finding[] {
  if (!body || typeof body !== 'object') return [];
  const r = body as Record<string, unknown>;
  // Both `errors` (synchronous) and `findings` (report list) shapes seen.
  const items = asArray(r.errors ?? r.findings ?? r.bugs);
  return items.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const file = asString(o.file ?? o.file_path);
    const line = asNumber(o.line ?? o.line_number);
    const symbol = asString(o.function ?? o.symbol);
    return {
      id: findingId([jobId, 'bug_hunt', file, line, symbol, asString(o.error_type)]),
      job_id: jobId,
      type: 'bug_hunt',
      severity: normalizeSeverity(o.risk_assessment ?? o.severity ?? o.risk),
      rule_id: asString(o.error_type) ?? null,
      title: asString(o.error_type) ?? 'bug',
      message: asString(o.context) ?? asString(o.message) ?? asString(o.description) ?? '',
      ...(locFrom(file, line, symbol) ? { location: locFrom(file, line, symbol)! } : {}),
      raw: it,
    };
  });
}
