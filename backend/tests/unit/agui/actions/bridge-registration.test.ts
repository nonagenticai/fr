/**
 * AG-UI bridge registration shape — verifies that every bridge.* action named
 * in `docs/superpowers/specs/completed/2026-04-24-analysis-to-kanban-bridge.md`
 * §"Agent-callable actions" is registered with the catalog so the agent
 * runtime + GET /api/agui/actions can discover them.
 *
 * The audit at ~/.claude/plans/from-fr-docs-superpowers-what-has-
 * logical-koala.md flagged this as missing because action registration was
 * gated on FR_FEATURE_BRIDGE in server.ts. The fix lifts the gate on action
 * registration (HTTP routes stay flagged); this test pins that contract.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerBridgeActions } from '../../../../src/agui/actions/bridge';

// Spec table §"Agent-callable actions". `bridge.commit_draft` is the
// commit-callback target invoked after consensus on submit_draft and is not
// in the spec's first-class table; it MUST exist in the registry so the
// completion handler can dispatch to it through the same registry as the
// other actions.
interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_BRIDGE_ACTIONS: RequiredAction[] = [
  { name: 'bridge.list_sources', kind: 'read', policy: 'auto' },
  { name: 'bridge.list_outputs', kind: 'read', policy: 'auto' },
  { name: 'bridge.draft_card_from_output', kind: 'write', policy: 'single-approver' },
  { name: 'bridge.draft_cards_from_outputs', kind: 'write', policy: 'single-approver' },
  { name: 'bridge.edit_draft', kind: 'write', policy: 'single-approver' },
  { name: 'bridge.submit_draft', kind: 'write', policy: 'single-approver' },
  { name: 'bridge.reject_draft', kind: 'write', policy: 'single-approver' },
  { name: 'bridge.commit_draft', kind: 'write', policy: 'single-approver' },
];

beforeAll(() => {
  registerBridgeActions();
});

describe('bridge.* AG-UI registration shape', () => {
  test('listActions() includes every spec-named bridge.* action', () => {
    const all = listActions();
    const bridgeNames = all
      .filter((a) => a.name.startsWith('bridge.'))
      .map((a) => a.name)
      .sort();
    const expected = REQUIRED_BRIDGE_ACTIONS.map((r) => r.name).sort();
    expect(bridgeNames).toEqual(expected);
  });

  test.each(REQUIRED_BRIDGE_ACTIONS)(
    '$name is registered with kind=$kind and approval.type=$policy',
    ({ name, kind, policy }) => {
      const action = listActions().find((a) => a.name === name);
      expect(action).toBeDefined();
      expect(action!.kind).toBe(kind);
      expect(action!.approval.type).toBe(policy);
    },
  );

  test('every bridge.* action has a non-empty description (catalog readability)', () => {
    const all = listActions().filter((a) => a.name.startsWith('bridge.'));
    for (const a of all) {
      expect(a.description.length).toBeGreaterThan(0);
    }
  });
});
