/**
 * AG-UI workers.* registration shape.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerWorkersActions } from '../../../../src/agui/actions/workers';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_ACTIONS: RequiredAction[] = [
  { name: 'workers.list', kind: 'read', policy: 'auto' },
  { name: 'workers.get', kind: 'read', policy: 'auto' },
  { name: 'workers.list_providers', kind: 'read', policy: 'auto' },
  { name: 'workers.list_provider_models', kind: 'read', policy: 'auto' },
  { name: 'workers.list_activity', kind: 'read', policy: 'auto' },
  { name: 'workers.list_graph_sessions', kind: 'read', policy: 'auto' },
];

beforeAll(() => {
  registerWorkersActions();
});

describe('workers.* AG-UI registration shape', () => {
  test('listActions() includes every workers.* action', () => {
    const names = listActions()
      .filter((a) => a.name.startsWith('workers.'))
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(REQUIRED_ACTIONS.map((r) => r.name).sort());
  });

  test.each(REQUIRED_ACTIONS)(
    '$name is registered with kind=$kind and approval.type=$policy',
    ({ name, kind, policy }) => {
      const action = listActions().find((a) => a.name === name);
      expect(action).toBeDefined();
      expect(action!.kind).toBe(kind);
      expect(action!.approval.type).toBe(policy);
    },
  );

  test('every workers.* action has a non-empty description', () => {
    for (const a of listActions().filter((a) => a.name.startsWith('workers.'))) {
      expect(a.description.length).toBeGreaterThan(0);
    }
  });
});
