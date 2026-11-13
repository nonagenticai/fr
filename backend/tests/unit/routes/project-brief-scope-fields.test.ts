// tests/unit/routes/project-brief-scope-fields.test.ts
//
// `in_scope`, `out_of_scope`, `high_level_requirements` and `assumptions` were
// accepted by ProjectCreateSchema, persisted into project_data, and read by
// NOTHING. A test that asserts the row was written would pass against that bug,
// so every assertion here is about what an agent RECEIVES.
//
// ⚠️ SCOPE, STATED HONESTLY (same boundary as project-brief-delivery.test.ts):
// the behavioural half exercises `scopeFieldsForBrief`, the real function the
// brief literal spreads. The wiring half is a source-level assertion that the
// literal actually spreads it — importing and calling the brief builder
// end-to-end needs Postgres, Planka and a webhook secret. Together they buy:
// the renderer cannot silently start emitting an empty key, AND the renderer
// cannot be silently unplugged from the brief.

import { describe, test, expect } from 'bun:test';

import {
  scopeFieldsForBrief,
  BRIEF_SCOPE_FIELDS,
} from '../../../src/routes/projects';

/** Render the way a brief spreads it. */
function renderBrief(src: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'project_start_request', ...scopeFieldsForBrief(src) }, null, 2);
}

const FULL = {
  in_scope: ['the ingestion worker', 'the retry path'],
  out_of_scope: ['the billing ledger'],
  high_level_requirements: ['must drain the queue within 5 minutes'],
  assumptions: ['the upstream feed keeps its current schema'],
};

describe('all four scope fields reach the brief', () => {
  // KILL: delete any one of the four keys from BRIEF_SCOPE_FIELDS in
  // routes/projects.ts — that field's content disappears from the brief and
  // this test fails.
  test('each field name and each of its items appears in the brief text', () => {
    const brief = renderBrief(FULL);
    for (const [key, items] of Object.entries(FULL)) {
      expect(brief).toContain(`"${key}"`);
      for (const item of items) expect(brief).toContain(item);
    }
  });

  test('BRIEF_SCOPE_FIELDS is exactly the four fields the owner ruled on', () => {
    // KILL: adding a fifth key (e.g. re-wiring `access_requirements`, which is
    // a standing KEEP-and-ignore decision) fails here rather than silently
    // widening what the agent is told.
    expect([...BRIEF_SCOPE_FIELDS]).toEqual([
      'in_scope',
      'out_of_scope',
      'high_level_requirements',
      'assumptions',
    ]);
  });
});

describe('an absent field renders as nothing at all', () => {
  // KILL: emit the key unconditionally (`out[key] = items` outside the
  // `items.length > 0` guard, or an `?? []` fallback like the legacy array
  // keys use) — `"in_scope": []` appears and this test fails.
  test('no key, no empty array, no "undefined"', () => {
    const brief = renderBrief({ problem_statement: 'p', desired_outcome: 'o' });
    for (const key of BRIEF_SCOPE_FIELDS) expect(brief).not.toContain(key);
    expect(brief).not.toContain('undefined');
    expect(brief).not.toContain('[]');
    expect(scopeFieldsForBrief({})).toEqual({});
    expect(scopeFieldsForBrief(undefined)).toEqual({});
  });
});

describe('an EMPTY array is treated exactly as an absent one', () => {
  // KILL: treat `[]` as present (drop the `items.length > 0` guard) — the key
  // appears as `"in_scope": []`, which tells the agent "the requester answered
  // and named nothing", a different and false claim from "did not answer".
  test('[] produces the same brief as omitting the field', () => {
    const empty = renderBrief({ in_scope: [], out_of_scope: [], high_level_requirements: [], assumptions: [] });
    const absent = renderBrief({});
    expect(empty).toBe(absent);
  });

  test('an array of blanks is empty too', () => {
    // KILL: drop the trim/length filter — `"in_scope": ["", "   "]` reaches the
    // agent as content.
    expect(scopeFieldsForBrief({ in_scope: ['', '   '] })).toEqual({});
  });

  test('non-string jsonb entries are dropped, not coerced', () => {
    // KILL: remove the typeof filter — legacy/garbage jsonb becomes "[object
    // Object]" or "7" in an agent-facing brief.
    expect(scopeFieldsForBrief({ in_scope: [7, { a: 1 }, 'real item'] })).toEqual({
      in_scope: ['real item'],
    });
    expect(scopeFieldsForBrief({ in_scope: 'not an array' })).toEqual({});
  });
});

// Module-level, not inside describe(): a describe callback is synchronous, so
// an `await` in there is a syntax error. Same read the sibling
// project-brief-delivery.test.ts does.
const SOURCE = await Bun.file(
  new URL('../../../src/routes/projects.ts', import.meta.url),
).text();

// The Planka card brief (the intake card's description) is GONE — fr writes no
// card on project create (George 2026-10-12) — so the pull brief is the ONE
// brief left.
describe('the brief actually spreads the renderer', () => {
  // KILL: remove `...scopeFieldsForBrief(...)` from the literal — the renderer
  // keeps passing its own tests while delivering to nobody, which is precisely
  // the "stored and never read" failure this file exists to stop.
  test('GET /api/projects/:id/brief spreads it', () => {
    const start = SOURCE.indexOf('export async function handleGetProjectBrief');
    expect(start).toBeGreaterThan(-1);
    const pullBrief = SOURCE.slice(
      start,
      SOURCE.indexOf('\n}', SOURCE.indexOf('return jsonResponse({', start)),
    );
    expect(pullBrief).toContain('...scopeFieldsForBrief(pd)');
  });
});
