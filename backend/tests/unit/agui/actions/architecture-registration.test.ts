/**
 * AG-UI architecture.* registration shape. Mirrors principles-registration.test.ts.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerArchitectureActions } from '../../../../src/agui/actions/architecture';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_ACTIONS: RequiredAction[] = [
  { name: 'architecture.list_elements', kind: 'read', policy: 'auto' },
  { name: 'architecture.get_element', kind: 'read', policy: 'auto' },
  { name: 'architecture.list_relationships', kind: 'read', policy: 'auto' },
  { name: 'architecture.get_relationship', kind: 'read', policy: 'auto' },
  { name: 'architecture.get_entity_graph', kind: 'read', policy: 'auto' },
  { name: 'architecture.list_views', kind: 'read', policy: 'auto' },
  { name: 'architecture.get_view', kind: 'read', policy: 'auto' },
  { name: 'architecture.list_standards', kind: 'read', policy: 'auto' },
  { name: 'architecture.get_standard', kind: 'read', policy: 'auto' },
];

const architectureActions = () =>
  listActions().filter((a) => a.name.startsWith('architecture.'));

beforeAll(() => {
  registerArchitectureActions();
});

describe('architecture.* AG-UI registration shape', () => {
  test('listActions() includes every architecture.* action this registrar owns', () => {
    // Other modules (architecture-uml / -archimate / -modeling) also register
    // under `architecture.`, so the registry holds a superset in a shared process.
    const names = architectureActions().map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(REQUIRED_ACTIONS.map((r) => r.name)));
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

  test('every architecture.* action has a non-empty description', () => {
    for (const a of architectureActions()) {
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  test('every architecture.* action this registrar owns is cron-safe and public rbac', () => {
    const owned = new Set(REQUIRED_ACTIONS.map((r) => r.name));
    for (const a of architectureActions().filter((x) => owned.has(x.name))) {
      expect(a.cronSafe).toBe(true);
      expect(a.rbac).toEqual({ type: 'public' });
    }
  });

  test('re-registering is idempotent — no throw, no duplicates', () => {
    const before = architectureActions().length;
    expect(() => registerArchitectureActions()).not.toThrow();
    expect(architectureActions().length).toBe(before);
  });
});
