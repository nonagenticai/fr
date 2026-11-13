/**
 * AG-UI n8n registration shape — verifies that every n8n.* action named in
 * `docs/superpowers/specs/completed/2026-04-25-n8n-observability-implementation.md`
 * §"Action catalog" plus the Wave-2 follow-up `n8n.trigger_workflow` (#29) is
 * registered with the catalog so the agent runtime + GET /api/agui/actions
 * can discover them.
 *
 * Mirrors `bridge-registration.test.ts` (same three tests: set membership,
 * kind+approval per-action, non-empty descriptions).
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerN8nActions } from '../../../../src/agui/actions/n8n';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

// Spec catalog (`2026-04-25-n8n-observability-implementation.md` §"Action
// catalog") — three reads. `n8n.trigger_workflow` is the Wave-2 follow-up
// write action (open follow-up #29 in the same spec, shipped 2026-04-27)
// and MUST exist in the registry so agent-driven workflow runs are gated by
// the project-owner approval policy and stamp the n8n_execution_mapping row.
const REQUIRED_N8N_ACTIONS: RequiredAction[] = [
  { name: 'n8n.list_executions', kind: 'read', policy: 'auto' },
  { name: 'n8n.get_execution', kind: 'read', policy: 'auto' },
  { name: 'n8n.list_workflows', kind: 'read', policy: 'auto' },
  { name: 'n8n.trigger_workflow', kind: 'write', policy: 'single-approver' },
];

beforeAll(() => {
  registerN8nActions();
});

describe('n8n.* AG-UI registration shape', () => {
  test('listActions() includes every spec-named n8n.* action', () => {
    const all = listActions();
    const n8nNames = all
      .filter((a) => a.name.startsWith('n8n.'))
      .map((a) => a.name)
      .sort();
    const expected = REQUIRED_N8N_ACTIONS.map((r) => r.name).sort();
    expect(n8nNames).toEqual(expected);
  });

  test.each(REQUIRED_N8N_ACTIONS)(
    '$name is registered with kind=$kind and approval.type=$policy',
    ({ name, kind, policy }) => {
      const action = listActions().find((a) => a.name === name);
      expect(action).toBeDefined();
      expect(action!.kind).toBe(kind);
      expect(action!.approval.type).toBe(policy);
    },
  );

  test('every n8n.* action has a non-empty description (catalog readability)', () => {
    const all = listActions().filter((a) => a.name.startsWith('n8n.'));
    for (const a of all) {
      expect(a.description.length).toBeGreaterThan(0);
    }
  });
});
