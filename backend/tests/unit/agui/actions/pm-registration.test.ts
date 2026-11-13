/**
 * AG-UI pm.* registration shape. Mirrors principles-registration.test.ts.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerPmActions } from '../../../../src/agui/actions/pm';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_ACTIONS: RequiredAction[] = [
  { name: 'pm.list_programmes', kind: 'read', policy: 'auto' },
  { name: 'pm.get_programme', kind: 'read', policy: 'auto' },
  { name: 'pm.list_projects', kind: 'read', policy: 'auto' },
  { name: 'pm.get_project', kind: 'read', policy: 'auto' },
  { name: 'pm.list_risks', kind: 'read', policy: 'auto' },
  { name: 'pm.get_risk', kind: 'read', policy: 'auto' },
];

function pmActions() {
  return listActions().filter((a) => a.name.startsWith('pm.'));
}

beforeAll(() => {
  registerPmActions();
});

describe('pm.* AG-UI registration shape', () => {
  test('listActions() includes exactly the pm.* catalog', () => {
    const names = pmActions()
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

  test('every pm.* action is cron-safe and public-readable', () => {
    for (const a of pmActions()) {
      expect(a.cronSafe).toBe(true);
      expect(a.rbac).toEqual({ type: 'public' });
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  test('no pm.* action is a write action', () => {
    expect(pmActions().filter((a) => a.kind === 'write')).toEqual([]);
  });

  test('idempotency keys are derived from input, not random', async () => {
    const get = listActions().find((a) => a.name === 'pm.get_project');
    expect(get).toBeDefined();
    const k1 = await get!.idempotencyKey({ eid: 'proj-1' });
    const k2 = await get!.idempotencyKey({ eid: 'proj-1' });
    const k3 = await get!.idempotencyKey({ eid: 'proj-2' });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toContain('proj-1');

    const list = listActions().find((a) => a.name === 'pm.list_risks');
    expect(list).toBeDefined();
    const l1 = await list!.idempotencyKey({ project_id: 'p1', status: 'open' });
    const l2 = await list!.idempotencyKey({ project_id: 'p1', status: 'closed' });
    expect(l1.length).toBeGreaterThan(0);
    expect(l1).not.toBe(l2);
  });

  test('every pm.* idempotency key is prefixed with its own action name', async () => {
    for (const a of pmActions()) {
      const key = await a.idempotencyKey({ eid: 'x' });
      expect(key.startsWith(`${a.name}:`)).toBe(true);
    }
  });

  test('re-registering is idempotent — no throw, no duplicates', () => {
    const before = pmActions().length;
    expect(() => registerPmActions()).not.toThrow();
    registerPmActions();
    const after = pmActions().map((a) => a.name);
    expect(after.length).toBe(before);
    expect(new Set(after).size).toBe(REQUIRED_ACTIONS.length);
  });
});
