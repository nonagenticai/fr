// tests/unit/routes/project-brief-delivery.test.ts
//
// DELIVERY, NOT STORAGE.
//
// The defect this whole unit exists to remove is that `constraints`,
// `dependencies` and `risks` were WRITTEN to projects.project_data and read by
// nothing. An exhaustive grep of backend/src for `project_data.<key>` returned
// zero readers for all three.
//
// ⚠️ So a test that asserts the row was written would PASS against the bug. The
// property that matters is that the brief an agent actually receives carries
// the keys: GET /api/projects/:id/brief — the pull-side seam n8n re-fetches
// (routes/projects.ts, X-Webhook-Secret). fr no longer writes a card brief at
// create (fr creates no card — George 2026-10-12, v4 R80/R81), so this seam is
// now the ONLY delivery path.
//
// ⚠️ SCOPE, STATED HONESTLY. These are source-level assertions on the brief
// literal, not end-to-end fetches: driving the seam needs Postgres, Planka
// and a webhook secret, and that belongs in the integration suite. What this
// file buys is that removing a key from a brief fails a test named for
// delivery, instead of passing quietly the way the original omission did. It
// cannot prove the value arrives; it can prove we stopped dropping it.

import { describe, test, expect } from 'bun:test';

const SOURCE = await Bun.file(
  new URL('../../../src/routes/projects.ts', import.meta.url),
).text();

/** The body of `handleGetProjectBrief`, isolated from the rest of the file. */
function pullBrief(): string {
  const start = SOURCE.indexOf('export async function handleGetProjectBrief');
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf('\n}', SOURCE.indexOf('return jsonResponse({', start));
  return SOURCE.slice(start, end);
}

describe('GET /api/projects/:id/brief carries the rules the user set', () => {
  const brief = pullBrief();

  test('constraints are delivered, structured AND rendered', () => {
    // Both: the array so a future enforcement gate has something to check
    // against, the text because an agent reads prose and a discriminated union
    // is not prose.
    expect(brief).toContain('constraints:');
    expect(brief).toContain('constraints_text:');
  });

  test('dependencies and risks are delivered', () => {
    expect(brief).toContain('dependencies:');
    expect(brief).toContain('risks:');
  });

  test('the fields that were already live are untouched', () => {
    // A cleanup that delivers the three new keys by dropping an existing one
    // is not an improvement.
    for (const k of [
      'problem_statement',
      'desired_outcome',
      'business_case',
      'acceptance_criteria',
      'success_criteria',
      'target_packages',
      'scope_level',
    ]) {
      expect(brief).toContain(`${k}:`);
    }
  });
});
