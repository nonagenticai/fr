// What the agent replays back to the model for a tool result.
//
// The defect this pins was live on 2026-08-07: `renderTranscript` did
// `JSON.stringify(output).slice(0, 1000)`. A blind slice cuts mid-object, so
// any result larger than the cap reached the model as a CORRUPT fragment. Asked
// "list the principles in the library", the agent answered:
//
//   2. **Idempotency-...** (entry returned, but the full title/statement was
//      truncated in the tool response)
//   The returned list may contain additional entries beyond what was shown.
//
// i.e. the model correctly refused to trust a payload we had mangled. The user
// saw a hedged, partial answer to the product's flagship question.
//
// Two invariants, both asserted below:
//   1. The model NEVER receives invalid JSON.
//   2. When data is dropped we say so in-band WITH COUNTS, so the model can say
//      "showing 5 of 23" instead of guessing.

import { describe, expect, test } from 'bun:test';

import { renderToolOutput } from '../../../src/agent/loop';

/** A principles.list-shaped row, verbose like the real one. */
function row(i: number) {
  return {
    id: `0195f48b-d000-7000-8000-0000000${String(i).padStart(5, '0')}`,
    created_at: '2026-07-27T10:40:17.342322Z',
    updated_at: '2026-07-27T10:40:17.650958Z',
    origin_kind: 'tenant',
    origin_project_id: null,
    origin_workflow_run_id: null,
    created_by_user_id: '',
    title: `Principle number ${i}`,
    statement: 'New features or bug fixes must be accompanied by an expanded test suite.',
    version: '1.0.0',
    status: 'DRAFT',
  };
}

describe('renderToolOutput', () => {
  test('small payloads pass through byte-identical', () => {
    const out = { items: [{ a: 1 }], total: 1 };
    expect(renderToolOutput(out)).toBe(JSON.stringify(out));
  });

  test('a large list stays VALID JSON — the whole point', () => {
    const rendered = renderToolOutput({ items: Array.from({ length: 60 }, (_, i) => row(i)) });
    // The old blind slice failed exactly here.
    expect(() => JSON.parse(rendered)).not.toThrow();
  });

  test('truncation keeps WHOLE items — never a severed one', () => {
    const rendered = renderToolOutput({ items: Array.from({ length: 60 }, (_, i) => row(i)) });
    const parsed = JSON.parse(rendered) as { items: Array<Record<string, unknown>> };
    expect(parsed.items.length).toBeGreaterThan(0);
    // Every surviving row is complete, not a fragment.
    for (const it of parsed.items) {
      expect(typeof it.title).toBe('string');
      expect(typeof it.statement).toBe('string');
      expect(String(it.title)).toMatch(/^Principle number \d+$/);
    }
  });

  test('reports how much was dropped, so the model need not guess', () => {
    const rendered = renderToolOutput({ items: Array.from({ length: 60 }, (_, i) => row(i)) });
    const parsed = JSON.parse(rendered) as {
      items: unknown[];
      _truncated: { shown: number; total: number };
    };
    expect(parsed._truncated.total).toBe(60);
    expect(parsed._truncated.shown).toBe(parsed.items.length);
    expect(parsed._truncated.shown).toBeLessThan(60);
  });

  test('sibling fields survive truncation (total//page context is not lost)', () => {
    const rendered = renderToolOutput({
      items: Array.from({ length: 60 }, (_, i) => row(i)),
      total: 60,
      page: 1,
    });
    const parsed = JSON.parse(rendered) as { total: number; page: number };
    expect(parsed.total).toBe(60);
    expect(parsed.page).toBe(1);
  });

  test('a bare array payload is handled too', () => {
    const rendered = renderToolOutput(Array.from({ length: 60 }, (_, i) => row(i)));
    const parsed = JSON.parse(rendered) as { items: unknown[]; _truncated: { total: number } };
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed._truncated.total).toBe(60);
  });

  test('a huge NON-list payload degrades to a valid string preview, not a severed object', () => {
    const rendered = renderToolOutput({ blob: 'x'.repeat(20_000) });
    expect(() => JSON.parse(rendered)).not.toThrow();
    const parsed = JSON.parse(rendered) as { preview: string; _truncated: { originalLength: number } };
    expect(typeof parsed.preview).toBe('string');
    expect(parsed._truncated.originalLength).toBeGreaterThan(20_000);
  });

  test('null / undefined output never throws', () => {
    expect(() => JSON.parse(renderToolOutput(null))).not.toThrow();
    expect(renderToolOutput(undefined)).toBe('null');
  });
});

// ── budget sizing + lean rows ────────────────────────────────────────────────
//
// Measured live 2026-08-07 against the real principles catalog (100 rows,
// ~1009 chars each): the flagship question "list the principles in the library"
// surfaced 2 of 100. The cap had been sized against the wrong constraint — WM's
// 10KB/depth-10 limit is on `context`, but the transcript goes in the MESSAGE
// body — so it bought nothing and cost answers.
describe('renderToolOutput — how much actually survives', () => {
  test('a realistic 100-row catalog surfaces far more than the old 2 rows', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      ...row(i),
      // the real rows carry ~30 fields, most of them empty
      origin_project_id: null, origin_workflow_run_id: null, supersedes: null,
      superseded_by: null, version_notes: null, approved_by: null, approved_at: null,
      published_at: null, rationale: null, implications: null, tags: [],
      quality_issues: [], quality_suggestions: [], last_evaluated_at: null,
      last_evaluated_by_agent: null, tenant_id: '0195f48b-d000-7000-8000-000000000099',
    }));
    const parsed = JSON.parse(renderToolOutput({ items })) as {
      items: unknown[]; _truncated: { shown: number; total: number };
    };
    expect(parsed._truncated.total).toBe(100);
    // The regression guard: anything near the old 2 means the budget or the
    // lean-out silently regressed.
    expect(parsed._truncated.shown).toBeGreaterThanOrEqual(10);
  });

  test('leaning drops empty fields but never a populated one', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      ...row(i), rationale: null, tags: [], notes: '',
    }));
    const parsed = JSON.parse(renderToolOutput({ items })) as {
      items: Array<Record<string, unknown>>;
    };
    for (const it of parsed.items) {
      expect('rationale' in it).toBe(false);
      expect('tags' in it).toBe(false);
      expect('notes' in it).toBe(false);
      // populated fields are untouched
      expect(typeof it.title).toBe('string');
      expect(typeof it.statement).toBe('string');
      expect(it.status).toBe('DRAFT');
    }
  });

  test('a payload that FITS is byte-identical — fidelity is never traded away', () => {
    const small = { items: [{ a: 1, b: null, c: [] }], total: 1 };
    expect(renderToolOutput(small)).toBe(JSON.stringify(small));
  });
});
