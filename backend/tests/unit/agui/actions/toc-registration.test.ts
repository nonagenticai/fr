/**
 * AG-UI toc.* registration shape — verifies every TOC action is registered
 * with the catalog (so the agent runtime + GET /api/agui/actions discover
 * them) and that the read/write split + approval + RBAC invariants hold:
 *   - reads  → kind:'read',  approval:'auto'
 *   - writes → kind:'write', approval:'single-approver', rbac project-role editor
 *
 * Mirrors `n8n-registration.test.ts`. The fact that the write actions register
 * at all proves they carry a non-auto approval — `registerAction` throws
 * `InvalidActionApprovalError` for a write with `approval:'auto'`.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

import { listActions } from '../../../../src/agui/registry';
import { registerTocActions } from '../../../../src/agui/actions/toc';

interface RequiredAction {
  name: string;
  kind: 'read' | 'write';
  policy: 'auto' | 'single-approver';
}

const REQUIRED_TOC_ACTIONS: RequiredAction[] = [
  { name: 'toc.list_trees', kind: 'read', policy: 'auto' },
  { name: 'toc.get_tree', kind: 'read', policy: 'auto' },
  { name: 'toc.get_graph', kind: 'read', policy: 'auto' },
  { name: 'toc.get_quality', kind: 'read', policy: 'auto' },
  { name: 'toc.get_config', kind: 'read', policy: 'auto' },
  { name: 'toc.build_io_map', kind: 'write', policy: 'single-approver' },
  { name: 'toc.evaporate_conflict', kind: 'write', policy: 'single-approver' },
  { name: 'toc.evaluate_lenses', kind: 'write', policy: 'single-approver' },
];

beforeAll(() => {
  registerTocActions();
});

describe('toc.* AG-UI registration shape', () => {
  test('listActions() includes every TOC action exactly once', () => {
    const names = listActions()
      .filter((a) => a.name.startsWith('toc.'))
      .map((a) => a.name)
      .sort();
    expect(names).toEqual(REQUIRED_TOC_ACTIONS.map((r) => r.name).sort());
  });

  test.each(REQUIRED_TOC_ACTIONS)(
    '$name is registered with kind=$kind and approval.type=$policy',
    ({ name, kind, policy }) => {
      const action = listActions().find((a) => a.name === name);
      expect(action).toBeDefined();
      expect(action!.kind).toBe(kind);
      expect(action!.approval.type).toBe(policy);
    },
  );

  test('every write action requires the project-role editor RBAC rule', () => {
    const writes = listActions().filter(
      (a) => a.name.startsWith('toc.') && a.kind === 'write',
    );
    // `expect(writes.length).toBe(3)` was deleted here on 2026-10-31: it was an
    // absolute count that had to be bumped by hand on every added write route.
    // The real guards are the `toEqual(REQUIRED_TOC_ACTIONS…)` set equality above
    // (which already names all three writes, so this loop cannot run empty) and
    // the per-action assertion below.
    for (const a of writes) {
      expect(a.rbac).toEqual({ type: 'project-role', role: 'editor' });
    }
  });

  test('every toc.* action has a non-empty description (catalog readability)', () => {
    for (const a of listActions().filter((a) => a.name.startsWith('toc.'))) {
      expect(a.description.length).toBeGreaterThan(0);
    }
  });
});

// The build actions trigger the AA builder subroutines by webhook PATH. The
// defaults must be the builders' authenticated production webhooks
// (`aa-subroutine-build-*`), never n8n's unauthenticated `test-*` hooks, which
// are being removed from n8n. The ncn side must expose exactly these paths.
describe('toc build webhook defaults', () => {
  test('defaults are the aa-subroutine-build-* production paths', async () => {
    // Precondition: an env override would make this assertion vacuous.
    expect(process.env.AA_BUILD_IO_MAP_WEBHOOK).toBeUndefined();
    expect(process.env.AA_BUILD_EVAPORATING_CLOUD_WEBHOOK).toBeUndefined();
    const { config } = await import('../../../../src/config');
    expect(config.services.n8n.aaBuildIoMapWebhook).toBe('aa-subroutine-build-io-map');
    expect(config.services.n8n.aaBuildEvaporatingCloudWebhook).toBe(
      'aa-subroutine-build-evaporating-cloud',
    );
  });

  test('no default points at an n8n test-* webhook', async () => {
    const { config } = await import('../../../../src/config');
    for (const p of [
      config.services.n8n.aaBuildIoMapWebhook,
      config.services.n8n.aaBuildEvaporatingCloudWebhook,
    ]) {
      expect(p.startsWith('test-')).toBe(false);
    }
  });
});
