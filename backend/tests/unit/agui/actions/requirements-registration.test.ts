/**
 * AG-UI requirements.* registration shape — closes the E-14 coverage gap.
 * Mirrors `n8n-registration.test.ts` (same three tests: set membership,
 * kind+approval per-action, non-empty descriptions).
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerRequirementsActions } from '../../../../src/agui/actions/requirements';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_ACTIONS: RequiredAction[] = [
  { name: 'requirements.list', kind: 'read', policy: 'auto' },
  { name: 'requirements.get', kind: 'read', policy: 'auto' },
  { name: 'requirements.search', kind: 'read', policy: 'auto' },
  { name: 'requirements.list_versions', kind: 'read', policy: 'auto' },
];

beforeAll(() => {
  registerRequirementsActions();
});

describe('requirements.* AG-UI registration shape', () => {
  test('listActions() includes every requirements.* action', () => {
    const names = listActions()
      .filter((a) => a.name.startsWith('requirements.'))
      .map((a) => a.name)
      .sort();
    const expected = REQUIRED_ACTIONS.map((r) => r.name).sort();
    expect(names).toEqual(expected);
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

  test('every requirements.* action has a non-empty description', () => {
    const all = listActions().filter((a) => a.name.startsWith('requirements.'));
    for (const a of all) {
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  test('registerRequirementsActions() is idempotent on re-call', () => {
    registerRequirementsActions();
    const names = listActions()
      .filter((a) => a.name.startsWith('requirements.'))
      .map((a) => a.name);
    expect(names.length).toBe(REQUIRED_ACTIONS.length);
  });
});
