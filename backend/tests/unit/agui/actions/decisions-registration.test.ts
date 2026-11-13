/**
 * AG-UI decisions.* registration shape. Mirrors requirements-registration.test.ts.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerDecisionsActions } from '../../../../src/agui/actions/decisions';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_ACTIONS: RequiredAction[] = [
  { name: 'decisions.list', kind: 'read', policy: 'auto' },
  { name: 'decisions.get', kind: 'read', policy: 'auto' },
  { name: 'decisions.search', kind: 'read', policy: 'auto' },
  { name: 'decisions.list_versions', kind: 'read', policy: 'auto' },
];

beforeAll(() => {
  registerDecisionsActions();
});

describe('decisions.* AG-UI registration shape', () => {
  test('listActions() includes every decisions.* action', () => {
    const names = listActions()
      .filter((a) => a.name.startsWith('decisions.'))
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

  test('every decisions.* action has a non-empty description', () => {
    for (const a of listActions().filter((a) => a.name.startsWith('decisions.'))) {
      expect(a.description.length).toBeGreaterThan(0);
    }
  });
});
