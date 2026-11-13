/**
 * AG-UI research.* registration shape. Mirrors principles-registration.test.ts.
 *
 * The discriminating contract for this catalog is that it is READ-ONLY: the
 * `research` integration also exports mutating calls (ingest push, score batch,
 * snowball start/cancel, session lifecycle, proof store, pipeline batch/trigger,
 * sandbox execute) and none of them may ever appear on this surface.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions, getAction } from '../../../../src/agui/registry';
import { registerResearchActions } from '../../../../src/agui/actions/research';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_ACTIONS: RequiredAction[] = [
  { name: 'research.search', kind: 'read', policy: 'auto' },
  { name: 'research.list_sources', kind: 'read', policy: 'auto' },
  { name: 'research.get_paper', kind: 'read', policy: 'auto' },
  { name: 'research.get_paper_related', kind: 'read', policy: 'auto' },
  { name: 'research.get_session', kind: 'read', policy: 'auto' },
  { name: 'research.session_insights', kind: 'read', policy: 'auto' },
  { name: 'research.score_report', kind: 'read', policy: 'auto' },
  { name: 'research.semantic_search', kind: 'read', policy: 'auto' },
  { name: 'research.snowball_status', kind: 'read', policy: 'auto' },
  { name: 'research.explain_job_status', kind: 'read', policy: 'auto' },
  { name: 'research.get_proofs', kind: 'read', policy: 'auto' },
  { name: 'research.pipeline_status', kind: 'read', policy: 'auto' },
  { name: 'research.pipeline_history', kind: 'read', policy: 'auto' },
];

/**
 * Mutating upstream calls that must NOT be reachable through the AG-UI
 * catalog, under any plausible naming. Guards against a later "just add the
 * rest of the module" edit.
 */
const FORBIDDEN_SUBSTRINGS = [
  'ingest',
  'push',
  'score_batch',
  'score_paper',
  'sandbox',
  'trigger',
  'batch',
  'create',
  'update',
  'delete',
  'pause',
  'resume',
  'cancel',
  'store',
  'start',
  'export',
];

beforeAll(() => {
  registerResearchActions();
});

describe('research.* AG-UI registration shape', () => {
  test('listActions() includes exactly the research.* catalog', () => {
    const names = listActions()
      .filter((a) => a.name.startsWith('research.'))
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(REQUIRED_ACTIONS.map((r) => r.name).sort());
  });

  test.each(REQUIRED_ACTIONS)(
    '$name is registered with kind=$kind and approval.type=$policy',
    ({ name, kind, policy }) => {
      const action = getAction(name);
      expect(action).toBeDefined();
      expect(action!.kind).toBe(kind);
      expect(action!.approval.type).toBe(policy);
    },
  );

  test('every research.* action is cronSafe with a non-empty description', () => {
    for (const a of listActions().filter((a) => a.name.startsWith('research.'))) {
      expect(a.cronSafe).toBe(true);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  test('no research.* action is kind=write', () => {
    const writes = listActions()
      .filter((a) => a.name.startsWith('research.'))
      .filter((a) => a.kind !== 'read')
      .map((a) => a.name);
    expect(writes).toEqual([]);
  });

  test('no mutating upstream call leaked into the catalog', () => {
    const leaked = listActions()
      .filter((a) => a.name.startsWith('research.'))
      .map((a) => a.name)
      .filter((n) => FORBIDDEN_SUBSTRINGS.some((bad) => n.slice('research.'.length).includes(bad)));
    expect(leaked).toEqual([]);
  });

  test('research.search cannot be steered into the session-persisting variant', () => {
    const action = getAction('research.search');
    expect(action).toBeDefined();
    const schema = action!.input as { parse: (v: unknown) => unknown };
    // Ephemeral query parses.
    expect(() => schema.parse({ query: 'graph neural networks' })).not.toThrow();
    // `session_id` is what makes the upstream POST persist results — it must be
    // rejected outright, not silently stripped.
    expect(() =>
      schema.parse({ query: 'graph neural networks', session_id: 'sess-1' }),
    ).toThrow();
  });

  test('idempotency keys are derived from input, not random', async () => {
    const action = getAction('research.get_paper');
    expect(action).toBeDefined();
    const a = await action!.idempotencyKey({ paper_id: 'p-1' });
    const b = await action!.idempotencyKey({ paper_id: 'p-1' });
    const c = await action!.idempotencyKey({ paper_id: 'p-2' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeGreaterThan(0);
  });

  test('re-registration is idempotent (ActionAlreadyRegisteredError swallowed)', () => {
    const before = listActions().filter((a) => a.name.startsWith('research.')).length;
    expect(() => registerResearchActions()).not.toThrow();
    expect(() => registerResearchActions()).not.toThrow();
    const after = listActions().filter((a) => a.name.startsWith('research.')).length;
    expect(after).toBe(before);
    expect(after).toBe(REQUIRED_ACTIONS.length);
  });
});
